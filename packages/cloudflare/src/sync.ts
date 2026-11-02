import
{
	applyApiBatch,
	beginApiImport,
	finishApiImport,
	importInternalMetadata,
	newSystemTimestamp,
	readWorkflowyEpoch,
	runUnitOfWork,
	seedAccount,
	unitOfWorkSignal,
} from "@outlinedb/shared/cache";
import type {ApiImportState, ImportApiResult, StoredAccount} from "@outlinedb/shared/cache";
import type {TreeSnapshot} from "@outlinedb/shared/api";
import type {AppDatabase} from "@outlinedb/shared/db";
import {TreeResyncRequired} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {JobAlarm} from "./alarm-schedule";
import {nodeBatches} from "./export-stream";

const BATCH_SIZE = 2000;
const DEFAULT_INTERVAL_MINUTES = 30;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const SEED_HINT = "On the Worker, POST /api/admin/seed instead.";
/**
 * An alarm run stops applying batches, and leaves the finish to a fresh run, once this much time is spent. It stays
 * well inside the transaction timeout and keeps each alarm short on the Worker.
 */
const RUN_BUDGET_MS = 30_000;

/**
 * The sync job's own tables, temporal like every other table: a run's versions (one per alarm run), the ids the run in
 * progress has seen (scratch, deleted when the run ends) and the seed requests (closed when a run consumes one).
 */
const SYNC_TABLES = `
CREATE TABLE IF NOT EXISTS sync_runs (
	run_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	export_key TEXT NOT NULL,
	applied INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	total_nodes INTEGER NOT NULL,
	nodes_added INTEGER NOT NULL,
	nodes_updated INTEGER NOT NULL,
	nodes_unchanged INTEGER NOT NULL,
	nodes_deleted INTEGER NOT NULL,
	nodes_phased_out INTEGER NOT NULL,
	content_updated INTEGER NOT NULL,
	metadata_updated INTEGER NOT NULL,
	priority_updated INTEGER NOT NULL,
	status TEXT,
	message TEXT,
	result_at INTEGER,
	duration_ms INTEGER,
	internal_sync_error TEXT,
	snapshot_at INTEGER,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (run_id, system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_system_to_idx ON sync_runs (run_id, system_to);
CREATE INDEX IF NOT EXISTS sync_runs_closed_at_idx ON sync_runs (system_to) WHERE system_to < '${FAR_FUTURE_DATE}';
CREATE TABLE IF NOT EXISTS sync_seen (
	run_id TEXT NOT NULL,
	id TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (run_id, id, system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_seen_system_to_idx ON sync_seen (run_id, id, system_to);
CREATE INDEX IF NOT EXISTS sync_seen_closed_at_idx ON sync_seen (system_to) WHERE system_to < '${FAR_FUTURE_DATE}';
CREATE TABLE IF NOT EXISTS sync_seed_requests (
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_seed_requests_system_to_idx ON sync_seed_requests (system_to);
CREATE INDEX IF NOT EXISTS sync_seed_requests_closed_at_idx ON sync_seed_requests (system_to)
	WHERE system_to < '${FAR_FUTURE_DATE}';
`;

/** Bindings the sync job reads; all but the bucket are optional. */
export interface SyncEnv
{
	SNAPSHOTS: R2Bucket;
	WORKFLOWY_API_KEY?: string;
	WORKFLOWY_API_URL?: string;
	/** Minutes between runs once one has finished (default 30). */
	SYNC_INTERVAL_MINUTES?: string;
	/** CPU budget knob: batches applied per alarm before yielding (default: all). */
	SYNC_BATCHES_PER_TICK?: string;
	/** Delay before the next alarm when a run yields mid-import (default 0). */
	SYNC_TICK_DELAY_MS?: string;
}

