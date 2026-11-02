/** Treat an empty string as absent, so `??` falls through it the way `||` would. */
export function nonEmpty(value: string | null | undefined): string | undefined
{
	return value === "" || value === null ? undefined : value;
}
