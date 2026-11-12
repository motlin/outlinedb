// Shared parsing for the YYYY-MM-DD dates every review script passes around.

export interface DateParts
{
	year: number;
	/** 1-based month. */
	month: number;
	day: number;
}

/** Split a YYYY-MM-DD string into numeric parts, or throw when it is not one. */
export function parseIsoDate(iso: string): DateParts
{
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
	if (!match)
	{
		throw new Error(`Expected a YYYY-MM-DD date, got: ${iso}`);
	}
	return {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
	};
}
