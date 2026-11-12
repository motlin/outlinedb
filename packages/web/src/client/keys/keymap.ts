/**
 * Upstream's hotkey table (`s70()` populating `WF.map.Hotkeys`) and its event-to-combo canonicalizer (`qY`).
 * Combos are `alt+ctrl+meta+shift+<key>` strings; the table maps each combo to a command name.
 */

export interface Platform
{
	mac: boolean;
	safari: boolean;
	windows: boolean;
	linux: boolean;
	chromeos: boolean;
	electron: boolean;
}

export type Hotkey = [combo: string, command: string];

/**
 * The ordered `[combo, command]` table for one platform. Like upstream's object, a later assignment to a combo
 * replaces its command but keeps the combo's first position, and a deleted combo re-added moves to the end.
 * Upstream's dev-only `localhost:8000` bindings are left out.
 */
export function buildHotkeys({mac, safari, windows, linux, chromeos, electron}: Platform): Hotkey[]
{
	const keys = new Map<string, string>();
	const bind = (combo: string, command: string): void =>
	{
		keys.set(combo, command);
	};
	const byPlatform = (macCombo: string, otherCombo: string, command: string): void =>
	{
		bind(mac ? macCombo : otherCombo, command);
	};

	byPlatform("meta+shift+backspace", "ctrl+shift+backspace", "delete");
	byPlatform("meta+shift+8", "ctrl+shift+8", "star_current_item");
	byPlatform("meta+return", "ctrl+return", "complete");
	byPlatform("meta+shift+d", "alt+shift+d", "duplicate");
	byPlatform("meta+shift+m", "alt+shift+m", "mirror");
	byPlatform("meta+shift+l", "alt+shift+l", "copy_link");
	if (mac)
	{
		bind("meta+s", "save_and_sync");
		bind("meta+z", "undo");
		bind("meta+y", "redo");
		bind("meta+shift+z", "redo");
	}
	bind("ctrl+s", "save_and_sync");
	bind("ctrl+z", "undo");
	bind("ctrl+y", "redo");
	bind("ctrl+shift+z", "redo");

	if (mac)
	{
		bind(safari ? "meta+shift+." : "meta+.", "zoom_in");
		bind("ctrl+right", "zoom_in");
		bind("ctrl+.", "zoom_in");
		bind(safari ? "meta+." : "meta+shift+.", "zoom_in");
		bind("ctrl+meta+shift+.", "zoom_in");
		bind("ctrl+shift+.", "zoom_in");
		bind(safari ? "meta+shift+," : "meta+,", "zoom_out");
		bind("ctrl+left", "zoom_out");
		bind("ctrl+,", "zoom_out");
		bind(safari ? "meta+," : "meta+shift+,", "zoom_out");
		bind("ctrl+meta+shift+,", "zoom_out");
	}
	else
	{
		bind("alt+down", "zoom_in");
		bind("alt+.", "zoom_in");
		bind("alt+meta+shift+.", "zoom_in");
		bind("alt+shift+.", "zoom_in");
		bind("alt+up", "zoom_out");
		bind("alt+,", "zoom_out");
		bind("alt+meta+shift+,", "zoom_out");
	}

	byPlatform("ctrl+t", "alt+t", "navigate_to_today");
	byPlatform("meta+'", "ctrl+'", "navigate_home");
	if (mac)
	{
		bind("meta+shift+0", "navigate_to_next_item");
		bind("meta+shift+9", "navigate_to_prev_item");
	}
	const siblingItemModifier = windows ? "alt" : "ctrl";
	bind(`${siblingItemModifier}+shift+0`, "navigate_to_next_item");
	bind(`${siblingItemModifier}+shift+9`, "navigate_to_prev_item");
	if (electron)
	{
		byPlatform("meta+[", "alt+left", "navigate_backward");
		byPlatform("meta+]", "alt+right", "navigate_forward");
		bind("ctrl+[", "navigate_backward");
		bind("ctrl+]", "navigate_forward");
	}

	bind("tab", "indent");
	bind("shift+tab", "outdent");
	byPlatform("ctrl+shift+right", "alt+shift+right", "indent");
	byPlatform("ctrl+shift+left", "alt+shift+left", "outdent");
	if (mac)
	{
		bind("meta+shift+up", "move_up");
		bind("meta+shift+down", "move_down");
	}
	const moveModifier = mac || chromeos ? "ctrl" : "alt";
	bind(`${moveModifier}+shift+up`, "move_up");
	bind(`${moveModifier}+shift+down`, "move_down");
	byPlatform("ctrl+meta+m", "alt+ctrl+m", "move_to");
	bind("alt+;", "teleport");
	byPlatform("meta+home", "ctrl+home", "focus_first");
	byPlatform("meta+end", "ctrl+end", "focus_last");
	byPlatform("alt+meta+down", "alt+ctrl+down", "focus_next_sibling");
	byPlatform("alt+meta+up", "alt+ctrl+up", "focus_prev_sibling");
	bind("shift+up", "expand_selection_up");
	bind("shift+down", "expand_selection_down");
	byPlatform("meta+a", "ctrl+a", "select_all");
	bind("esc", "focus_or_unfocus_search");
	byPlatform("meta+o", "ctrl+o", "show_or_hide_completed");
	if (safari)
	{
		keys.delete("meta+o");
		bind("meta+shift+o", "show_or_hide_completed");
	}

	const paneModifier = mac ? "ctrl" : windows ? "alt" : linux ? "alt+shift" : "";
	for (let pane = 1; pane <= 8; pane++)
	{
		bind(`${paneModifier}+${pane}`, `focus_or_open_pane_${pane}`);
	}
	for (let pane = 1; pane <= 8; pane++)
	{
		bind(`${mac || linux ? "ctrl" : "alt"}+shift+${pane}`, `open_in_pane_${pane}`);
	}
	byPlatform("ctrl+r", "alt+r", "new_pane");
	byPlatform("ctrl+meta+w", "alt+ctrl+w", "close_pane");
	byPlatform("meta+down", "ctrl+down", "expand");
	byPlatform("meta+up", "ctrl+up", "collapse");
	bind("ctrl+space", "expand_or_collapse");
	byPlatform("ctrl+l", "alt+l", "toggle_leftbar");
	byPlatform("meta+/", "ctrl+/", "toggle_rightbar");
	byPlatform("meta+k", "ctrl+k", "show_switcher");
	byPlatform("ctrl+c", "alt+c", "toggle_ai_chat");
	byPlatform("meta+shift+e", "alt+shift+e", "show_export");
	bind("alt+w", "show_command_palette");
	byPlatform("meta+shift+p", "ctrl+shift+p", "present_it");
	byPlatform("meta+p", "ctrl+p", "print");
	byPlatform("meta+;", "ctrl+;", "_select_next_in_switcher");
	byPlatform("meta+shift+;", "ctrl+shift+;", "_select_prev_in_switcher");
	byPlatform("meta+shift+h", "ctrl+shift+h", "highlight_selected");
	byPlatform("meta+b", "ctrl+b", "toggle_bold");
	byPlatform("meta+i", "ctrl+i", "toggle_italic");
	byPlatform("meta+u", "ctrl+u", "toggle_underline");
	byPlatform("meta+shift+x", "ctrl+shift+x", "toggle_strikethrough");
	byPlatform("meta+shift+c", "ctrl+shift+c", "toggle_code");
	const blockModifier = mac ? "alt+meta" : "alt+ctrl";
	for (const [digit, command] of [
		["1", "toggle_h1"],
		["2", "toggle_h2"],
		["3", "toggle_h3"],
		["4", "toggle_paragraph"],
		["6", "toggle_code_block"],
		["7", "toggle_quote_block"],
		["8", "toggle_bullet"],
		["9", "toggle_todo"],
		["0", "toggle_numbered"],
	] as const)
	{
		bind(`${blockModifier}+${digit}`, command);
	}
	bind("alt+shift+space", "toggle_ai_item");
	bind("ctrl+m", "comment");
	byPlatform("meta+shift+return", "ctrl+shift+return", "mark_read");
	bind("alt+ctrl+n", "next_unread");
	bind("alt+ctrl+p", "previous_unread");

	return [...keys];
}

