// Shared argv handling for the review scripts.

/**
 * The value that follows `flag` on the command line. Pass the same iterator the caller's
 * `for...of` loop consumes, so the value is skipped rather than read again as a flag.
 */
export function takeValue(args: Iterator<string>, flag: string): string
{
	const next = args.next();
	if (next.done === true)
	{
		throw new Error(`Missing value for ${flag}`);
	}
	return next.value;
}
