/** The local YYYY-MM-DD date of `date`. */
export function localIsoDate(date: Date): string
{
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** The local YYYY-MM-DD date `days` calendar days before `now`. */
export function localLookbackCutoff(now: Date, days: number): string
{
	return localIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}
