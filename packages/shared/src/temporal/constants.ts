/**
 * The `system_to` of a current row in a temporal table. System times are integer microseconds since the epoch;
 * 9999-12-31 in microseconds exceeds 2^53, so the sentinel is the largest integer a JavaScript number holds exactly
 * (9007199254740991 µs, 2255-06-05).
 */
export const FAR_FUTURE_DATE = Number.MAX_SAFE_INTEGER;

/**
 * Checks if a record is current based on its systemTo timestamp.
 * Current records have systemTo set to FAR_FUTURE_DATE.
 */
export function isCurrentRecord(systemTo: number): boolean
{
	return systemTo === FAR_FUTURE_DATE;
}

const READABLE_UTC = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/u;

/**
 * The stored `system_from`/`system_to` value for the UTC instant written as `YYYY-MM-DD HH:MM:SS[.ffffff]`.
 * Tests build every system time through this, and `cache temporal-rollback` parses its target with it.
 */
export function systemTimeAt(text: string): number
{
	const match = READABLE_UTC.exec(text);
	if (match === null)
	{
		throw new Error(`Not a UTC system time: ${text}`);
	}
	const [, seconds = "", fraction = ""] = match;
	return Date.parse(`${seconds.replace(" ", "T")}Z`) * 1000 + Number(fraction.padEnd(6, "0"));
}

/** The stored system time of a Date: its milliseconds as microseconds since the epoch. */
export function formatTemporalTimestamp(date: Date): number
{
	return date.getTime() * 1000;
}

/** Parses a stored `system_from`/`system_to` value (microseconds since the epoch) as a UTC instant, floored to the millisecond. */
export function parseTemporalTimestamp(timestamp: number): Date
{
	return new Date(Math.floor(timestamp / 1000));
}

/** The system time one tick (one microsecond) before `timestamp`: reading as of it sees the rows a unit at `timestamp` replaced. */
export function temporalTimestampJustBefore(timestamp: number): number
{
	return timestamp - 1;
}
