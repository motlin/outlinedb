/**
 * Parse a user-supplied string as a finite number, rejecting what `Number`
 * silently accepts (blank → 0) and what `parseInt` silently truncates ("12px" → 12).
 */
export function parseStrictNumber(value: string): number | undefined
{
	if (value.trim() === "")
	{
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseStrictInteger(value: string): number | undefined
{
	const parsed = parseStrictNumber(value);
	return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}
