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

const READABLE_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/u;

/**
 * The stored `system_from`/`system_to` value for the UTC instant written as `YYYY-MM-DD HH:MM:SS[.ffffff]`, or as
 * the ISO text {@link systemTimeToIso} prints (`YYYY-MM-DDTHH:MM:SS[.ffffff]Z`). Tests build every system time
 * through this, and `cache temporal-rollback` parses its target with it.
 */
export function systemTimeAt(text: string): number
{
	const match = READABLE_UTC.exec(text);
	if (match === null)
	{
		throw new Error(`Not a UTC system time: ${text}`);
	}
	const [, day = "", seconds = "", fraction = ""] = match;
	return Date.parse(`${day}T${seconds}Z`) * 1000 + Number(fraction.padEnd(6, "0"));
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

/**
 * A stored system time as ISO 8601 UTC text with all six microsecond digits (`2026-01-02T03:04:05.123456Z`): how
 * people and JSON clients see one.
 */
export function systemTimeToIso(timestamp: number): string
{
	const millis = Math.floor(timestamp / 1000);
	const micros = String(timestamp - millis * 1000).padStart(3, "0");
	return `${new Date(millis).toISOString().slice(0, -1)}${micros}Z`;
}

/**
 * A `JSON.stringify` replacer that renders every `systemFrom`/`systemTo` number as {@link systemTimeToIso} text, and
 * a current version's `systemTo` ({@link FAR_FUTURE_DATE}) as null, since the sentinel is not a real instant.
 */
export function systemTimesAsIso(key: string, value: unknown): unknown
{
	if ((key !== "systemFrom" && key !== "systemTo") || typeof value !== "number")
	{
		return value;
	}
	return key === "systemTo" && isCurrentRecord(value) ? null : systemTimeToIso(value);
}

/** The system time one tick (one microsecond) before `timestamp`: reading as of it sees the rows a unit at `timestamp` replaced. */
export function temporalTimestampJustBefore(timestamp: number): number
{
	return timestamp - 1;
}
