import
{
	ACCOUNT_IMPORT_NAME,
	accountRows,
	applyApiBatch,
	beginApiImport,
	finishApiImport,
	importInternalMetadata,
	markApplied,
	newSystemTimestamp,
	runUnitOfWork,
	stampImportTime,
	treeDataNodes,
	writeAccountSnapshot,
} from "@outlinedb/shared/cache";
import type {AccountSnapshot, ApiImportState} from "@outlinedb/shared/cache";
import {MissingCredentialsError, SessionRejectedError} from "@outlinedb/shared/api";
import type {InternalSession, TreeDataItem, TreeSnapshot, WorkflowyInternalClient} from "@outlinedb/shared/api";
import type {AppDatabase} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {JobAlarm} from "./alarm-schedule";
import {nodeBatches} from "./export-stream";
import type {RowCounts} from "./row-meter";

const BATCH_SIZE = 2000;
/** An alarm run stops applying batches, and leaves the rest to a fresh run, once this much time is spent. */
const RUN_BUDGET_MS = 30_000;

/**
 * Each per-account import run, temporal like every other table: one version per alarm run, the newest live. A run
 * keeps what it found upstream per kind, what the node merge changed, and what it could not import, all as typed
 * columns. The fetched tree waits in R2 between alarm runs; nothing of it is stored here.
 */
const IMPORT_TABLE = `
CREATE TABLE IF NOT EXISTS workflowy_imports (
	run_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	applied INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	snapshot_at INTEGER,
	status TEXT NOT NULL,
	message TEXT,
	finished_at INTEGER,
	found_nodes INTEGER NOT NULL,
	found_completed INTEGER NOT NULL,
	found_mirrors INTEGER NOT NULL,
	found_backlinks INTEGER NOT NULL,
	found_expanded_keys INTEGER NOT NULL,
	found_stars INTEGER NOT NULL,
	found_star_order INTEGER NOT NULL,
	found_tag_colors INTEGER NOT NULL,
	found_saved_views INTEGER NOT NULL,
	found_settings INTEGER NOT NULL,
	nodes_added INTEGER NOT NULL,
	nodes_updated INTEGER NOT NULL,
	nodes_unchanged INTEGER NOT NULL,
	nodes_phased_out INTEGER NOT NULL,
	metadata_written INTEGER NOT NULL,
	invalid_nodes INTEGER NOT NULL,
	metadata_skipped INTEGER NOT NULL,
	rows_read INTEGER NOT NULL,
	rows_written INTEGER NOT NULL,
	system_from INTEGER NOT NULL,
	system_to INTEGER NOT NULL,
	PRIMARY KEY (run_id, system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflowy_imports_system_to_idx ON workflowy_imports (run_id, system_to);
CREATE INDEX IF NOT EXISTS workflowy_imports_closed_at_idx ON workflowy_imports (system_to)
	WHERE system_to < ${String(FAR_FUTURE_DATE)};
`;

type Phase = "idle" | "fetching" | "importing";

/** `expired`: workflowy.com refused the stored session, so the connection waits for the user to sign in again. */
type ImportStatus = "running" | "ok" | "error" | "expired";

/** What the run found on workflowy.com, by kind; every kind it found is what it imports. */
export interface ImportFound
{
	nodes: number;
	completed: number;
	mirrors: number;
	backlinks: number;
	expandedKeys: number;
	stars: number;
	starOrder: number;
	tagColors: number;
	savedViews: number;
	settings: number;
}

/** What the node merge changed: the outline found upstream replaces whatever was here, the tutorial included. */
export interface ImportNodeChanges
{
	added: number;
	updated: number;
	unchanged: number;
	phasedOut: number;
	metadataWritten: number;
}

/** What the run could not import, by kind. */
export interface ImportFailures
{
	/** Items whose node fields failed validation; left out. */
	invalidNodes: number;
	/** Items whose metadata belongs to a node the import left out. */
	metadataSkipped: number;
}

/** One import run, as the account sees it. */
export interface WorkflowyImportRun
{
	phase: Phase;
	status: ImportStatus;
	message: string | null;
	startedAt: number;
	finishedAt: number | null;
	/** Nodes of the fetched tree applied so far; a resumed alarm run continues after them. */
	applied: number;
	found: ImportFound;
	nodes: ImportNodeChanges;
	failures: ImportFailures;
	rowsRead: number;
	rowsWritten: number;
}

