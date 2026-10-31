import {
	applyApiBatch,
	beginApiImport,
	finishApiImport,
	importInternalMetadata,
	readWorkflowyEpoch,
	runUnitOfWork,
	seedAccount,
	TRANSACTION_TIMEOUT_MS,
	unitOfWorkSignal,
} from "@workflowy/shared/cache";
import type {ApiImportState, ImportApiResult, StoredAccount} from "@workflowy/shared/cache";
import type {TreeSnapshot} from "@workflowy/shared/api";
import type {AppDatabase} from "@workflowy/shared/db";
import {TreeResyncRequired} from "@workflowy/shared/internal";
import {nodeBatches} from "./export-stream";

const BATCH_SIZE = 2000;
const DEFAULT_INTERVAL_MINUTES = 30;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const SEED_KEY = "seedRequested";
const SEED_HINT = "On the Worker, POST /api/admin/seed instead.";
/**
 * An alarm run stops applying batches, and leaves the finish to a fresh run, once this much of its transaction
 * timeout is spent, so the rest of the run commits well inside it.
 */
const RUN_BUDGET_MS = TRANSACTION_TIMEOUT_MS / 2;

/** Bindings the sync job reads; all but the bucket are optional. */
export interface SyncEnv {
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

export interface SyncDeps {
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
	now?: () => number;
}

type Phase = "idle" | "fetching" | "importing";

interface Job {
	phase: Phase;
	exportKey: string;
	/** Nodes of the export already applied; the stream resumes after them. */
	applied: number;
	totals: Pick<
		ApiImportState,
		"totalNodes" | "nodesAdded" | "nodesUpdated" | "nodesUnchanged" | "contentUpdated" | "metadataUpdated"
	>;
	startedAt: number;
}

export type SyncResult =
	| ({status: "ok"; exportKey: string; finishedAt: number; durationMs: number} & Omit<
			ImportApiResult,
			"importTimestamp"
	  > & {
				/**
				 * Set when the internal half failed (a seed's get_tree_data read, or the transaction-log catch-up):
				 * the public import still completed, the edge tables did not.
				 */
				internalSyncError?: string;
			})
	| {status: "rate_limited" | "error"; message: string; at: number};

export interface SyncStatus {
	phase: Phase;
	applied: number;
	nextAlarmAt: number | null;
	lastResult: SyncResult | null;
}

/** The streaming import, driven by Durable Object alarms with all progress in the object's own SQLite. */
export class SyncJob {
	constructor(private readonly deps: SyncDeps) {
		deps.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); " +
				"CREATE TABLE IF NOT EXISTS sync_seen (id TEXT PRIMARY KEY)",
		);
	}

	private get sql(): SqlStorage {
		return this.deps.storage.sql;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the shape it wrote
	private read<T>(key: string): T | null {
		const rows = this.sql.exec("SELECT value FROM sync_state WHERE key = ?", key).toArray();
		const value = rows[0]?.value;
		// oxlint-disable-next-line typescript/no-unsafe-return -- this table only holds what write() serialized
		return typeof value === "string" ? JSON.parse(value) : null;
	}

	private write(key: string, value: unknown): void {
		this.sql.exec("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)", key, JSON.stringify(value));
	}

	/** Make a run start (or continue) as soon as possible. */
	async syncNow(): Promise<SyncStatus> {
		await this.deps.storage.setAlarm(this.now());
		return this.status();
	}

	/**
	 * Make the next run (or the one in progress) finish with a whole-tree read that reseeds the edge tables, the
	 * transaction id and the expanded keys. The only path that reads get_tree_data; never triggered automatically.
	 */
	async seed(): Promise<SyncStatus> {
		this.write(SEED_KEY, true);
		return this.syncNow();
	}

	async status(): Promise<SyncStatus> {
		const job = this.read<Job>("job");
		return {
			phase: job?.phase ?? "idle",
			applied: job?.applied ?? 0,
			nextAlarmAt: await this.deps.storage.getAlarm(),
			lastResult: this.read<SyncResult>("lastResult"),
		};
	}

	/** One alarm: start a run when idle, otherwise continue the one in progress. */
	async tick(): Promise<void> {
		let job = this.read<Job>("job");
		if (job === null || job.phase === "idle") {
			job = {
				phase: "fetching",
				exportKey: "",
				applied: 0,
				totals: {
					totalNodes: 0,
					nodesAdded: 0,
					nodesUpdated: 0,
					nodesUnchanged: 0,
					contentUpdated: 0,
					metadataUpdated: 0,
				},
				startedAt: this.now(),
			};
			this.write("job", job);
		}
		try {
			if (job.phase === "fetching") {
				const fetched = await this.fetchExport(job);
				if (fetched === undefined) {
					return;
				}
				job = fetched;
			}
			await this.importExport(job);
		} catch (error) {
			this.finishRun({
				status: "error",
				message: errorMessage(error),
				at: this.now(),
			});
			await this.scheduleNextRun();
		}
	}

	/** Seed the account row once, when internal auth exists and none is live; a failure leaves it for the next run. */
	private async seedAccountRow(signal: AbortSignal): Promise<void> {
		if (readWorkflowyEpoch(this.deps.db) !== undefined) {
			return;
		}
		try {
			const stored = await this.deps.readAccount?.(signal);
			if (stored !== undefined) {
				runUnitOfWork(this.deps.db, (unitOfWork) => {
					seedAccount(unitOfWork, stored);
				});
			}
		} catch {
			// The epoch only serves backup imports; the sync itself does not depend on it.
		}
	}

	private finishRun(result: SyncResult): void {
		this.write("lastResult", result);
		this.write("job", null);
		this.sql.exec("DELETE FROM sync_seen");
	}

	private async scheduleNextRun(): Promise<void> {
		const minutes = Number(this.deps.env.SYNC_INTERVAL_MINUTES);
		const interval = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES) * 60_000;
		await this.deps.storage.setAlarm(this.now() + interval);
	}

	/** GET the export and tee it into R2. Returns undefined when the run was rescheduled instead. */
	private async fetchExport(job: Job): Promise<Job | undefined> {
		const {env} = this.deps;
		if (!env.WORKFLOWY_API_KEY) {
			this.finishRun({status: "error", message: "WORKFLOWY_API_KEY is not configured", at: this.now()});
			await this.scheduleNextRun();
			return undefined;
		}
		const base = (env.WORKFLOWY_API_URL === "" ? undefined : env.WORKFLOWY_API_URL) ?? "https://workflowy.com";
		const response = await fetch(`${base}/api/v1/nodes-export`, {
			headers: {Authorization: `Bearer ${env.WORKFLOWY_API_KEY}`},
		});
		if (response.status === 429) {
			const retryAfter = Number(response.headers.get("retry-after"));
			const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_BACKOFF_MS;
			await response.body?.cancel();
			// The job stays in "fetching", so the next alarm retries the same run.
			this.write("lastResult", {status: "rate_limited", message: "Workflowy answered 429", at: this.now()});
			await this.deps.storage.setAlarm(this.now() + delay);
			return undefined;
		}
		if (!response.ok || response.body === null) {
			throw new Error(`nodes-export failed with ${response.status}`);
		}
		const exportKey = `exports/${new Date(this.now()).toISOString().replaceAll(":", "-")}.json`;
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > 0) {
			const fixed = new FixedLengthStream(length);
			const piping = response.body.pipeTo(fixed.writable);
			await Promise.all([env.SNAPSHOTS.put(exportKey, fixed.readable), piping]);
		} else {
			await env.SNAPSHOTS.put(exportKey, await response.arrayBuffer());
		}
		const next: Job = {...job, phase: "importing", exportKey};
		this.write("job", next);
		return next;
	}

	/** This alarm run's import: a fresh system time, so the run is its own unit of work, resuming the run's totals. */
	private importState(job: Job): ApiImportState {
		const state = beginApiImport(this.deps.db);
		Object.assign(state, job.totals);
		for (const row of this.sql.exec("SELECT id FROM sync_seen").toArray()) {
			if (typeof row.id === "string") {
				state.seenIds.add(row.id);
			}
		}
		return state;
	}

	private async importExport(job: Job): Promise<void> {
		const {env, storage} = this.deps;
		const object = await env.SNAPSHOTS.get(job.exportKey);
		if (object === null) {
			throw new Error(`export ${job.exportKey} is missing from R2`);
		}
		const state = this.importState(job);
		const perTick = Number(env.SYNC_BATCHES_PER_TICK);
		const limit = Number.isFinite(perTick) && perTick > 0 ? perTick : Infinity;
		let batches = 0;
		let yielded = false;
		const overBudget = () => Date.now() - state.start.startedAt >= RUN_BUDGET_MS;
		// oxlint-disable-next-line typescript/no-unsafe-argument -- the workers types declare R2ObjectBody.body as ReadableStream<any>
		for await (const batch of nodeBatches(object.body, {
			size: BATCH_SIZE,
			skip: job.applied,
		})) {
			if (batches >= limit || (batches > 0 && overBudget())) {
				yielded = true;
				break;
			}
			// One transaction, so the cursor never runs ahead of or behind the rows it counts.
			storage.transactionSync(() => {
				applyApiBatch(state, batch);
				for (const node of batch) {
					if (state.seenIds.has(node.id)) {
						this.sql.exec("INSERT OR IGNORE INTO sync_seen (id) VALUES (?)", node.id);
					}
				}
				job = {
					...job,
					applied: job.applied + batch.length,
					totals: {
						totalNodes: state.totalNodes,
						nodesAdded: state.nodesAdded,
						nodesUpdated: state.nodesUpdated,
						nodesUnchanged: state.nodesUnchanged,
						contentUpdated: state.contentUpdated,
						metadataUpdated: state.metadataUpdated,
					},
				};
				this.write("job", job);
			});
			batches++;
		}
		if (yielded || (batches > 0 && overBudget())) {
			const delay = Number(env.SYNC_TICK_DELAY_MS);
			await storage.setAlarm(this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 0));
			return;
		}

		const seeding = this.read<boolean>(SEED_KEY) === true;
		let snapshot: TreeSnapshot | undefined;
		let internalSyncError: string | undefined;
		if (seeding) {
			this.write(SEED_KEY, null);
			try {
				snapshot = await this.deps.readTreeSnapshot?.(unitOfWorkSignal(state.start));
				if (snapshot === undefined) {
					internalSyncError = "A seed needs internal auth (WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD)";
				}
			} catch (error) {
				// The public export alone is still a complete import; the edge tables wait for the next seed.
				snapshot = undefined;
				internalSyncError = errorMessage(error);
			}
		}
		await this.seedAccountRow(unitOfWorkSignal(state.start));
		const result = finishApiImport(state, snapshot?.items);
		if (snapshot !== undefined) {
			importInternalMetadata(this.deps.db, snapshot, this.now());
		}
		if (!seeding) {
			try {
				await this.deps.catchUp?.();
			} catch (error) {
				// Never reseeded automatically: a missing seed or a refresh request needs an explicit seed.
				internalSyncError =
					error instanceof TreeResyncRequired ? `${error.message}. ${SEED_HINT}` : errorMessage(error);
			}
		}
		const {importTimestamp: _timestamp, ...counts} = result;
		this.finishRun({
			status: "ok",
			exportKey: job.exportKey,
			finishedAt: this.now(),
			durationMs: this.now() - job.startedAt,
			...counts,
			...(internalSyncError === undefined ? {} : {internalSyncError}),
		});
		await this.scheduleNextRun();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
