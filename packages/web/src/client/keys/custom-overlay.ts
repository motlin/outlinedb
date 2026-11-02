/**
 * Upstream's `WF.Custom.customized` overlay for the hotkey table: custom entries come first in insertion order, a
 * `null` value disables a combo (even a default), and every default whose combo is not overridden follows.
 */

export type HotkeyOverride = [combo: string, command: string | null];

export function overlayHotkeys(
	defaults: readonly (readonly [string, string])[],
	overrides: readonly HotkeyOverride[],
): HotkeyOverride[]
{
	const overridden = new Set(overrides.map(([combo]) => combo));
	return [
		...overrides.map(([combo, command]): HotkeyOverride => [combo, command]),
		...defaults
			.filter(([combo]) => !overridden.has(combo))
			.map(([combo, command]): HotkeyOverride => [combo, command]),
	];
}

/** The command bound to a combo; a disabled (null) or unknown combo is undefined. */
export function lookup(table: readonly (readonly [string, string | null])[], combo: string): string | undefined
{
	return table.find(([bound]) => bound === combo)?.[1] ?? undefined;
}

/** Upstream's `sg4`: the first combo bound to the command. */
export function hintFrom(table: readonly (readonly [string, string | null])[], command: string): string | undefined
{
	return table.find(([, bound]) => bound === command)?.[0];
}