export interface WorkflowyImportView
{
	/** The newest run, or null before the first import. */
	run: WorkflowyImportRun | null;
}

/** What the import job needs from its Durable Object. */
export interface WorkflowyImportDeps
{
	storage: DurableObjectStorage;
	db: AppDatabase;
	/** Holds the fetched tree between alarm runs, under {@link keyPrefix}. */
	bucket: R2Bucket;
	/** Namespaces this object's R2 keys, so one account never reads another's fetched tree. */
	keyPrefix: string;
	/** A client on the account's stored session, with no password to fall back on; undefined when not connected. */
	openClient: () => Promise<WorkflowyInternalClient | undefined>;
	/** Mark the connection expired once workflowy.com refused its session. */
	expireSession: () => void;
	alarm: JobAlarm;
	/** Rows the object's SQLite has read and written so far, index rows included. */
	rows?: () => RowCounts;
	env:
	{
		/** Nodes applied per batch (default {@link BATCH_SIZE}). */
		SYNC_BATCH_SIZE?: string;
		/** Batches applied per alarm run before yielding (default: all within the run budget). */
		SYNC_BATCHES_PER_TICK?: string;
		/** Delay before the next alarm run when one yields mid-import (default 0). */
		SYNC_TICK_DELAY_MS?: string;
	};
	now?: () => number;
}

interface Job extends WorkflowyImportRun
{
	runId: string;
	snapshotAt: number | null;
}

const NO_ROWS: RowCounts =
{
	rowsRead: 0,
	rowsWritten: 0,
};

const NONE_FOUND: ImportFound =
{
	nodes: 0,
	completed: 0,
	mirrors: 0,
	backlinks: 0,
	expandedKeys: 0,
	stars: 0,
	starOrder: 0,
	tagColors: 0,
	savedViews: 0,
	settings: 0,
};

const NO_CHANGES: ImportNodeChanges =
{
	added: 0,
	updated: 0,
	unchanged: 0,
	phasedOut: 0,
	metadataWritten: 0,
};

const NO_FAILURES: ImportFailures =
{
	invalidNodes: 0,
	metadataSkipped: 0,
};

/**
 * The account's one-time import from workflowy.com over its own stored session: one alarm run fetches the account and
 * the whole tree into R2, later ones apply the tree in batches through the export import path, and the last one ends
 * every node the tree does not hold (the tutorial outline among them, with no confirm), merges mirrors, backlinks and
 * item metadata, and replaces the account tables and expansion. All progress lives in this object's SQLite, so a
 * restart resumes the run. Nothing is retried: a failed run stays failed until the user starts another.
 */
export class WorkflowyImportJob
{
	/** The system time of the alarm run in progress: every version it writes takes this one value. */
	private systemTime = newSystemTimestamp();
	private rowsAtTick: RowCounts = NO_ROWS;

	constructor(private readonly deps: WorkflowyImportDeps)
	{
		deps.storage.sql.exec(IMPORT_TABLE);
	}

	private get sql(): SqlStorage
	{
		return this.deps.storage.sql;
	}

	private now(): number
	{
		return (this.deps.now ?? Date.now)();
	}

	private rows(): RowCounts
	{
		return this.deps.rows?.() ?? NO_ROWS;
	}

	private key(job: Job, name: "nodes" | "tree" | "account"): string
	{
		return `imports/${this.deps.keyPrefix}/${job.runId}/${name}.json`;
	}