export interface SyncDeps
{
	storage: DurableObjectStorage;
	db: AppDatabase;
	env: SyncEnv;
	/**
	 * Reads the whole internal tree (about 54 MB live) when internal auth exists; undefined when it does not.
	 * Only a run started by {@link SyncJob.seed} calls it. `signal` aborts when the run's transaction timeout runs out.
	 */
	readTreeSnapshot?: (signal: AbortSignal) => Promise<TreeSnapshot> | undefined;
	/**
	 * Brings the edge tables up to the tree's latest transaction with one pure poll from the stored transaction id,
	 * when internal auth exists; undefined when it does not. Every run that is not a seed calls it.
	 */
	catchUp?: () => Promise<void> | undefined;
	/**
	 * Reads the account (its join date is the Workflowy epoch) when internal auth exists; undefined when it does not.
	 * `signal` aborts when the run's transaction timeout runs out.
	 */
	readAccount?: (signal: AbortSignal) => Promise<StoredAccount> | undefined;
	/** Where the next run is scheduled; the object's own alarm unless the alarm is shared with other jobs. */
	alarm?: JobAlarm;
	now?: () => number;
}

type Phase = "idle" | "fetching" | "importing";

interface Job
{
	runId: string;
	phase: Phase;
	exportKey: string;
	/** Nodes of the export already applied; the stream resumes after them. */
	applied: number;
	totals: Pick<
		ApiImportState,
		"totalNodes" | "nodesAdded" | "nodesUpdated" | "nodesUnchanged" | "contentUpdated" | "metadataUpdated"
	>;
	startedAt: number;
	/**
	 * When the export was requested, in epoch ms on the system-time clock. The export cannot speak for rows written
	 * after it, so the import leaves those alone; undefined until the fetch starts.
	 */
	snapshotAt?: number;
	/** The run's result so far: a rate limit while it still fetches, or how it finished. */
	result: SyncResult | null;
}

const NO_TOTALS: Job["totals"] =
{
	totalNodes: 0,
	nodesAdded: 0,
	nodesUpdated: 0,
	nodesUnchanged: 0,
	contentUpdated: 0,
	metadataUpdated: 0,
};

export type SyncResult =
	| (
	  {
			status: "ok";
			exportKey: string;
			finishedAt: number;
			durationMs: number;
	  } & Omit<ImportApiResult, "importTimestamp"> &
			{
				/**
				 * Set when the internal half failed (a seed's get_tree_data read, or the transaction-log catch-up):
				 * the public import still completed, the edge tables did not.
				 */
				internalSyncError?: string;
			})
	|
	  {
			status: "rate_limited" | "error";
			message: string;
			at: number;
	  };

export interface SyncStatus
{
	phase: Phase;
	applied: number;
	nextAlarmAt: number | null;
	lastResult: SyncResult | null;
}

/** The streaming import, driven by Durable Object alarms with all progress in the object's own SQLite. */
export class SyncJob
{
	/** The system time of the alarm run in progress: every sync-table version it writes takes this one value. */
	private systemTime = newSystemTimestamp();

	constructor(private readonly deps: SyncDeps)
	{
		const {sql} = deps.storage;
		// The pre-temporal key/value table and seen set go; a run they held restarts from scratch.
		const seenSql = sql
			.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_seen'")
			.toArray()[0]?.sql;
		if (typeof seenSql === "string" && !seenSql.includes("system_from"))
		{
			sql.exec("DROP TABLE sync_seen");
		}
		sql.exec(`DROP TABLE IF EXISTS sync_state; ${SYNC_TABLES}`);
		const runColumns = sql.exec("SELECT name FROM pragma_table_info('sync_runs')").toArray();
		if (!runColumns.some((row) => row.name === "snapshot_at"))
		{
			sql.exec("ALTER TABLE sync_runs ADD COLUMN snapshot_at INTEGER");
		}
	}

	private get alarm(): JobAlarm
	{
		return this.deps.alarm ?? this.deps.storage;
	}

