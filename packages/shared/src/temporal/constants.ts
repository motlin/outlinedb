/**
 * The far future date used to indicate current/active records in temporal tables.
 * Records with systemTo set to this value are considered "current".
 */
export const FAR_FUTURE_DATE = "9999-12-31 23:59:59";

/**
 * Checks if a record is current based on its systemTo timestamp.
 * Current records have systemTo set to FAR_FUTURE_DATE.
 */
export function isCurrentRecord(systemTo: string): boolean
{
	return systemTo === FAR_FUTURE_DATE;
}

/**
 * Formats a Date object as a temporal timestamp string with millisecond precision.
 * Format: 'YYYY-MM-DD HH:MM:SS.sss' (ISO8601 without timezone)
 */
export function formatTemporalTimestamp(date: Date): string
{
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	const seconds = String(date.getUTCSeconds()).padStart(2, "0");
	const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");

	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}
