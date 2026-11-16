import {formatTemporalTimestamp} from "../temporal/constants.js";

const IS_WORKERS = globalThis.navigator.userAgent === "Cloudflare-Workers";

/**
 * The wall clock in whole microseconds since the epoch. Node reads its highest-resolution wall clock. Workers'
 * clock is millisecond-resolution and frozen for the whole request (a Spectre mitigation), so there every read
 * within one request is the same `Date.now() * 1000`.
 */
export function readWallClockMicros(): number
{
	if (IS_WORKERS)
	{
		return Date.now() * 1000;
	}
	return Math.floor((performance.timeOrigin + performance.now()) * 1000);
}

/** The clock system times are read from. Tests swap `readMicros` to follow a faked `Date`; production never does. */
export const systemClock =
{
	readMicros: readWallClockMicros,
};

/**
 * The system time for one unit of work: the application's UTC clock in microseconds, read once.
 * Following Reladomo's per-transaction processing time, every `system_from` and
 * `system_to` a unit writes takes this one value, even when the unit spans
 * several transactions. Two units may share a microsecond and need not be
 * monotonic: a unit that lands after another but read the clock earlier is
 * normal. A unit closing a version stamped at its own microsecond fails with
 * `SameMicrosecondOverwriteError` and rolls back.
 */
export function newSystemTimestamp(): number
{
	return systemClock.readMicros();
}

/**
 * The longest a unit of work may run between reading its system time and
 * committing. A unit that would commit later rolls back and throws, so every
 * row with a `system_from` older than `now - TRANSACTION_TIMEOUT_MS` is known
 * to be committed: a change feed can trail the clock by this lag and never
 * miss a late commit.
 */
export const TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * The longest a bulk import (a whole backup or API snapshot, one atomic unit
 * under one system time) may run between taking its lease and committing.
 * While its lease is open, change-feed watermarks stop just before the lease,
 * so its rows, stamped after the lease, cannot fall behind a watermark.
 */
export const BULK_IMPORT_TIMEOUT_MS = 15 * 60_000;

/** A unit of work that would commit after its timeout, {@link TRANSACTION_TIMEOUT_MS} unless it is a bulk import. */
export class TransactionTimeoutError extends Error
{
	constructor(systemTime: number, elapsedMs: number, timeoutMs = TRANSACTION_TIMEOUT_MS)
	{
		super(
			`Unit of work stamped ${systemTime} would commit ${elapsedMs}ms after it started, past the ${timeoutMs}ms transaction timeout; rolled back`,
		);
		this.name = "TransactionTimeoutError";
	}
}

/** A unit of work's system time with the wall-clock instant it was read, which its timeout counts from. */
export interface UnitOfWorkStart
{
	systemTime: number;
	/** `Date.now()` milliseconds: the timeout counts in wall-clock milliseconds, not system-time microseconds. */
	startedAt: number;
}

/**
 * Start a unit of work: read the clock once for its system time and its start.
 * `systemTime` overrides the stamp (tests, replays) without moving the start.
 */
export function startUnitOfWork(systemTime?: Date | number): UnitOfWorkStart
{
	const startedAt = Date.now();
	return {
		systemTime: systemTime === undefined ? newSystemTimestamp() : toSystemTime(systemTime),
		startedAt,
	};
}

function toSystemTime(time: Date | number): number
{
	return typeof time === "number" ? time : formatTemporalTimestamp(time);
}

function elapsedSince(start: UnitOfWorkStart): number
{
	return Date.now() - start.startedAt;
}

/** Throw {@link TransactionTimeoutError} when the unit has run past `timeoutMs`. Call it right before commit. */
export function assertWithinTransactionTimeout(start: UnitOfWorkStart, timeoutMs = TRANSACTION_TIMEOUT_MS): void
{
	const elapsed = elapsedSince(start);
	if (elapsed > timeoutMs)
	{
		throw new TransactionTimeoutError(start.systemTime, elapsed, timeoutMs);
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