	private get sql(): SqlStorage
	{
		return this.deps.storage.sql;
	}

	private now(): number
	{
		return (this.deps.now ?? Date.now)();
	}

	/** The live version of the run in progress, or null when idle. */
	private readJob(): Job | null
	{
		const row = this.sql
			.exec("SELECT * FROM sync_runs WHERE system_to = ? AND phase IN ('fetching', 'importing')", FAR_FUTURE_DATE)
			.toArray()[0];
		return row === undefined ? null : jobFromRow(row);
	}

	/** The newest run's result: a live rate limit, or how the last run finished. */
	private readLastResult(): SyncResult | null
	{
		const row = this.sql
			.exec(
				"SELECT * FROM sync_runs WHERE system_to = ? AND status IS NOT NULL ORDER BY system_from DESC LIMIT 1",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		return row === undefined ? null : jobFromRow(row).result;
	}

	/**
	 * Write the run's version for this alarm run: phase out the version an earlier alarm run wrote, or replace the
	 * one this alarm run already wrote, so each alarm run leaves one version.
	 */
	private writeJob(job: Job): void
	{
		this.sql.exec(
			"UPDATE sync_runs SET system_to = ? WHERE run_id = ? AND system_to = ? AND system_from <> ?",
			this.systemTime,
			job.runId,
			FAR_FUTURE_DATE,
			this.systemTime,
		);
		const {result} = job;
		const ok = result?.status === "ok" ? result : undefined;
		this.sql.exec(
			"INSERT OR REPLACE INTO sync_runs (run_id, phase, export_key, applied, started_at, total_nodes, nodes_added, " +
				"nodes_updated, nodes_unchanged, nodes_deleted, nodes_phased_out, content_updated, metadata_updated, " +
				"priority_updated, status, message, result_at, duration_ms, internal_sync_error, snapshot_at, system_from, system_to) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			job.runId,
			job.phase,
			job.exportKey,
			job.applied,
			job.startedAt,
			ok?.totalNodes ?? job.totals.totalNodes,
			ok?.nodesAdded ?? job.totals.nodesAdded,
			ok?.nodesUpdated ?? job.totals.nodesUpdated,
			ok?.nodesUnchanged ?? job.totals.nodesUnchanged,
			ok?.nodesDeleted ?? 0,
			ok?.nodesPhasedOut ?? 0,
			ok?.contentUpdated ?? job.totals.contentUpdated,
			ok?.metadataUpdated ?? job.totals.metadataUpdated,
			ok?.priorityUpdated ?? 0,
			result?.status ?? null,
			result === null || result.status === "ok" ? null : result.message,
			result === null ? null : result.status === "ok" ? result.finishedAt : result.at,
			ok?.durationMs ?? null,
			ok?.internalSyncError ?? null,
			job.snapshotAt ?? null,
			this.systemTime,
			FAR_FUTURE_DATE,
		);
	}

	/**
	 * Close the live rows `where` selects at this alarm run's system time. A row stamped at or after it (written by this
	 * alarm run, or by a request that landed while the run awaited I/O) was never live before that time, so it goes
	 * instead of closing with zero width or an inverted interval.
	 */
	private closeLive(table: "sync_seed_requests", where: string, ...bindings: string[]): void
	{
		this.sql.exec(`DELETE FROM ${table} WHERE ${where} AND system_from >= ?`, ...bindings, this.systemTime);
		this.sql.exec(
			`UPDATE ${table} SET system_to = ? WHERE ${where} AND system_to = ?`,
			this.systemTime,
			...bindings,
			FAR_FUTURE_DATE,
		);
	}

	private seedRequested(): boolean
	{
		return (
			this.sql.exec("SELECT 1 FROM sync_seed_requests WHERE system_to = ?", FAR_FUTURE_DATE).toArray().length > 0
		);
	}

	/** Make a run start (or continue) as soon as possible. */
	async syncNow(): Promise<SyncStatus>
	{
		await this.alarm.setAlarm(this.now());
		return this.status();
	}

	/**
	 * Make the next run (or the one in progress) finish with a whole-tree read that reseeds the edge tables, the
	 * transaction id and the expanded keys. The only path that reads get_tree_data; never triggered automatically.
	 */
	async seed(): Promise<SyncStatus>
	{
		if (!this.seedRequested())
		{
			this.sql.exec(
				"INSERT INTO sync_seed_requests (system_from, system_to) VALUES (?, ?)",
				newSystemTimestamp(),
				FAR_FUTURE_DATE,
			);
		}
		return this.syncNow();
	}

	async status(): Promise<SyncStatus>
	{
		const job = this.readJob();
		return {
			phase: job?.phase ?? "idle",
			applied: job?.applied ?? 0,
			nextAlarmAt: await this.alarm.getAlarm(),
			lastResult: this.readLastResult(),
		};
	}

	/** One alarm: start a run when idle, otherwise continue the one in progress. */
	async tick(): Promise<void>
	{
		this.systemTime = newSystemTimestamp();
		let job = this.readJob();
		if (job === null)
		{
			job =
			{
				runId: crypto.randomUUID(),
				phase: "fetching",
				exportKey: "",
				applied: 0,
				totals: NO_TOTALS,
				startedAt: this.now(),
				result: null,
			};
			this.writeJob(job);
		}
		try
		{
			if (job.phase === "fetching")
			{
				const fetched = await this.fetchExport(job);
				if (fetched === undefined)
				{
					return;
				}
				job = fetched;
			}
			await this.importExport(job);
		}
		catch (error)
		{
			// The live version holds the progress the failed import committed.
			this.finishRun(
				this.readJob() ?? job,
				{
					status: "error",
					message: errorMessage(error),
					at: this.now(),
				},
			);
			await this.scheduleNextRun();
		}
	}

	/** Seed the account row once, when internal auth exists and none is live; a failure leaves it for the next run. */
	private async seedAccountRow(signal: AbortSignal): Promise<void>
	{
		if (readWorkflowyEpoch(this.deps.db) !== undefined)
		{
			return;
		}
		try
		{
			const stored = await this.deps.readAccount?.(signal);
			if (stored !== undefined)
			{
				runUnitOfWork(this.deps.db, (unitOfWork) =>
				{
					seedAccount(unitOfWork, stored);
				});
			}
		}
		catch
		{
			// The epoch only serves backup imports; the sync itself does not depend on it.
		}
	}

	private finishRun(job: Job, result: SyncResult): void
	{
		this.writeJob(
			{
				...job,
				phase: "idle",
				result,
			},
		);
		// Only the run in progress reads its seen ids, so they go with it, along with any left by an abandoned run.
		this.sql.exec("DELETE FROM sync_seen");
	}

	private async scheduleNextRun(): Promise<void>
	{
		const minutes = Number(this.deps.env.SYNC_INTERVAL_MINUTES);
		const interval = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES) * 60_000;
		await this.alarm.setAlarm(this.now() + interval);
	}