	private newestJob(): Job | null
	{
		const row = this.sql
			.exec(
				"SELECT * FROM workflowy_imports WHERE system_to = ? ORDER BY started_at DESC, system_from DESC LIMIT 1",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		return row === undefined ? null : jobFromRow(row);
	}

	private runningJob(): Job | null
	{
		const job = this.newestJob();
		return job?.status === "running" ? job : null;
	}

	view(): WorkflowyImportView
	{
		const job = this.newestJob();
		if (job === null)
		{
			return {
				run: null,
			};
		}
		const {runId: _runId, snapshotAt: _snapshotAt, ...run} = job;
		return {
			run,
		};
	}

	/** Start an import on the next alarm, or keep the one in progress. */
	async start(): Promise<WorkflowyImportView>
	{
		if (this.runningJob() === null)
		{
			this.beginTick();
			this.writeJob(
				{
					runId: crypto.randomUUID(),
					phase: "fetching",
					status: "running",
					message: null,
					startedAt: this.now(),
					finishedAt: null,
					snapshotAt: null,
					applied: 0,
					found: NONE_FOUND,
					nodes: NO_CHANGES,
					failures: NO_FAILURES,
					rowsRead: 0,
					rowsWritten: 0,
				},
			);
			await this.deps.alarm.setAlarm(this.now());
		}
		return this.view();
	}

	private beginTick(): void
	{
		this.systemTime = newSystemTimestamp();
		this.rowsAtTick = this.rows();
	}

	/** One alarm run: fetch the tree, or apply the next batches of it, or finish the import. */
	async tick(): Promise<void>
	{
		this.beginTick();
		let job = this.runningJob();
		if (job === null)
		{
			return;
		}
		try
		{
			if (job.phase === "fetching")
			{
				const fetched = await this.fetch(job);
				if (fetched === undefined)
				{
					return;
				}
				job = fetched;
			}
			await this.importTree(job);
		}
		catch (error)
		{
			// The live version holds the progress the failed alarm run committed.
			await this.finish(this.runningJob() ?? job, "error", errorMessage(error));
		}
	}

	/**
	 * Read the account and the whole tree over the stored session and park them in R2. Returns undefined when the run
	 * ended instead: not connected, or workflowy.com refused the session.
	 */
	private async fetch(job: Job): Promise<Job | undefined>
	{
		const client = await this.deps.openClient();
		if (client === undefined)
		{
			await this.finish(job, "error", "workflowy-not-connected");
			return undefined;
		}
		// Read before the request goes out: a node written after it is not the tree's to end.
		const snapshotAt = Date.now();
		let session: InternalSession;
		let tree: TreeSnapshot<TreeDataItem>;
		try
		{
			session = await client.bootstrap();
			tree = await client.getTreeSnapshot(
				{
					nodeFields: true,
				},
			);
		}
		catch (error)
		{
			if (error instanceof MissingCredentialsError || error instanceof SessionRejectedError)
			{
				this.deps.expireSession();
				await this.finish(job, "expired", "workflowy-session-expired");
				return undefined;
			}
			throw error;
		}
		const account = accountSnapshot(session);
		const nodes = treeDataNodes(tree.items, session.dateJoinedSec);
		const {bucket} = this.deps;
		await bucket.put(
			this.key(job, "nodes"),
			new Blob(['{"nodes":[', ...nodes.map((node, i) => (i === 0 ? "" : ",") + JSON.stringify(node)), "]}"]),
		);
		await bucket.put(
			this.key(job, "tree"),
			JSON.stringify(
				{
					items: tree.items.map(({id, metadata}) => (
					{
						id,
						metadata,
					})),
					txId: tree.txId,
					expandedKeys: tree.expandedKeys,
				} satisfies TreeSnapshot,
			),
		);
		await bucket.put(this.key(job, "account"), JSON.stringify(account));
		const next: Job =
		{
			...job,
			phase: "importing",
			snapshotAt,
			found: found(nodes.length, tree, account),
		};
		this.writeJob(next);
		return next;
	}

	/** This alarm run's share of the node merge: a fresh system time, resuming the run's totals. */
	private importState(job: Job): ApiImportState
	{
		const state = beginApiImport(
			this.deps.db,
			{
				snapshotTakenAt: job.snapshotAt === null ? undefined : new Date(job.snapshotAt),
			},
		);
		state.nodesAdded = job.nodes.added;
		state.nodesUpdated = job.nodes.updated;
		state.nodesUnchanged = job.nodes.unchanged;
		state.totalNodes = job.applied;
		state.validationErrors = job.failures.invalidNodes;
		return state;
	}

	private async importTree(job: Job): Promise<void>
	{
		const {bucket, env, storage} = this.deps;
		const object = await bucket.get(this.key(job, "nodes"));
		if (object === null)
		{
			throw new Error(`the fetched tree ${this.key(job, "nodes")} is missing from R2`);
		}
		const state = this.importState(job);
		const perTick = Number(env.SYNC_BATCHES_PER_TICK);
		const limit = Number.isFinite(perTick) && perTick > 0 ? perTick : Infinity;
		const batchSize = Number(env.SYNC_BATCH_SIZE);
		const overBudget = () => Date.now() - state.start.startedAt >= RUN_BUDGET_MS;
		let batches = 0;
		let yielded = false;
		for await (const batch of nodeBatches(
			// oxlint-disable-next-line typescript/no-unsafe-argument -- the workers types declare R2ObjectBody.body as ReadableStream<any>
			object.body,
			{
				size: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : BATCH_SIZE,
				skip: job.applied,
				onSkipped: (node) =>
				{
					markApplied(state, node);
				},
			},
		))
		{
			if (batches >= limit || (batches > 0 && overBudget()))
			{
				yielded = true;
				break;
			}
			// One transaction, so the stored cursor never runs ahead of the rows it counts.
			storage.transactionSync(() =>
			{
				applyApiBatch(state, batch);
				job =
				{
					...job,
					applied: job.applied + batch.length,
					nodes:
					{
						...job.nodes,
						added: state.nodesAdded,
						updated: state.nodesUpdated,
						unchanged: state.nodesUnchanged,
					},
					failures:
					{
						...job.failures,
						invalidNodes: state.validationErrors,
					},
				};
				this.writeJob(job);
			});
			batches++;
		}
		if (yielded || (batches > 0 && overBudget()))
		{
			const delay = Number(env.SYNC_TICK_DELAY_MS);
			await this.deps.alarm.setAlarm(this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 0));
			return;
		}

		const tree = await this.readJson<TreeSnapshot>(job, "tree");
		const account = await this.readJson<AccountSnapshot>(job, "account");
		const result = finishApiImport(state, tree.items);
		const metadata = importInternalMetadata(this.deps.db, tree, this.now());
		runUnitOfWork(this.deps.db, (unitOfWork) =>
		{
			writeAccountSnapshot(unitOfWork, account);
			stampImportTime(unitOfWork, ACCOUNT_IMPORT_NAME, this.now());
		});
		await this.finish(
			{
				...job,
				nodes:
				{
					added: result.nodesAdded,
					updated: result.nodesUpdated,
					unchanged: result.nodesUnchanged,
					phasedOut: result.nodesPhasedOut,
					metadataWritten: metadata.written,
				},
				failures:
				{
					invalidNodes: state.validationErrors,
					metadataSkipped: metadata.skipped,
				},
			},
			"ok",
			null,
		);
	}

