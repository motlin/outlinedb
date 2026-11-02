import {createHash} from "node:crypto";

/** The namespace upstream's `WF.Id.uuidv5` hashes every deterministic node id in. */
export const CALENDAR_ID_NAMESPACE = "3e19dffe-1c3b-4d76-8e57-0de20e69bdae";

/** A calendar level with a deterministic node id. */
export type CalendarIdLevel = "day" | "week" | "month" | "year";

/** RFC 4122 version 5 (SHA-1, name-based) uuid of `name` in `namespace`. */
export function uuidv5(name: string, namespace: string): string
{
	const hash = createHash("sha1")
		.update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
		.update(name, "utf8")
		.digest();
	hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
	hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
	const hex = hash.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The id upstream gives a calendar level node:
 * `WF.Id.uuidv5(\`calendar-${level}-${dateId}\`)`, which prefixes the user's
 * `entropyKey` (from `/get_user_data/`) before hashing. A week (`DC1`) is
 * `calendar-week-${year}-${dateId}`, where `year` is the year of the date the
 * week was made for, not of its first day.
 */
export function calendarNodeId(entropyKey: string, level: CalendarIdLevel, dateId: number, year?: number): string
{
	if (level !== "week")
	{
		return uuidv5(`${entropyKey}-calendar-${level}-${dateId}`, CALENDAR_ID_NAMESPACE);
	}
	if (year === undefined)
	{
		throw new RangeError("a week node id needs the year of its date");
	}
	return uuidv5(`${entropyKey}-calendar-week-${year}-${dateId}`, CALENDAR_ID_NAMESPACE);
}