	/** GET the export and tee it into R2. Returns undefined when the run was rescheduled instead. */
	private async fetchExport(job: Job): Promise<Job | undefined>
	{
		const {env} = this.deps;
		if (!env.WORKFLOWY_API_KEY)
		{
			this.finishRun(
				job,
				{
					status: "error",
					message: "WORKFLOWY_API_KEY is not configured",
					at: this.now(),
				},
			);
			await this.scheduleNextRun();
			return undefined;
		}
		const base = (env.WORKFLOWY_API_URL === "" ? undefined : env.WORKFLOWY_API_URL) ?? "https://workflowy.com";
		// Read before the request goes out: the same clock as system time, so later writes compare after it.
		const snapshotAt = Date.now();
		const response = await fetch(
			`${base}/api/v1/nodes-export`,
			{
				headers:
				{
					Authorization: `Bearer ${env.WORKFLOWY_API_KEY}`,
				},
			},
		);
		if (response.status === 429)
		{
			const retryAfter = Number(response.headers.get("retry-after"));
			const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_BACKOFF_MS;
			await response.body?.cancel();
			// The job stays in "fetching", so the next alarm retries the same run.
			this.writeJob(
				{
					...job,
					result:
					{
						status: "rate_limited",
						message: "Workflowy answered 429",
						at: this.now(),
					},
				},
			);
			await this.alarm.setAlarm(this.now() + delay);
			return undefined;
		}
		if (!response.ok || response.body === null)
		{
			throw new Error(`nodes-export failed with ${response.status}`);
		}
		const exportKey = `exports/${new Date(this.now()).toISOString().replaceAll(":", "-")}.json`;
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > 0)
		{
			const fixed = new FixedLengthStream(length);
			const piping = response.body.pipeTo(fixed.writable);
			await Promise.all([env.SNAPSHOTS.put(exportKey, fixed.readable), piping]);
		}
		else
		{
			await env.SNAPSHOTS.put(exportKey, await response.arrayBuffer());
		}
		const next: Job =
		{
			...job,
			phase: "importing",
			exportKey,
			snapshotAt,
		};
		this.writeJob(next);
		return next;
	}

	/** This alarm run's import: a fresh system time, so the run is its own unit of work, resuming the run's totals. */
	private importState(job: Job): ApiImportState
	{
		const state = beginApiImport(
			this.deps.db,
			{
				snapshotTakenAt: job.snapshotAt === undefined ? undefined : new Date(job.snapshotAt),
			},
		);
		Object.assign(state, job.totals);
		const seen = this.sql.exec(
			"SELECT id FROM sync_seen WHERE run_id = ? AND system_to = ?",
			job.runId,
			FAR_FUTURE_DATE,
		);
		for (const row of seen.toArray())
		{
			if (typeof row.id === "string")
			{
				state.seenIds.add(row.id);
			}
		}
		return state;
	}

	private async importExport(job: Job): Promise<void>
	{
		const {env, storage} = this.deps;
		const object = await env.SNAPSHOTS.get(job.exportKey);
		if (object === null)
		{
			throw new Error(`export ${job.exportKey} is missing from R2`);
		}
		const state = this.importState(job);
		const perTick = Number(env.SYNC_BATCHES_PER_TICK);
		const limit = Number.isFinite(perTick) && perTick > 0 ? perTick : Infinity;
		let batches = 0;
		let yielded = false;
		const overBudget = () => Date.now() - state.start.startedAt >= RUN_BUDGET_MS;
		for await (const batch of nodeBatches(
			// oxlint-disable-next-line typescript/no-unsafe-argument -- the workers types declare R2ObjectBody.body as ReadableStream<any>
			object.body,
			{
				size: BATCH_SIZE,
				skip: job.applied,
			},
		))
		{
			if (batches >= limit || (batches > 0 && overBudget()))
			{
				yielded = true;
				break;
			}
			// One transaction, so the cursor never runs ahead of or behind the rows it counts.
			storage.transactionSync(() =>
			{
				applyApiBatch(state, batch);
				for (const node of batch)
				{
					if (state.seenIds.has(node.id))
					{
						this.sql.exec(
							"INSERT OR IGNORE INTO sync_seen (run_id, id, system_from, system_to) VALUES (?, ?, ?, ?)",
							job.runId,
							node.id,
							this.systemTime,
							FAR_FUTURE_DATE,
						);
					}
				}
				job =
				{
					...job,
					applied: job.applied + batch.length,
					totals:
					{
						totalNodes: state.totalNodes,
						nodesAdded: state.nodesAdded,
						nodesUpdated: state.nodesUpdated,
						nodesUnchanged: state.nodesUnchanged,
						contentUpdated: state.contentUpdated,
						metadataUpdated: state.metadataUpdated,
					},
				};
				this.writeJob(job);
			});
			batches++;
		}
		if (yielded || (batches > 0 && overBudget()))
		{
			const delay = Number(env.SYNC_TICK_DELAY_MS);
			await this.alarm.setAlarm(this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 0));
			return;
		}

		const seeding = this.seedRequested();
		let snapshot: TreeSnapshot | undefined;
		let internalSyncError: string | undefined;
		if (seeding)
		{
			this.closeLive("sync_seed_requests", "1 = 1");
			try
			{
				snapshot = await this.deps.readTreeSnapshot?.(unitOfWorkSignal(state.start));
				if (snapshot === undefined)
				{
					internalSyncError = "A seed needs internal auth (WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD)";
				}
			}
			catch (error)
			{
				// The public export alone is still a complete import; the edge tables wait for the next seed.
				snapshot = undefined;
				internalSyncError = errorMessage(error);
			}
		}
		await this.seedAccountRow(unitOfWorkSignal(state.start));
		const result = finishApiImport(state, snapshot?.items);
		if (snapshot !== undefined)
		{
			importInternalMetadata(this.deps.db, snapshot, this.now());
		}
		if (!seeding)
		{
			try
			{
				await this.deps.catchUp?.();
			}
			catch (error)
			{
				// Never reseeded automatically: a missing seed or a refresh request needs an explicit seed.
				internalSyncError =
					error instanceof TreeResyncRequired ? `${error.message}. ${SEED_HINT}` : errorMessage(error);
			}
		}
		const {importTimestamp: _timestamp, ...counts} = result;
		this.finishRun(
			job,
			{
				status: "ok",
				exportKey: job.exportKey,
				finishedAt: this.now(),
				durationMs: this.now() - job.startedAt,
				...counts,
				...(internalSyncError === undefined
					? {}
					:
						{
							internalSyncError,
						}),
			},
		);
		await this.scheduleNextRun();
	}
}

