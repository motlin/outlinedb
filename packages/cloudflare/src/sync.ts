import {newSystemTimestamp, outboxStatus} from "@outlinedb/shared/cache";
import type {OutboxStatus} from "@outlinedb/shared/cache";
import {TreeResyncRequired} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {AppDatabase} from "@outlinedb/shared/db";
import type {JobAlarm} from "./alarm-schedule";
import {createWithMicrosecondSystemTimes} from "./text-system-times";

/**
 * Minutes between scheduled runs, each one small /push_and_poll from the stored transaction id. Hourly, as workflowy.com's
 * own web app polls: while a tab shows the outline, workflowy.com's signal socket nudges a run as soon as anything changes.
 */
const DEFAULT_INTERVAL_MINUTES = 60;
/** The run id every catch-up run's versions share, so they phase each other out instead of piling up live rows. */
const CATCH_UP_RUN_ID = "catch-up";
const REIMPORT_HINT = "Import again from Settings > Workflowy to resume syncing.";
const NO_CONNECTION = "A catch-up needs a workflowy.com connection";

/**
 * The sync job's table, temporal like every other table: one version per catch-up outcome. Its columns still hold the
 * full-export runs older objects recorded before the per-account import replaced them.
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
	rows_written INTEGER,
	rows_read INTEGER,
	system_from INTEGER NOT NULL,
	system_to INTEGER NOT NULL,
	PRIMARY KEY (run_id, system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_system_to_idx ON sync_runs (run_id, system_to);
CREATE INDEX IF NOT EXISTS sync_runs_closed_at_idx ON sync_runs (system_to) WHERE system_to < ${String(FAR_FUTURE_DATE)};
`;

const SYSTEM_TIMES: ReadonlySet<string> = new Set(["system_from", "system_to"]);

/** Bindings the sync job reads. */
export interface SyncEnv
{
	/** Minutes between scheduled catch-up runs (default {@link DEFAULT_INTERVAL_MINUTES}). */
	SYNC_INTERVAL_MINUTES?: string;
}

export interface SyncDeps
{
	storage: DurableObjectStorage;
	db: AppDatabase;
	env: SyncEnv;
	/**
	 * Brings the edge tables up to the tree's latest transaction with one pure poll from the stored transaction id,
	 * when the account keeps syncing; undefined when it does not.
	 */
	catchUp?: () => Promise<void> | undefined;
	/** Where the next run is scheduled; the object's own alarm unless the alarm is shared with other jobs. */
	alarm?: JobAlarm;
	now?: () => number;
}

export type SyncResult =
	|
	  {
			/** The transaction-log catch-up ran. */
			status: "caught_up";
			finishedAt: number;
			durationMs: number;
			/** Why the catch-up failed; the next scheduled run retries it. */
			internalSyncError?: string;
	  }
	|
	  {
			/**
			 * The catch-up can never succeed until the account imports again (the tree's log no longer holds the stored
			 * transaction id, or there is no connection), so no catch-up is scheduled until the sync is restarted.
			 */
			status: "needs_seed";
			message: string;
			at: number;
	  };

export interface SyncStatus
{
	nextAlarmAt: number | null;
	lastResult: SyncResult | null;
	/** Mirror mode's local writes not yet on workflowy.com. */
	outbox: OutboxStatus;
}

/** The scheduled transaction-log catch-up of an account that keeps syncing, with its outcome in the object's SQLite. */
export class SyncJob
{
	/** The system time of the alarm run in progress: every sync-table version it writes takes this one value. */
	private systemTime = newSystemTimestamp();