/** Upstream's platform flags, read from the browser; all false outside one. */
export function currentPlatform(): Platform
{
	const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
	const platform = typeof navigator === "undefined" ? "" : navigator.platform;
	const chromeos = /CrOS/u.test(userAgent);
	return {
		mac: /Mac|iPhone|iPad/u.test(platform),
		safari: /Safari/u.test(userAgent) && !/Chrome|Chromium|CriOS|Android/u.test(userAgent),
		windows: /Win/u.test(platform),
		linux: /Linux/u.test(platform) && !chromeos && !/Android/u.test(userAgent),
		chromeos,
		electron: /electron/iu.test(userAgent),
	};
}

export const HOTKEYS: readonly Hotkey[] = buildHotkeys(currentPlatform());

/** Upstream's `r92`: base key names by `KeyboardEvent.which`. */
const KEY_NAMES: Readonly<Record<number, string>> =
{
	8: "backspace",
	9: "tab",
	13: "return",
	16: "shift",
	17: "ctrl",
	18: "alt",
	19: "pause",
	20: "capslock",
	27: "esc",
	32: "space",
	33: "pageup",
	34: "pagedown",
	35: "end",
	36: "home",
	37: "left",
	38: "up",
	39: "right",
	40: "down",
	45: "insert",
	46: "del",
	91: "meta",
	93: "meta",
	96: "0",
	97: "1",
	98: "2",
	99: "3",
	100: "4",
	101: "5",
	102: "6",
	103: "7",
	104: "8",
	105: "9",
	106: "*",
	107: "+",
	109: "-",
	111: "/",
	112: "f1",
	113: "f2",
	114: "f3",
	115: "f4",
	116: "f5",
	117: "f6",
	118: "f7",
	119: "f8",
	120: "f9",
	121: "f10",
	122: "f11",
	123: "f12",
	144: "numlock",
	145: "scroll",
	186: ";",
	188: ",",
	190: ".",
	191: "/",
	219: "[",
	220: "\\",
	221: "]",
	222: "'",
	224: "meta",
};

export interface KeyComboEvent
{
	which: number;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/**
 * Upstream's `qY`: the canonical combo for a keydown. Shift never changes the base key, modifiers are prefixed in
 * alt, ctrl, meta, shift order, and a modifier pressed alone is not repeated as its own prefix.
 */
export function comboFromEvent({which, altKey, ctrlKey, metaKey, shiftKey}: KeyComboEvent): string
{
	const named = KEY_NAMES[which];
	const key = named ?? String.fromCodePoint(which).toLowerCase();
	const modifiers = (
		[
			[altKey, "alt"],
			[ctrlKey, "ctrl"],
			[metaKey, "meta"],
			[shiftKey, "shift"],
		] as const
	)
		.filter(([pressed, name]) => pressed && named !== name)
		.map(([, name]) => name);
	return modifiers.length > 0 ? `${modifiers.join("+")}+${key}` : key;
}
