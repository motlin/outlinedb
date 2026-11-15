import {and, asc, desc, isNotNull, lte, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {outbox} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {currentVersion} from "./cache-temporal.js";
import {inIds} from "./in-ids.js";
import type {UnitOfWork} from "./node-composite.js";
import {closeCurrentVersions} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** The parts of a node a mirror-mode write can leave ahead of workflowy.com. */
export const OUTBOX_ASPECTS = [
	"create",
	"name",
	"note",
	"placement",
	"completion",
	"metadata",
	"mirror",
	"delete",
] as const;

export type OutboxAspect = (typeof OUTBOX_ASPECTS)[number];

/** Durable Object SQLite caps a statement at 100 bound parameters; an outbox row binds 6. */
const ROWS_PER_INSERT = 15;

export interface OutboxEntry
{
	nodeId: string;
	aspect: OutboxAspect;
}

/**
 * Records which aspects of which nodes a unit of work left ahead of workflowy.com, as current `outbox` rows in that
 * same unit of work. An aspect that already has a current row keeps it, so a burst of edits coalesces into one row
 * whose `enqueued_at` is the first pending write. `entries` must not repeat a node and aspect.
 */
export class OutboxRecorder
{
	record({tx, systemTime}: UnitOfWork, entries: readonly OutboxEntry[]): void
	{
		if (entries.length === 0)
		{
			return;
		}
		const current = pendingAspects(tx, [...new Set(entries.map(({nodeId}) => nodeId))]);
		const rows = entries
			.filter(({nodeId, aspect}) => current.get(nodeId)?.has(aspect) !== true)
			.map(({nodeId, aspect}) => (
			{
				nodeId,
				aspect,
				enqueuedAt: systemTime,
				lastError: null,
				systemFrom: systemTime,
				systemTo: FAR_FUTURE_DATE,
			}));
		for (let start = 0; start < rows.length; start += ROWS_PER_INSERT)
		{
			tx.insert(outbox)
				.values(rows.slice(start, start + ROWS_PER_INSERT))
				.run();
		}
	}
}

/** The pending (current) outbox aspects of each of `nodeIds` that has any, in one set-based read. */
export function pendingAspects(tx: TemporalTransaction, nodeIds: readonly string[]): Map<string, Set<OutboxAspect>>
{
	const pending = new Map<string, Set<OutboxAspect>>();
	if (nodeIds.length === 0)
	{
		return pending;
	}
	const rows = tx
		.select(
			{
				nodeId: outbox.nodeId,
				aspect: outbox.aspect,
			},
		)
		.from(outbox)
		.where(and(inIds(outbox.nodeId, nodeIds), currentVersion(outbox)))
		.all();
	for (const {nodeId, aspect} of rows)
	{
		let aspects = pending.get(nodeId);
		if (aspects === undefined)
		{
			aspects = new Set();
			pending.set(nodeId, aspects);
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the recorder writes only OutboxAspect values
		aspects.add(aspect as OutboxAspect);
	}
	return pending;
}

/** One current outbox row. */
export interface PendingOutboxRow extends OutboxEntry
{
	enqueuedAt: string;
	lastError: string | null;
}

/** Where `(node_id, aspect)` is one of `entries`, bound as one JSON parameter. */
function entriesWhere(entries: readonly OutboxEntry[]): SQL
{
	const keys = entries.map(({nodeId, aspect}) => `${nodeId}\u001F${aspect}`);
	return sql`(${outbox.nodeId} || char(31) || ${outbox.aspect}) IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`;
}

/**
 * The current outbox rows of the oldest pending writes: about `cap` rows, rounded up to whole enqueue times, so the
 * rows one unit of work recorded are read together. Oldest first.
 */
export function readPendingOutbox(tx: TemporalTransaction, cap: number): PendingOutboxRow[]
{
	const cutoff = tx
		.select(
			{
				enqueuedAt: outbox.enqueuedAt,
			},
		)
		.from(outbox)
		.where(currentVersion(outbox))
		.orderBy(asc(outbox.enqueuedAt))
		.limit(1)
		.offset(Math.max(cap - 1, 0))
		.get();
	const rows = tx
		.select(
			{
				nodeId: outbox.nodeId,
				aspect: outbox.aspect,
				enqueuedAt: outbox.enqueuedAt,
				lastError: outbox.lastError,
			},
		)
		.from(outbox)
		.where(
			and(currentVersion(outbox), cutoff === undefined ? undefined : lte(outbox.enqueuedAt, cutoff.enqueuedAt)),
		)
		.orderBy(asc(outbox.enqueuedAt), asc(outbox.nodeId), asc(outbox.aspect))
		.all();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the recorder writes only OutboxAspect values
	return rows as PendingOutboxRow[];
}

/** Close `entries`' current rows: workflowy.com has them, or they no longer need sending. */
export function closeOutboxRows({tx, systemTime}: UnitOfWork, entries: readonly OutboxEntry[]): void
{
	if (entries.length > 0)
	{
		closeCurrentVersions(tx, outbox, systemTime, entriesWhere(entries));
	}
}

/**
 * Record a failed drain on those of `entries` still pending: each current row closes and a new version opens with the
 * same `enqueued_at` and `error` as `last_error`, so each failure is one version and the rows stay pending. A row that
 * closed meanwhile (a remote delete won) stays closed.
 */
export function failOutboxRows(unitOfWork: UnitOfWork, entries: readonly OutboxEntry[], error: string): void
{
	if (entries.length === 0)
	{
		return;
	}
	const current = unitOfWork.tx
		.select(
			{
				nodeId: outbox.nodeId,
				aspect: outbox.aspect,
				enqueuedAt: outbox.enqueuedAt,
			},
		)
		.from(outbox)
		.where(and(currentVersion(outbox), entriesWhere(entries)))
		.all();
	if (current.length === 0)
	{
		return;
	}
	closeCurrentVersions(unitOfWork.tx, outbox, unitOfWork.systemTime, entriesWhere(entries));
	const versions = current.map(({nodeId, aspect, enqueuedAt}) => (
	{
		nodeId,
		aspect,
		enqueuedAt,
		lastError: error,
		systemFrom: unitOfWork.systemTime,
		systemTo: FAR_FUTURE_DATE,
	}));
	for (let start = 0; start < versions.length; start += ROWS_PER_INSERT)
	{
		unitOfWork.tx
			.insert(outbox)
			.values(versions.slice(start, start + ROWS_PER_INSERT))
			.run();
	}
}

/** Mirror mode's outbox at a glance, for the sync status. */
export interface OutboxStatus
{
	/** Current (pending) rows. */
	pending: number;
	/** The oldest pending row's `enqueued_at`, or null when nothing is pending. */
	oldestEnqueuedAt: string | null;
	/** The newest failure still on a pending row, or null. */
	lastError: string | null;
}

export function outboxStatus(tx: TemporalTransaction): OutboxStatus
{
	const summary = tx
		.select(
			{
				pending: sql<number>`count(*)`,
				oldestEnqueuedAt: sql<string | null>`min(${outbox.enqueuedAt})`,
			},
		)
		.from(outbox)
		.where(currentVersion(outbox))
		.get();
	const failed = tx
		.select(
			{
				lastError: outbox.lastError,
			},
		)
		.from(outbox)
		.where(and(currentVersion(outbox), isNotNull(outbox.lastError)))
		.orderBy(desc(outbox.systemFrom))
		.limit(1)
		.get();
	return {
		pending: summary?.pending ?? 0,
		oldestEnqueuedAt: summary?.oldestEnqueuedAt ?? null,
		lastError: failed?.lastError ?? null,
	};
}
