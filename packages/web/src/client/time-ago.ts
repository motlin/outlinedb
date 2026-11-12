// Port of upstream's GV2 time-ago formatter and its KY autosave status text (main menu footer).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, unit: string): string
{
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function timeAgo(ms: number): string
{
	const elapsed = Math.max(0, ms);
	if (elapsed < MINUTE)
	{
		return "just now";
	}
	if (elapsed < HOUR)
	{
		return plural(Math.floor(elapsed / MINUTE), "minute");
	}
	if (elapsed < DAY)
	{
		return plural(Math.floor(elapsed / HOUR), "hour");
	}
	return plural(Math.floor(elapsed / DAY), "day");
}

/** Local writes go straight to the server, so once nothing is in flight the outline is synced ("Autosaved"). */
export function autosaveText({saving, lastSavedAt, now}: {saving: boolean; lastSavedAt: number; now: number}): string
{
	if (saving)
	{
		return "Saving...";
	}
	const ago = timeAgo(now - lastSavedAt);
	return `Autosaved: ${ago.charAt(0).toUpperCase()}${ago.slice(1)}`;
}
