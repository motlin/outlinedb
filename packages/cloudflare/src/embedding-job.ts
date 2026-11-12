import {buildEmbedTexts, filterEmbeddable, newSystemTimestamp, PathBuilder} from "@outlinedb/shared/cache";
import type {AppDatabase} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {Awaitable, EmbeddingIndex} from "@outlinedb/web/server-app";
import {changeWatermark} from "@outlinedb/web/server-app";
import type {JobAlarm} from "./alarm-schedule";
import type {Embedder} from "./embeddings";

/** Texts per Workers AI call. */
const EMBED_BATCH = 100;
/**
 * The longest document sent, in characters: about 4,000 tokens of English, well inside Qwen3-Embedding's 8,192-token context
 * even for denser scripts, so one oversized container never fails its whole batch.
 */
const MAX_TEXT_CHARS = 16_000;
/** An alarm run stops starting batches once this much time is spent, like the sync job's run budget. */
const RUN_BUDGET_MS = 25_000;
/** How long a failed batch waits before the next try. */
const RETRY_DELAY_MS = 60_000;

/**
 * The job's own tables, temporal like every other table. `embedding_queue` holds the nodes waiting to be embedded
 * (live rows) and, closed, when each was last taken, so a change already handled is not queued again; closed rows
 * older than the scan watermark go. `embedding_state` versions the job's phase and how far the change scan has read.
 */
const EMBEDDING_TABLES = `
CREATE TABLE IF NOT EXISTS embedding_queue (
	node_id TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (node_id, system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS embedding_queue_system_to_idx ON embedding_queue (node_id, system_to);
CREATE INDEX IF NOT EXISTS embedding_queue_closed_at_idx ON embedding_queue (system_to) WHERE system_to < '${FAR_FUTURE_DATE}';
CREATE TABLE IF NOT EXISTS embedding_state (
	phase TEXT NOT NULL,
	scanned_to TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS embedding_state_system_to_idx ON embedding_state (system_to);
CREATE INDEX IF NOT EXISTS embedding_state_closed_at_idx ON embedding_state (system_to) WHERE system_to < '${FAR_FUTURE_DATE}';
`;

/** `backfilling` until every container is embedded once, then `ready`; `off` until Enable AI requests embeddings. */
type Phase = "off" | "backfilling" | "ready";

interface State {
	phase: Exclude<Phase, "off">;
	scannedTo: string;
}

export interface EmbeddingStatus {
	phase: Phase;
	queued: number;
	lastError?: string;
}

export interface EmbeddingDeps {
	storage: DurableObjectStorage;
	db: AppDatabase;
	index: EmbeddingIndex;
	embedder: Embedder;
	/** Set `ai.embeddingStatus` to "finished"; a failure leaves the backfill to finish on a later run. */
	markFinished: () => Awaitable<void>;
	alarm: JobAlarm;
	now?: () => number;
}

/**
 * Keeps the related-notes index in step with the outline. Enable AI (`ai.embeddingStatus` "requested") queues every
 * container; afterwards each sync run and app write queues the nodes whose text changed and their parents (whose
 * CHILDREN text moved). Alarm runs embed the queue in batches and drop vectors of nodes that stopped being containers.
 */
export class EmbeddingJob {
	private lastError: string | undefined;

	constructor(private readonly deps: EmbeddingDeps) {
		deps.storage.sql.exec(EMBEDDING_TABLES);
	}