	private async readJson<T>(job: Job, name: "tree" | "account"): Promise<T>
	{
		const object = await this.deps.bucket.get(this.key(job, name));
		if (object === null)
		{
			throw new Error(`the fetched ${name} ${this.key(job, name)} is missing from R2`);
		}
		return object.json<T>();
	}

	/** End the run and drop what it parked in R2: the account's outline is never kept outside its own object. */
	private async finish(job: Job, status: Exclude<ImportStatus, "running">, message: string | null): Promise<void>
	{
		this.writeJob(
			{
				...job,
				phase: "idle",
				status,
				message,
				finishedAt: this.now(),
			},
		);
		await this.deps.bucket.delete([this.key(job, "nodes"), this.key(job, "tree"), this.key(job, "account")]);
	}

	/**
	 * Write the run's version for this alarm run: close the version an earlier alarm run wrote, or replace the one
	 * this alarm run already wrote, so each alarm run leaves one version.
	 */
	private writeJob(job: Job): void
	{
		this.sql.exec(
			"UPDATE workflowy_imports SET system_to = ? WHERE run_id = ? AND system_to = ? AND system_from <> ?",
			this.systemTime,
			job.runId,
			FAR_FUTURE_DATE,
			this.systemTime,
		);
		const rows = this.rows();
		this.sql.exec(
			"INSERT OR REPLACE INTO workflowy_imports (run_id, phase, applied, started_at, snapshot_at, status, message, " +
				"finished_at, found_nodes, found_completed, found_mirrors, found_backlinks, found_expanded_keys, found_stars, " +
				"found_star_order, found_tag_colors, found_saved_views, found_settings, nodes_added, nodes_updated, " +
				"nodes_unchanged, nodes_phased_out, metadata_written, invalid_nodes, metadata_skipped, rows_read, rows_written, " +
				"system_from, system_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			job.runId,
			job.phase,
			job.applied,
			job.startedAt,
			job.snapshotAt,
			job.status,
			job.message,
			job.finishedAt,
			job.found.nodes,
			job.found.completed,
			job.found.mirrors,
			job.found.backlinks,
			job.found.expandedKeys,
			job.found.stars,
			job.found.starOrder,
			job.found.tagColors,
			job.found.savedViews,
			job.found.settings,
			job.nodes.added,
			job.nodes.updated,
			job.nodes.unchanged,
			job.nodes.phasedOut,
			job.nodes.metadataWritten,
			job.failures.invalidNodes,
			job.failures.metadataSkipped,
			job.rowsRead + rows.rowsRead - this.rowsAtTick.rowsRead,
			job.rowsWritten + rows.rowsWritten - this.rowsAtTick.rowsWritten,
			this.systemTime,
			FAR_FUTURE_DATE,
		);
	}
}

