/**
 * Converts a Workflowy backup timestamp to a Unix timestamp.
 * Backup files store timestamps as seconds since the user's account creation (epoch).
 *
 * The epoch is the user's `dateJoinedTimestampInSeconds` from the Workflowy internal API.
 * It can be fetched using the WorkflowyInternalClient or calculated from API and backup data.
 *
 * @param backupTimestamp - The timestamp from the backup file (relative to epoch)
 * @param epoch - The user's epoch (Unix timestamp of account creation). Required.
 */
export function backupToUnixTime(backupTimestamp: number, epoch: number): number
{
	return backupTimestamp + epoch;
}

/**
 * Converts a Unix timestamp to a Workflowy backup timestamp.
 * Backup files store timestamps as seconds since the user's account creation (epoch).
 *
 * @param unixTimestamp - The Unix timestamp to convert
 * @param epoch - The user's epoch (Unix timestamp of account creation). Required.
 */
export function unixToBackupTime(unixTimestamp: number, epoch: number): number
{
	return unixTimestamp - epoch;
}

/**
 * Calculates the user's Workflowy epoch from API and backup timestamps.
 * This should be done once when setting up for a new user.
 *
 * @param apiCreatedAt - Unix timestamp from the Workflowy API
 * @param backupCt - Relative timestamp from the backup file
 * @returns The user's epoch (Unix timestamp of account creation)
 */
export function calculateWorkflowyEpoch(apiCreatedAt: number, backupCt: number): number
{
	return apiCreatedAt - backupCt;
}

/**
 * Converts a Workflowy node UUID to a short URL ID.
 * Workflowy URLs use the last 12 characters of the UUID (without hyphens).
 * Example: "3435cb92-d00d-45be-9950-b1ed4735574c" → "b1ed4735574c"
 */
export function uuidToShortId(uuid: string): string
{
	const withoutHyphens = uuid.replaceAll("-", "");
	return withoutHyphens.slice(-12);
}

/**
 * Whether a value is a Workflowy short ID: exactly 12 hex characters, as it
 * appears in a Workflowy URL. Reads accept a short ID and resolve it to a full
 * UUID; full UUIDs (with hyphens) are not short IDs.
 */
export function isShortId(value: string): boolean
{
	return /^[\da-f]{12}$/iu.test(value);
}

/**
 * Generates a Workflowy deep link URL for a node.
 * Example: "3435cb92-d00d-45be-9950-b1ed4735574c" → "https://workflowy.com/#/b1ed4735574c"
 */
export function getWorkflowyUrl(nodeId: string): string
{
	return `https://workflowy.com/#/${uuidToShortId(nodeId)}`;
}

/**
 * Formats a date as a Workflowy native date using bracket syntax.
 * Workflowy automatically converts [YYYY-MM-DD] to clickable, filterable date elements.
 *
 * Example output: [2025-12-26]
 *
 * @param date - Date object, or YYYY-MM-DD string (defaults to today)
 * @returns Bracket-formatted date string that Workflowy converts to native date
 */
export function formatWorkflowyDate(date: Date | string = new Date()): string
{
	let dateObj: Date;

	if (typeof date === "string")
	{
		// Parse YYYY-MM-DD string as local date (not UTC)
		const [year, month, day] = date.split("-").map(Number);
		if (year === undefined || month === undefined || day === undefined)
		{
			throw new Error(`Invalid date "${date}": expected YYYY-MM-DD`);
		}
		dateObj = new Date(year, month - 1, day);
	}
	else
	{
		dateObj = date;
	}

	const year = dateObj.getFullYear();
	const month = String(dateObj.getMonth() + 1).padStart(2, "0");
	const day = String(dateObj.getDate()).padStart(2, "0");

	return `[${year}-${month}-${day}]`;
}

/**
 * Formats a date and time as a Workflowy native datetime using bracket syntax.
 * Workflowy automatically converts [YYYY-MM-DD HH:MM] to clickable, filterable datetime elements.
 *
 * Example output: [2025-12-26 14:30]
 *
 * @param date - Date object, or ISO datetime string (defaults to now)
 * @returns Bracket-formatted datetime string that Workflowy converts to native datetime
 */
export function formatWorkflowyDateTime(date: Date | string = new Date()): string
{
	const dateObj: Date = typeof date === "string" ? new Date(date) : date;

	const year = dateObj.getFullYear();
	const month = String(dateObj.getMonth() + 1).padStart(2, "0");
	const day = String(dateObj.getDate()).padStart(2, "0");
	const hours = String(dateObj.getHours()).padStart(2, "0");
	const minutes = String(dateObj.getMinutes()).padStart(2, "0");

	return `[${year}-${month}-${day} ${hours}:${minutes}]`;
}
