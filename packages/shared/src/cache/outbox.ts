import {and, asc, desc, eq, isNotNull, isNull, lte, sql} from "drizzle-orm";
import {alias} from "drizzle-orm/sqlite-core";
import type {SQL} from "drizzle-orm";
import {mirrors, nodeContent, outbox} from "../db/schema.js";
import {accountOutboxStatus} from "./account-outbox.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {currentVersion, currentVersionLiteral} from "./cache-temporal.js";
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

/** Durable Object SQLite caps a statement at 100 bound parameters; an outbox row binds 7. */
const ROWS_PER_INSERT = 14;

/** Current rows a push reply left out, written as the literal predicate of `outbox_left_out_idx`. */
const leftOutLiteral = sql`${outbox.systemTo} = ${sql.raw(String(FAR_FUTURE_DATE))} AND ${outbox.leftOutOp} IS NOT NULL`;

export interface OutboxEntry
{
	nodeId: string;
	aspect: OutboxAspect;
}

/**
 * Records which aspects of which nodes a unit of work left ahead of workflowy.com, as current `outbox` rows in that
 * same unit of work. An aspect that already has a current row keeps it, so a burst of edits coalesces into one row
 * whose `enqueued_at` is the first pending write. A flagged row (a push reply left its op out) opens a new unflagged
 * version with the same `enqueued_at`, so the drain sends the new write. `entries` must not repeat a node and aspect.
 */
export class OutboxRecorder
{
	record({tx, systemTime}: UnitOfWork, entries: readonly OutboxEntry[]): void
	{
		if (entries.length === 0)
		{
			return;
		}
		const current = new Map(
			currentRows(tx, [...new Set(entries.map(({nodeId}) => nodeId))]).map((row) => [entryKey(row), row]),
		);
		const written = new Set(entries.map(entryKey));
		const rearmed = [...current.values()].filter((row) => row.leftOutOp !== null && written.has(entryKey(row)));
		if (rearmed.length > 0)
		{
			closeCurrentVersions(tx, outbox, systemTime, entriesWhere(rearmed));
		}
		const rows = [
			...rearmed.map(({nodeId, aspect, enqueuedAt}) => (
			{
				nodeId,
				aspect,
				enqueuedAt,
			})),
			...entries
				.filter((entry) => !current.has(entryKey(entry)))
				.map(({nodeId, aspect}) => (
				{
					nodeId,
					aspect,
					enqueuedAt: systemTime,
				})),
		].map((row) => (
		{
			...row,
			lastError: null,
			leftOutOp: null,
			systemFrom: systemTime,
			systemTo: FAR_FUTURE_DATE,
		}));
		insertVersions(tx, rows);
	}
}

const entryKey = ({nodeId, aspect}: {nodeId: string; aspect: string}): string => `${nodeId}\u001F${aspect}`;

function insertVersions(tx: TemporalTransaction, rows: readonly (typeof outbox.$inferInsert)[]): void
{
	for (let start = 0; start < rows.length; start += ROWS_PER_INSERT)
	{
		tx.insert(outbox)
			.values(rows.slice(start, start + ROWS_PER_INSERT))
			.run();
	}
}

/** Whether any outbox row is current, read as one row of the partial pending index. */
function anyCurrent(tx: TemporalTransaction): boolean
{
	return (
		tx
			.select(
				{
					one: sql`1`,
				},
			)
			.from(outbox)
			.where(currentVersionLiteral(outbox))
			.limit(1)
			.get() !== undefined
	);
}

/** The current outbox rows of `nodeIds`, flagged or not. */
function currentRows(
	tx: TemporalTransaction,
	nodeIds: readonly string[],
):
{
	nodeId: string;
	aspect: string;
	enqueuedAt: number;
	leftOutOp: string | null;
}[]
{
	// Usually nothing is pending: one row of the partial pending index says so, where probing every id reads two each.
	if (nodeIds.length === 0 || !anyCurrent(tx))
	{
		return [];
	}
	return tx
		.select(
			{
				nodeId: outbox.nodeId,
				aspect: outbox.aspect,
				enqueuedAt: outbox.enqueuedAt,
				leftOutOp: outbox.leftOutOp,
			},
		)
		.from(outbox)
		.where(and(inIds(outbox.nodeId, nodeIds), currentVersion(outbox)))
		.all();
}