	constructor(private readonly deps: SyncDeps)
	{
		const {sql} = deps.storage;
		// The pre-temporal key/value table, the seen-id scratch and the full-export and seed request tables go.
		for (const table of ["sync_state", "sync_seen", "sync_seed_requests", "sync_export_requests"])
		{
			sql.exec(`DROP TABLE IF EXISTS ${table}`);
		}
		createWithMicrosecondSystemTimes(sql, SYNC_TABLES, ["sync_runs"], SYSTEM_TIMES);
		const runColumns = sql.exec("SELECT name FROM pragma_table_info('sync_runs')").toArray();
		for (const column of ["snapshot_at", "rows_written", "rows_read"])
		{
			if (!runColumns.some((row) => row.name === column))
			{
				sql.exec(`ALTER TABLE sync_runs ADD COLUMN ${column} INTEGER`);
			}
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

	/** The newest catch-up outcome. */
	private readLastResult(): SyncResult | null
	{
		const row = this.sql
			.exec(
				"SELECT * FROM sync_runs WHERE system_to = ? AND status IS NOT NULL ORDER BY system_from DESC LIMIT 1",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		return row === undefined ? null : resultFromRow(row);
	}

	/** Record a catch-up outcome, phasing out the one before it. */
	private writeResult(startedAt: number, result: SyncResult): void
	{
		this.sql.exec(
			"UPDATE sync_runs SET system_to = ? WHERE run_id = ? AND system_to = ? AND system_from <> ?",
			this.systemTime,
			CATCH_UP_RUN_ID,
			FAR_FUTURE_DATE,
			this.systemTime,
		);
		const caughtUp = result.status === "caught_up" ? result : undefined;
		const stopped = result.status === "needs_seed" ? result : undefined;
		this.sql.exec(
			"INSERT OR REPLACE INTO sync_runs (run_id, phase, export_key, applied, started_at, total_nodes, nodes_added, " +
				"nodes_updated, nodes_unchanged, nodes_deleted, nodes_phased_out, content_updated, metadata_updated, " +
				"priority_updated, status, message, result_at, duration_ms, internal_sync_error, system_from, system_to) " +
				"VALUES (?, 'idle', '', 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)",
			CATCH_UP_RUN_ID,
			startedAt,
			result.status,
			stopped?.message ?? null,
			stopped?.at ?? caughtUp?.finishedAt ?? null,
			caughtUp?.durationMs ?? null,
			caughtUp?.internalSyncError ?? null,
			this.systemTime,
			FAR_FUTURE_DATE,
		);
	}

	async status(): Promise<SyncStatus>
	{
		return {
			nextAlarmAt: await this.alarm.getAlarm(),
			lastResult: this.readLastResult(),
			outbox: outboxStatus(this.deps.db),
		};
	}

	/** Whether the catch-up stopped for good and waits for the account to import again. */
	needsSeed(): boolean
	{
		return this.readLastResult()?.status === "needs_seed";
	}

	/**
	 * One alarm: one /push_and_poll from the stored transaction id. A failure is reported as the run's
	 * internalSyncError and retried on schedule; a failure no retry can fix stops the schedule as `needs_seed`. A version
	 * is written only when the outcome differs from the last result, so a quiet hourly catch-up leaves no rows
	 * behind.
	 */
	async tick(): Promise<void>
	{
		this.systemTime = newSystemTimestamp();
		const startedAt = this.now();
		const failure =
			this.deps.catchUp === undefined
				?
					{
						message: NO_CONNECTION,
						permanent: true,
					}
				: await this.catchUp();
		const last = this.readLastResult();
		if (failure?.permanent === true)
		{
			if (!(last?.status === "needs_seed" && last.message === failure.message))
			{
				this.writeResult(
					startedAt,
					{
						status: "needs_seed",
						message: failure.message,
						at: this.now(),
					},
				);
			}
			// Not rescheduled: another run only repeats the failure.
			return;
		}
		const internalSyncError = failure?.message;
		if (!(last?.status === "caught_up" && last.internalSyncError === internalSyncError))
		{
			this.writeResult(
				startedAt,
				{
					status: "caught_up",
					finishedAt: this.now(),
					durationMs: this.now() - startedAt,
					...(internalSyncError === undefined
						? {}
						:
							{
								internalSyncError,
							}),
				},
			);
		}
		await this.scheduleNextRun();
	}

	private async scheduleNextRun(): Promise<void>
	{
		const minutes = Number(this.deps.env.SYNC_INTERVAL_MINUTES);
		const interval = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES) * 60_000;
		await this.alarm.setAlarm(this.now() + interval);
	}

	/** One catch-up from the transaction log; returns why it failed, if it did, and whether only an import can fix it. */
	private async catchUp(): Promise<
		|
		  {
				message: string;
				permanent: boolean;
		  }
		| undefined
	>
	{
		try
		{
			await this.deps.catchUp?.();
			return undefined;
		}
		catch (error)
		{
			// Never reseeded automatically: a missing transaction id or a refresh request needs a new import.
			return error instanceof TreeResyncRequired
				?
					{
						message: `${error.message}. ${REIMPORT_HINT}`,
						permanent: true,
					}
				:
					{
						message: errorMessage(error),
						permanent: false,
					};
		}
	}
}

/** A `sync_runs` row's catch-up outcome, rebuilt from the typed columns; null for an older full-export run. */
function resultFromRow(row: Record<string, SqlStorageValue>): SyncResult | null
{
	const status = row.status;
	const at = Number(row.result_at);
	if (status === "caught_up")
	{
		const internalSyncError = row.internal_sync_error;
		return {
			status,
			finishedAt: at,
			durationMs: Number(row.duration_ms),
			...(typeof internalSyncError === "string"
				?
					{
						internalSyncError,
					}
				: {}),
		};
	}
	if (status === "needs_seed")
	{
		return {
			status,
			message: typeof row.message === "string" ? row.message : "",
			at,
		};
	}
	return null;
}

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}
