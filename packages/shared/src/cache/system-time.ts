import {formatTemporalTimestamp} from "../temporal/constants.js";

/**
 * The system time for one unit of work: the application's UTC clock, read once.
 * Following Reladomo's per-transaction processing time, every `system_from` and
 * `system_to` a unit writes takes this one value, even when the unit spans
 * several transactions. Two units may share a millisecond and need not be
 * monotonic: a unit that lands after another but read the clock earlier is
 * normal. A unit closing a version stamped at its own millisecond fails with
 * `SameMillisecondOverwriteError` and rolls back.
 */
export function newSystemTime(): Date
{
	return new Date(Date.now());
}

/** {@link newSystemTime} formatted for a `system_from`/`system_to` column. */
export function newSystemTimestamp(): string
{
	return formatTemporalTimestamp(newSystemTime());
}

/**
 * The longest a unit of work may run between reading its system time and
 * committing. A unit that would commit later rolls back and throws, so every
 * row with a `system_from` older than `now - TRANSACTION_TIMEOUT_MS` is known
 * to be committed: a change feed can trail the clock by this lag and never
 * miss a late commit.
 */
export const TRANSACTION_TIMEOUT_MS = 60_000;

/** A unit of work that would commit after {@link TRANSACTION_TIMEOUT_MS}. */
export class TransactionTimeoutError extends Error
{
	constructor(systemTime: string, elapsedMs: number)
	{
		super(
			`Unit of work stamped ${systemTime} would commit ${elapsedMs}ms after it started, past the ${TRANSACTION_TIMEOUT_MS}ms transaction timeout; rolled back`,
		);
		this.name = "TransactionTimeoutError";
	}
}

/** A unit of work's system time with the wall-clock instant it was read, which its timeout counts from. */
export interface UnitOfWorkStart
{
	systemTime: string;
	startedAt: number;
}

/**
 * Start a unit of work: read the clock once for its system time and its start.
 * `systemTime` overrides the stamp (tests, replays) without moving the start.
 */
export function startUnitOfWork(systemTime?: Date): UnitOfWorkStart
{
	const startedAt = Date.now();
	return {
		systemTime: formatTemporalTimestamp(systemTime ?? new Date(startedAt)),
		startedAt,
	};
}

function elapsedSince(start: UnitOfWorkStart): number
{
	return Date.now() - start.startedAt;
}

/** Throw {@link TransactionTimeoutError} when the unit has run past the timeout. Call it right before commit. */
export function assertWithinTransactionTimeout(start: UnitOfWorkStart): void
{
	const elapsed = elapsedSince(start);
	if (elapsed > TRANSACTION_TIMEOUT_MS)
	{
		throw new TransactionTimeoutError(start.systemTime, elapsed);
	}
}

/** An AbortSignal for an upstream fetch inside the unit, aborting when the unit's remaining time runs out. */
export function unitOfWorkSignal(start: UnitOfWorkStart): AbortSignal
{
	const controller = new AbortController();
	const remaining = TRANSACTION_TIMEOUT_MS - elapsedSince(start);
	const abort = () =>
	{
		controller.abort(new TransactionTimeoutError(start.systemTime, elapsedSince(start)));
	};
	if (remaining <= 0)
	{
		abort();
	}
	else
	{
		const timer: unknown = setTimeout(abort, remaining);
		// Node would otherwise stay alive until the timer fires; Workers return a plain number.
		if (isUnrefable(timer))
		{
			timer.unref();
		}
	}
	return controller.signal;
}

function isUnrefable(timer: unknown): timer is
{
	unref: () => void;
}
{
	return typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function";
}