/** The pending (current, flagged or not) outbox aspects of each of `nodeIds` that has any, in one set-based read. */
export function pendingAspects(tx: TemporalTransaction, nodeIds: readonly string[]): Map<string, Set<OutboxAspect>>
{
	const pending = new Map<string, Set<OutboxAspect>>();
	for (const {nodeId, aspect} of currentRows(tx, nodeIds))
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
	enqueuedAt: number;
	lastError: string | null;
}

/** Where `(node_id, aspect)` is one of `entries`, bound as one JSON parameter. */
function entriesWhere(
	entries: readonly
	{
		nodeId: string;
		aspect: string;
	}[],
): SQL
{
	const keys = entries.map(({nodeId, aspect}) => `${nodeId}\u001F${aspect}`);
	return sql`(${outbox.nodeId} || char(31) || ${outbox.aspect}) IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`;
}

/**
 * The current outbox rows of the oldest pending writes the drain sends (never a flagged row): about `cap` rows, rounded
 * up to whole enqueue times, so the rows one unit of work recorded are read together. Oldest first.
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
		.where(and(currentVersionLiteral(outbox), isNull(outbox.leftOutOp)))
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
			and(
				currentVersionLiteral(outbox),
				isNull(outbox.leftOutOp),
				cutoff === undefined ? undefined : lte(outbox.enqueuedAt, cutoff.enqueuedAt),
			),
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
 * Record a failed drain on those of `entries` still pending: each current row whose `last_error` differs closes and a
 * new version opens with the same `enqueued_at` and `error` as `last_error`, so the rows stay pending. A row already
 * carrying this error is left as it is, so a drain failing the same way on every attempt writes nothing more. A row
 * that closed meanwhile (a remote delete won) stays closed.
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
		.where(and(currentVersion(outbox), entriesWhere(entries), sql`${outbox.lastError} IS NOT ${error}`))
		.all();
	if (current.length === 0)
	{
		return;
	}
	closeCurrentVersions(unitOfWork.tx, outbox, unitOfWork.systemTime, entriesWhere(current));
	insertVersions(
		unitOfWork.tx,
		current.map(({nodeId, aspect, enqueuedAt}) => (
		{
			nodeId,
			aspect,
			enqueuedAt,
			lastError: error,
			leftOutOp: null,
			systemFrom: unitOfWork.systemTime,
			systemTo: FAR_FUTURE_DATE,
		})),
	);
}

/** A pending row to flag: the op a push reply left out, and why, as its `last_error`. */
export interface LeftOutEntry extends OutboxEntry
{
	leftOutOp: string;
	message: string;
}

/**
 * Flag `entries`' current rows, which a push reply left out: each closes and a new version opens with the same
 * `enqueued_at`, `left_out_op` and the message as `last_error`, so the drain stops sending it and it stays open until
 * {@link closeOutboxRows} settles it or a new local write re-arms it.
 */
export function flagOutboxRows(unitOfWork: UnitOfWork, entries: readonly LeftOutEntry[]): void
{
	if (entries.length === 0)
	{
		return;
	}
	const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
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
	closeCurrentVersions(unitOfWork.tx, outbox, unitOfWork.systemTime, entriesWhere(current));
	insertVersions(
		unitOfWork.tx,
		current.flatMap(({nodeId, aspect, enqueuedAt}) =>
		{
			const entry = byKey.get(
				entryKey(
					{
						nodeId,
						aspect,
					},
				),
			);
			return entry === undefined
				? []
				: [
						{
							nodeId,
							aspect,
							enqueuedAt,
							lastError: entry.message,
							leftOutOp: entry.leftOutOp,
							systemFrom: unitOfWork.systemTime,
							systemTo: FAR_FUTURE_DATE,
						},
					];
		}),
	);
}

/** A current row a push reply left out. */
export interface LeftOutRow extends OutboxEntry
{
	leftOutOp: string;
}