/** A `sync_runs` row as the run it versions, its result rebuilt from the typed columns. */
function jobFromRow(row: Record<string, SqlStorageValue>): Job
{
	const count = (column: string): number => Number(row[column]);
	const text = (column: string): string | undefined =>
	{
		const value = row[column];
		return typeof value === "string" ? value : undefined;
	};
	const totals =
	{
		totalNodes: count("total_nodes"),
		nodesAdded: count("nodes_added"),
		nodesUpdated: count("nodes_updated"),
		nodesUnchanged: count("nodes_unchanged"),
		contentUpdated: count("content_updated"),
		metadataUpdated: count("metadata_updated"),
	};
	const status = text("status");
	const exportKey = text("export_key") ?? "";
	const internalSyncError = text("internal_sync_error");
	let result: SyncResult | null = null;
	if (status === "ok")
	{
		result =
		{
			status,
			exportKey,
			finishedAt: count("result_at"),
			durationMs: count("duration_ms"),
			...totals,
			nodesDeleted: count("nodes_deleted"),
			nodesPhasedOut: count("nodes_phased_out"),
			priorityUpdated: count("priority_updated"),
			...(internalSyncError === undefined
				? {}
				:
					{
						internalSyncError,
					}),
		};
	}
	else if (status === "rate_limited" || status === "error")
	{
		result =
		{
			status,
			message: text("message") ?? "",
			at: count("result_at"),
		};
	}
	const phase = text("phase");
	const snapshotAt = row.snapshot_at;
	return {
		runId: text("run_id") ?? "",
		phase: phase === "fetching" || phase === "importing" ? phase : "idle",
		exportKey,
		applied: count("applied"),
		totals,
		startedAt: count("started_at"),
		...(typeof snapshotAt === "number"
			?
				{
					snapshotAt,
				}
			: {}),
		result,
	};
}

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}
