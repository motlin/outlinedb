const DURATION_REGEX = /^(\d+)([smhdw])$/u;

const UNIT_MS: Record<string, number> =
{
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

export function parseSince(since: string): Date
{
	const match = DURATION_REGEX.exec(since);
	const [, digits, unit] = match ?? [];
	const unitMs = unit === undefined ? undefined : UNIT_MS[unit];
	if (digits !== undefined && unitMs !== undefined)
	{
		return new Date(Date.now() - Number(digits) * unitMs);
	}

	const parsed = new Date(since);
	if (Number.isNaN(parsed.getTime()))
	{
		throw new TypeError(
			`Invalid --since value: "${since}". Use a duration (1d, 12h, 1w) or an ISO date (2026-02-01).`,
		);
	}
	return parsed;
}