/** The account tables' source, in the shape the account import writes. */
function accountSnapshot(session: InternalSession): AccountSnapshot
{
	return {
		account:
		{
			userId: String(session.userId),
			dateJoinedSec: session.dateJoinedSec,
			...(session.fullName === undefined
				? {}
				:
					{
						fullName: session.fullName,
					}),
			...(session.entropyKey === undefined
				? {}
				:
					{
						entropyKey: session.entropyKey,
					}),
		},
		rootMetadata: session.rootMetadata,
		settings: session.settings,
		visibleFeatures: session.visibleFeatures,
	};
}

/** What one fetch found upstream, by kind. */
function found(nodes: number, tree: TreeSnapshot<TreeDataItem>, account: AccountSnapshot): ImportFound
{
	const rows = accountRows(account);
	let completed = 0;
	let mirrors = 0;
	let backlinks = 0;
	for (const item of tree.items)
	{
		if (item.cp !== undefined && item.cp !== null)
		{
			completed++;
		}
		const mirror: unknown = item.metadata?.mirror;
		if (isRecord(mirror) && typeof mirror.originalId === "string" && mirror.originalId !== "")
		{
			mirrors++;
		}
		const backlink: unknown = item.metadata?.backlink;
		if (isRecord(backlink) && typeof backlink.sourceID === "string" && backlink.sourceID !== "")
		{
			backlinks++;
		}
	}
	return {
		nodes,
		completed,
		mirrors,
		backlinks,
		expandedKeys: tree.expandedKeys.length,
		stars: rows.stars.length,
		starOrder: rows.starOrder.length,
		tagColors: rows.tagColors.length,
		savedViews: rows.savedViews.length,
		settings: Object.keys(account.settings).length,
	};
}

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `workflowy_imports` row as the run it versions. */
function jobFromRow(row: Record<string, SqlStorageValue>): Job
{
	const count = (column: string): number => Number(row[column]);
	const text = (column: string): string | null =>
	{
		const value = row[column];
		return typeof value === "string" ? value : null;
	};
	const phase = text("phase");
	const status = text("status");
	const finishedAt = row.finished_at;
	const snapshotAt = row.snapshot_at;
	return {
		runId: text("run_id") ?? "",
		phase: phase === "fetching" || phase === "importing" ? phase : "idle",
		status: status === "running" || status === "ok" || status === "expired" ? status : "error",
		message: text("message"),
		startedAt: count("started_at"),
		finishedAt: typeof finishedAt === "number" ? finishedAt : null,
		snapshotAt: typeof snapshotAt === "number" ? snapshotAt : null,
		applied: count("applied"),
		found:
		{
			nodes: count("found_nodes"),
			completed: count("found_completed"),
			mirrors: count("found_mirrors"),
			backlinks: count("found_backlinks"),
			expandedKeys: count("found_expanded_keys"),
			stars: count("found_stars"),
			starOrder: count("found_star_order"),
			tagColors: count("found_tag_colors"),
			savedViews: count("found_saved_views"),
			settings: count("found_settings"),
		},
		nodes:
		{
			added: count("nodes_added"),
			updated: count("nodes_updated"),
			unchanged: count("nodes_unchanged"),
			phasedOut: count("nodes_phased_out"),
			metadataWritten: count("metadata_written"),
		},
		failures:
		{
			invalidNodes: count("invalid_nodes"),
			metadataSkipped: count("metadata_skipped"),
		},
		rowsRead: count("rows_read"),
		rowsWritten: count("rows_written"),
	};
}

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}