/** Every flagged row, through the partial index of flagged rows: none read when nothing is flagged. */
export function readLeftOutRows(tx: TemporalTransaction): LeftOutRow[]
{
	const rows = tx
		.select(
			{
				nodeId: outbox.nodeId,
				aspect: outbox.aspect,
				leftOutOp: sql<string>`${outbox.leftOutOp}`,
			},
		)
		.from(outbox)
		.where(leftOutLiteral)
		.all();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the recorder writes only OutboxAspect values
	return rows as LeftOutRow[];
}

/** Mirror mode's outbox at a glance (node and account rows), for the sync status. */
export interface OutboxStatus
{
	/** Current rows the drain sends. */
	pending: number;
	/** Current rows a push reply left out: no longer sent, open until a catch-up shows their op or a new write. */
	flagged: number;
	/** The oldest pending row's `enqueued_at`, or null when nothing is pending. */
	oldestEnqueuedAt: number | null;
	/** The newest failure still on a pending row, or null. */
	lastError: string | null;
}

export function outboxStatus(tx: TemporalTransaction): OutboxStatus
{
	const summary = tx
		.select(
			{
				pending: sql<number>`count(*)`,
				oldestEnqueuedAt: sql<number | null>`min(${outbox.enqueuedAt})`,
			},
		)
		.from(outbox)
		.where(and(currentVersionLiteral(outbox), isNull(outbox.leftOutOp)))
		.get();
	const failed = tx
		.select(
			{
				lastError: outbox.lastError,
				systemFrom: outbox.systemFrom,
			},
		)
		.from(outbox)
		.where(and(currentVersionLiteral(outbox), isNull(outbox.leftOutOp), isNotNull(outbox.lastError)))
		.orderBy(desc(outbox.systemFrom))
		.limit(1)
		.get();
	const account = accountOutboxStatus(tx);
	const oldest = [summary?.oldestEnqueuedAt ?? null, account.oldestEnqueuedAt]
		.filter((at) => at !== null)
		.toSorted((a, b) => a - b);
	const accountFailedLater =
		account.lastErrorAt !== null && (failed === undefined || account.lastErrorAt > failed.systemFrom);
	return {
		pending: (summary?.pending ?? 0) + account.pending,
		flagged: flaggedOutboxCount(tx),
		oldestEnqueuedAt: oldest[0] ?? null,
		lastError: accountFailedLater ? account.lastError : (failed?.lastError ?? null),
	};
}

/** How many current rows a push reply left out, counted through the partial index of flagged rows alone. */
export function flaggedOutboxCount(tx: TemporalTransaction): number
{
	return (
		tx
			.select(
				{
					count: sql<number>`count(*)`,
				},
			)
			.from(outbox)
			.where(leftOutLiteral)
			.get()?.count ?? 0
	);
}

/**
 * One pending outbox row with its node's current name (null once the node's content version has ended);
 * a mirror, whose own name is empty, shows its original's.
 */
export interface PendingOutboxListing extends PendingOutboxRow
{
	name: string | null;
	/** The op a push reply left out on a flagged row, or null. */
	leftOutOp: string | null;
}

/** Every current outbox row with its node's current name, oldest first, for `outbox status`. */
export function listPendingOutbox(tx: TemporalTransaction): PendingOutboxListing[]
{
	const original = alias(nodeContent, "original");
	const rows = tx
		.select(
			{
				nodeId: outbox.nodeId,
				name: sql<string | null>`coalesce(${original.name}, ${nodeContent.name})`,
				aspect: outbox.aspect,
				enqueuedAt: outbox.enqueuedAt,
				lastError: outbox.lastError,
				leftOutOp: outbox.leftOutOp,
			},
		)
		.from(outbox)
		.leftJoin(nodeContent, and(eq(nodeContent.id, outbox.nodeId), currentVersion(nodeContent)))
		.leftJoin(mirrors, and(eq(mirrors.mirrorId, outbox.nodeId), currentVersion(mirrors)))
		.leftJoin(original, and(eq(original.id, mirrors.originalId), currentVersion(original)))
		.where(currentVersion(outbox))
		.orderBy(asc(outbox.enqueuedAt), asc(outbox.nodeId), asc(outbox.aspect))
		.all();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the recorder writes only OutboxAspect values
	return rows as PendingOutboxListing[];
}
