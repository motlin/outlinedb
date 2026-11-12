// Item-menu footer timestamps ("Changed:" / "Created:"), formatted with the account's date and time formats.
import {formatAccountTimestamp} from "@outlinedb/shared";

export function formatMenuTimestamp(
	unixSeconds: number,
	now: Date,
	formats:
	{
		dateFormat: string;
		timeFormat: string;
	},
): string
{
	return formatAccountTimestamp(new Date(unixSeconds * 1000), now, formats);
}
