/**
 * Upstream's hotkey hint formatter: turns a command's first combo into the chip text shown in the hotkeys panel.
 */

import {buildHotkeys} from "./keymap.js";
import type {Hotkey} from "./keymap.js";
import {hintFrom, overlayHotkeys} from "./custom-overlay.js";
import {useCustomKeymapStore} from "../stores/custom-keymap.js";

/** The mac `[combo, command]` table in upstream insertion order, using upstream combo spelling. */
export const MAC_HOTKEYS: readonly Hotkey[] = buildHotkeys(
	{
		mac: true,
		safari: false,
		windows: false,
		linux: false,
		chromeos: false,
		electron: false,
	},
);

const OFF_MAC_HOTKEYS: readonly Hotkey[] = buildHotkeys(
	{
		mac: false,
		safari: false,
		windows: true,
		linux: false,
		chromeos: false,
		electron: false,
	},
);

/** The `[combo, command]` table `hint` searches for one platform flag. */
function hotkeysFor(isMac: boolean): readonly Hotkey[]
{
	return isMac ? MAC_HOTKEYS : OFF_MAC_HOTKEYS;
}

const MAC_KEYS: Readonly<Record<string, string>> =
{
	meta: "⌘",
	ctrl: "⌃",
	alt: "⌥",
	shift: "⇧",
	backspace: "⌫",
	enter: "↵",
	return: "↵",
	tab: "⇥",
	space: "Space",
	down: "↓",
	up: "↑",
	left: "←",
	right: "→",
};

const OTHER_KEYS: Readonly<Record<string, string>> =
{
	meta: "",
	ctrl: "Ctrl",
	alt: "Alt",
	shift: "Shift",
	backspace: "Backspace",
	enter: "Enter",
	return: "Enter",
	tab: "Tab",
	space: "Space",
	down: "↓",
	up: "↑",
	left: "←",
	right: "→",
};

export function hint(command: string, isMac = true): string | undefined
{
	const {overrides} = useCustomKeymapStore.getState();
	const combo = hintFrom(
		overrides.length > 0 ? overlayHotkeys(hotkeysFor(isMac), overrides) : hotkeysFor(isMac),
		command,
	);
	if (combo === undefined)
	{
		return undefined;
	}
	const keys = isMac ? MAC_KEYS : OTHER_KEYS;
	return combo
		.replace("meta+shift", "shift+meta")
		.split("+")
		.map((part) => keys[part] ?? part.toUpperCase())
		.join(isMac ? "" : "+");
}