	private get sql(): SqlStorage {
		return this.deps.storage.sql;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private readState(): State | undefined {
		const row = this.sql
			.exec("SELECT phase, scanned_to FROM embedding_state WHERE system_to = ?", FAR_FUTURE_DATE)
			.toArray()[0];
		if (row === undefined || typeof row.scanned_to !== "string") {
			return undefined;
		}
		return {phase: row.phase === "ready" ? "ready" : "backfilling", scannedTo: row.scanned_to};
	}

	private writeState(state: State): void {
		const systemTime = newSystemTimestamp();
		this.sql.exec(
			"DELETE FROM embedding_state WHERE system_to = ? AND system_from >= ?",
			FAR_FUTURE_DATE,
			systemTime,
		);
		this.sql.exec("UPDATE embedding_state SET system_to = ? WHERE system_to = ?", systemTime, FAR_FUTURE_DATE);
		this.sql.exec(
			"INSERT INTO embedding_state (phase, scanned_to, system_from, system_to) VALUES (?, ?, ?, ?)",
			state.phase,
			state.scannedTo,
			systemTime,
			FAR_FUTURE_DATE,
		);
	}

	private requested(): boolean {
		const row = this.sql
			.exec("SELECT ai_embedding_status AS status FROM root_preferences WHERE system_to = ?", FAR_FUTURE_DATE)
			.toArray()[0];
		return row?.status === "requested";
	}

	private queued(): number {
		return Number(
			this.sql.exec("SELECT count(*) AS n FROM embedding_queue WHERE system_to = ?", FAR_FUTURE_DATE).one().n,
		);
	}

	status(): EmbeddingStatus {
		return {
			phase: this.readState()?.phase ?? "off",
			queued: this.queued(),
			...(this.lastError === undefined ? {} : {lastError: this.lastError}),
		};
	}

	/**
	 * Queue what needs embedding: every container when Enable AI has just requested it, otherwise the nodes changed
	 * since the last scan. Schedules an alarm run when anything is queued.
	 */
	async notice(): Promise<void> {
		const state = this.readState();
		const watermark = changeWatermark(this.deps.db);
		if (this.requested() && state?.phase !== "backfilling") {
			this.queueAllContainers();
			this.writeState({phase: "backfilling", scannedTo: watermark});
		} else if (state === undefined || !this.queueChangesSince(state.scannedTo)) {
			return;
		} else if (watermark > state.scannedTo) {
			this.writeState({...state, scannedTo: watermark});
			this.sql.exec(
				"DELETE FROM embedding_queue WHERE system_to < ? AND system_from < ?",
				FAR_FUTURE_DATE,
				watermark,
			);
		}
		if (this.queued() > 0) {
			await this.deps.alarm.setAlarm(this.now());
		}
	}

	/** Queue every current container that is not a mirror and not already queued. */
	private queueAllContainers(): void {
		const systemTime = newSystemTimestamp();
		this.sql.exec(
			`INSERT INTO embedding_queue (node_id, system_from, system_to)
			SELECT DISTINCT child.parent_id, ?, ? FROM node_content child
			JOIN node_content parent ON parent.id = child.parent_id AND parent.system_to = ?
			WHERE child.system_to = ? AND child.parent_id IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM mirrors WHERE mirror_id = child.parent_id AND system_to = ?)
				AND NOT EXISTS (SELECT 1 FROM embedding_queue q WHERE q.node_id = child.parent_id AND q.system_to = ?)`,
			systemTime,
			FAR_FUTURE_DATE,
			FAR_FUTURE_DATE,
			FAR_FUTURE_DATE,
			FAR_FUTURE_DATE,
			FAR_FUTURE_DATE,
		);
	}

	/**
	 * Queue the nodes whose content rows opened or closed after `since`, with their old and new parents, skipping
	 * those already queued or taken since the change. Returns whether any change was seen.
	 */
	private queueChangesSince(since: string): boolean {
		const changedAt = new Map<string, string>();
		const note = (id: unknown, at: unknown) => {
			if (typeof id === "string" && typeof at === "string" && (changedAt.get(id) ?? "") < at) {
				changedAt.set(id, at);
			}
		};
		const opened = this.sql.exec(
			"SELECT id, parent_id, system_from AS at FROM node_content WHERE system_from > ?",
			since,
		);
		const closed = this.sql.exec(
			`SELECT id, parent_id, system_to AS at FROM node_content WHERE system_to < '${FAR_FUTURE_DATE}' AND system_to > ?`,
			since,
		);
		for (const row of [...opened, ...closed]) {
			note(row.id, row.at);
			note(row.parent_id, row.at);
		}
		if (changedAt.size === 0) {
			return false;
		}
		const handled = new Map<string, string>();
		for (const row of this.sql.exec(
			"SELECT node_id, max(system_to = ?) AS live, max(system_from) AS taken FROM embedding_queue " +
				"WHERE node_id IN (SELECT value FROM json_each(?)) GROUP BY node_id",
			FAR_FUTURE_DATE,
			JSON.stringify([...changedAt.keys()]),
		)) {
			if (typeof row.node_id === "string" && typeof row.taken === "string") {
				handled.set(row.node_id, row.live === 1 ? FAR_FUTURE_DATE : row.taken);
			}
		}
		const systemTime = newSystemTimestamp();
		for (const [id, at] of changedAt) {
			if ((handled.get(id) ?? "") < at) {
				this.sql.exec(
					"INSERT INTO embedding_queue (node_id, system_from, system_to) VALUES (?, ?, ?)",
					id,
					systemTime,
					FAR_FUTURE_DATE,
				);
			}
		}
		return true;
	}

	/** One alarm run: embed queued batches until the queue empties or the budget runs out. */
	async tick(): Promise<void> {
		const started = this.now();
		const pathBuilder = new PathBuilder(this.deps.db);
		try {
			for (;;) {
				const ids = this.sql
					.exec(
						"SELECT node_id FROM embedding_queue WHERE system_to = ? LIMIT ?",
						FAR_FUTURE_DATE,
						EMBED_BATCH,
					)
					.toArray()
					.flatMap((row) => (typeof row.node_id === "string" ? [row.node_id] : []));
				if (ids.length === 0) {
					break;
				}
				await this.embedBatch(ids, pathBuilder);
				if (this.now() - started > RUN_BUDGET_MS) {
					await this.deps.alarm.setAlarm(this.now());
					return;
				}
			}
			const state = this.readState();
			if (state?.phase === "backfilling") {
				await this.deps.markFinished();
				this.writeState({...state, phase: "ready"});
			}
			this.lastError = undefined;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			console.error(`Embedding run failed: ${this.lastError}`);
			await this.deps.alarm.setAlarm(this.now() + RETRY_DELAY_MS);
		}
	}

	/** Embed the containers among `ids`, drop the vectors of the rest, then close their queue rows. */
	private async embedBatch(ids: string[], pathBuilder: PathBuilder): Promise<void> {
		const embeddable = filterEmbeddable(this.deps.db, ids, pathBuilder);
		const kept = new Set(embeddable);
		if (embeddable.length > 0) {
			const texts = buildEmbedTexts(this.deps.db, embeddable, pathBuilder);
			const vectors = await this.deps.embedder.embed(
				embeddable.map((id) => (texts.get(id) ?? "").slice(0, MAX_TEXT_CHARS)),
			);
			await this.deps.index.upsert(embeddable.map((id, i) => ({id, vector: vectors[i] ?? []})));
		}
		await this.deps.index.delete(ids.filter((id) => !kept.has(id)));
		const systemTime = newSystemTimestamp();
		const list = JSON.stringify(ids);
		this.sql.exec(
			"DELETE FROM embedding_queue WHERE system_to = ? AND system_from >= ? AND node_id IN (SELECT value FROM json_each(?))",
			FAR_FUTURE_DATE,
			systemTime,
			list,
		);
		this.sql.exec(
			"UPDATE embedding_queue SET system_to = ? WHERE system_to = ? AND node_id IN (SELECT value FROM json_each(?))",
			systemTime,
			FAR_FUTURE_DATE,
			list,
		);
	}
}
