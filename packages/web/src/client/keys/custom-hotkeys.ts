/** Upstream's hotkeys grammar (`u70`): `Hotkeys > [combo] > [command]` nodes become overrides of the hotkey table. */

import type {HotkeyOverride} from "./custom-overlay.js";

export interface CustomNode
{
	name: string;
	completed: boolean;
	children: CustomNode[];
}

export function parseCustomHotkeys(
	hotkeysNodes: readonly CustomNode[],
	defaults: readonly (readonly [string, string])[],
): HotkeyOverride[]
{
	// A Map keeps the first position of a combo while later sets overwrite its value, like upstream's object.
	const result = new Map<string, string | null>();
	for (const hotkeys of hotkeysNodes)
	{
		for (const combo of hotkeys.children)
		{
			if (combo.completed)
			{
				result.set(combo.name, null);
				continue;
			}
			const [first] = combo.children;
			if (first === undefined)
			{
				continue;
			}
			for (const [defaultCombo, command] of defaults)
			{
				if (command === first.name)
				{
					result.set(defaultCombo, null);
				}
			}
			result.set(combo.name, first.name);
		}
	}
	return [...result];
}
