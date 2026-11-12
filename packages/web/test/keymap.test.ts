import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {buildHotkeys, comboFromEvent, currentPlatform, HOTKEYS} from "../src/client/keys/keymap.js";
import type {KeyComboEvent, Platform} from "../src/client/keys/keymap.js";

const CHROME: Platform =
{
	mac: false,
	safari: false,
	windows: false,
	linux: false,
	chromeos: false,
	electron: false,
};

/** Upstream's mac Chrome `WF.map.Hotkeys`, in insertion order (dumps/keymap-parity-mac-chrome-table.json). */
const MAC_CHROME_TABLE = [
	["meta+shift+backspace", "delete"],
	["meta+shift+8", "star_current_item"],
	["meta+return", "complete"],
	["meta+shift+d", "duplicate"],
	["meta+shift+m", "mirror"],
	["meta+shift+l", "copy_link"],
	["meta+s", "save_and_sync"],
	["meta+z", "undo"],
	["meta+y", "redo"],
	["meta+shift+z", "redo"],
	["ctrl+s", "save_and_sync"],
	["ctrl+z", "undo"],
	["ctrl+y", "redo"],
	["ctrl+shift+z", "redo"],
	["meta+.", "zoom_in"],
	["ctrl+right", "zoom_in"],
	["ctrl+.", "zoom_in"],
	["meta+shift+.", "zoom_in"],
	["ctrl+meta+shift+.", "zoom_in"],
	["ctrl+shift+.", "zoom_in"],
	["meta+,", "zoom_out"],
	["ctrl+left", "zoom_out"],
	["ctrl+,", "zoom_out"],
	["meta+shift+,", "zoom_out"],
	["ctrl+meta+shift+,", "zoom_out"],
	["ctrl+t", "navigate_to_today"],
	["meta+'", "navigate_home"],
	["meta+shift+0", "navigate_to_next_item"],
	["meta+shift+9", "navigate_to_prev_item"],
	["ctrl+shift+0", "navigate_to_next_item"],
	["ctrl+shift+9", "navigate_to_prev_item"],
	["tab", "indent"],
	["shift+tab", "outdent"],
	["ctrl+shift+right", "indent"],
	["ctrl+shift+left", "outdent"],
	["meta+shift+up", "move_up"],
	["meta+shift+down", "move_down"],
	["ctrl+shift+up", "move_up"],
	["ctrl+shift+down", "move_down"],
	["ctrl+meta+m", "move_to"],
	["alt+;", "teleport"],
	["meta+home", "focus_first"],
	["meta+end", "focus_last"],
	["alt+meta+down", "focus_next_sibling"],
	["alt+meta+up", "focus_prev_sibling"],
	["shift+up", "expand_selection_up"],
	["shift+down", "expand_selection_down"],
	["meta+a", "select_all"],
	["esc", "focus_or_unfocus_search"],
	["meta+o", "show_or_hide_completed"],
	["ctrl+1", "focus_or_open_pane_1"],
	["ctrl+2", "focus_or_open_pane_2"],
	["ctrl+3", "focus_or_open_pane_3"],
	["ctrl+4", "focus_or_open_pane_4"],
	["ctrl+5", "focus_or_open_pane_5"],
	["ctrl+6", "focus_or_open_pane_6"],
	["ctrl+7", "focus_or_open_pane_7"],
	["ctrl+8", "focus_or_open_pane_8"],
	["ctrl+shift+1", "open_in_pane_1"],
	["ctrl+shift+2", "open_in_pane_2"],
	["ctrl+shift+3", "open_in_pane_3"],
	["ctrl+shift+4", "open_in_pane_4"],
	["ctrl+shift+5", "open_in_pane_5"],
	["ctrl+shift+6", "open_in_pane_6"],
	["ctrl+shift+7", "open_in_pane_7"],
	["ctrl+shift+8", "open_in_pane_8"],
	["ctrl+r", "new_pane"],
	["ctrl+meta+w", "close_pane"],
	["meta+down", "expand"],
	["meta+up", "collapse"],
	["ctrl+space", "expand_or_collapse"],
	["ctrl+l", "toggle_leftbar"],
	["meta+/", "toggle_rightbar"],
	["meta+k", "show_switcher"],
	["ctrl+c", "toggle_ai_chat"],
	["meta+shift+e", "show_export"],
	["alt+w", "show_command_palette"],
	["meta+shift+p", "present_it"],
	["meta+p", "print"],
	["meta+;", "_select_next_in_switcher"],
	["meta+shift+;", "_select_prev_in_switcher"],
	["meta+shift+h", "highlight_selected"],
	["meta+b", "toggle_bold"],
	["meta+i", "toggle_italic"],
	["meta+u", "toggle_underline"],
	["meta+shift+x", "toggle_strikethrough"],
	["meta+shift+c", "toggle_code"],
	["alt+meta+1", "toggle_h1"],
	["alt+meta+2", "toggle_h2"],
	["alt+meta+3", "toggle_h3"],
	["alt+meta+4", "toggle_paragraph"],
	["alt+meta+6", "toggle_code_block"],
	["alt+meta+7", "toggle_quote_block"],
	["alt+meta+8", "toggle_bullet"],
	["alt+meta+9", "toggle_todo"],
	["alt+meta+0", "toggle_numbered"],
	["alt+shift+space", "toggle_ai_item"],
	["ctrl+m", "comment"],
	["meta+shift+return", "mark_read"],
	["alt+ctrl+n", "next_unread"],
	["alt+ctrl+p", "previous_unread"],
];

/** Upstream's Windows Chrome `WF.map.Hotkeys`, in insertion order (dumps/keymap-parity-windows-chrome-table.json). */
const WINDOWS_CHROME_TABLE = [
	["ctrl+shift+backspace", "delete"],
	["ctrl+shift+8", "star_current_item"],
	["ctrl+return", "complete"],
	["alt+shift+d", "duplicate"],
	["alt+shift+m", "mirror"],
	["alt+shift+l", "copy_link"],
	["ctrl+s", "save_and_sync"],
	["ctrl+z", "undo"],
	["ctrl+y", "redo"],
	["ctrl+shift+z", "redo"],
	["alt+down", "zoom_in"],
	["alt+.", "zoom_in"],
	["alt+meta+shift+.", "zoom_in"],
	["alt+shift+.", "zoom_in"],
	["alt+up", "zoom_out"],
	["alt+,", "zoom_out"],
	["alt+meta+shift+,", "zoom_out"],
	["alt+t", "navigate_to_today"],
	["ctrl+'", "navigate_home"],
	["alt+shift+0", "navigate_to_next_item"],
	["alt+shift+9", "navigate_to_prev_item"],
	["tab", "indent"],
	["shift+tab", "outdent"],
	["alt+shift+right", "indent"],
	["alt+shift+left", "outdent"],
	["alt+shift+up", "move_up"],
	["alt+shift+down", "move_down"],
	["alt+ctrl+m", "move_to"],
	["alt+;", "teleport"],
	["ctrl+home", "focus_first"],
	["ctrl+end", "focus_last"],
	["alt+ctrl+down", "focus_next_sibling"],
	["alt+ctrl+up", "focus_prev_sibling"],
	["shift+up", "expand_selection_up"],
	["shift+down", "expand_selection_down"],
	["ctrl+a", "select_all"],
	["esc", "focus_or_unfocus_search"],
	["ctrl+o", "show_or_hide_completed"],
	["alt+1", "focus_or_open_pane_1"],
	["alt+2", "focus_or_open_pane_2"],
	["alt+3", "focus_or_open_pane_3"],
	["alt+4", "focus_or_open_pane_4"],
	["alt+5", "focus_or_open_pane_5"],
	["alt+6", "focus_or_open_pane_6"],
	["alt+7", "focus_or_open_pane_7"],
	["alt+8", "focus_or_open_pane_8"],
	["alt+shift+1", "open_in_pane_1"],
	["alt+shift+2", "open_in_pane_2"],
	["alt+shift+3", "open_in_pane_3"],
	["alt+shift+4", "open_in_pane_4"],
	["alt+shift+5", "open_in_pane_5"],
	["alt+shift+6", "open_in_pane_6"],
	["alt+shift+7", "open_in_pane_7"],
	["alt+shift+8", "open_in_pane_8"],
	["alt+r", "new_pane"],
	["alt+ctrl+w", "close_pane"],
	["ctrl+down", "expand"],
	["ctrl+up", "collapse"],
	["ctrl+space", "expand_or_collapse"],
	["alt+l", "toggle_leftbar"],
	["ctrl+/", "toggle_rightbar"],
	["ctrl+k", "show_switcher"],
	["alt+c", "toggle_ai_chat"],
	["alt+shift+e", "show_export"],
	["alt+w", "show_command_palette"],
	["ctrl+shift+p", "present_it"],
	["ctrl+p", "print"],
	["ctrl+;", "_select_next_in_switcher"],
	["ctrl+shift+;", "_select_prev_in_switcher"],
	["ctrl+shift+h", "highlight_selected"],
	["ctrl+b", "toggle_bold"],
	["ctrl+i", "toggle_italic"],
	["ctrl+u", "toggle_underline"],
	["ctrl+shift+x", "toggle_strikethrough"],
	["ctrl+shift+c", "toggle_code"],
	["alt+ctrl+1", "toggle_h1"],
	["alt+ctrl+2", "toggle_h2"],
	["alt+ctrl+3", "toggle_h3"],
	["alt+ctrl+4", "toggle_paragraph"],
	["alt+ctrl+6", "toggle_code_block"],
	["alt+ctrl+7", "toggle_quote_block"],
	["alt+ctrl+8", "toggle_bullet"],
	["alt+ctrl+9", "toggle_todo"],
	["alt+ctrl+0", "toggle_numbered"],
	["alt+shift+space", "toggle_ai_item"],
	["ctrl+m", "comment"],
	["ctrl+shift+return", "mark_read"],
	["alt+ctrl+n", "next_unread"],
	["alt+ctrl+p", "previous_unread"],
];

function event(which: number, modifiers: Partial<Omit<KeyComboEvent, "which">> = {}): KeyComboEvent
{
	return {
		which,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		...modifiers,
	};
}

describe("buildHotkeys", () =>
{
	it("matches upstream's mac Chrome table entry for entry", () =>
	{
		expect(
			buildHotkeys(
				{
					...CHROME,
					mac: true,
				},
			),
		).toStrictEqual(MAC_CHROME_TABLE);
	});

	it("matches upstream's Windows Chrome table entry for entry", () =>
	{
		expect(
			buildHotkeys(
				{
					...CHROME,
					windows: true,
				},
			),
		).toStrictEqual(WINDOWS_CHROME_TABLE);
	});

	it("binds zoom_in to all six mac Chrome combos in table order", () =>
	{
		expect(
			buildHotkeys(
				{
					...CHROME,
					mac: true,
				},
			)
				.filter(([, command]) => command === "zoom_in")
				.map(([combo]) => combo),
		).toStrictEqual(["meta+.", "ctrl+right", "ctrl+.", "meta+shift+.", "ctrl+meta+shift+.", "ctrl+shift+."]);
	});

	it("puts Safari's shifted zoom combos first and moves show_or_hide_completed to meta+shift+o", () =>
	{
		const table = buildHotkeys(
			{
				...CHROME,
				mac: true,
				safari: true,
			},
		);
		expect(
			{
				zoomIn: table.filter(([, command]) => command === "zoom_in").map(([combo]) => combo),
				zoomOut: table.filter(([, command]) => command === "zoom_out").map(([combo]) => combo),
				completed: table.filter(([, command]) => command === "show_or_hide_completed"),
				metaO: table.filter(([combo]) => combo === "meta+o"),
			},
		).toStrictEqual(
			{
				zoomIn: ["meta+shift+.", "ctrl+right", "ctrl+.", "meta+.", "ctrl+meta+shift+.", "ctrl+shift+."],
				zoomOut: ["meta+shift+,", "ctrl+left", "ctrl+,", "meta+,", "ctrl+meta+shift+,"],
				completed: [["meta+shift+o", "show_or_hide_completed"]],
				metaO: [],
			},
		);
	});

	it("binds navigate backward/forward only in Electron", () =>
	{
		const navigation = (platform: Platform) =>
			buildHotkeys(platform).filter(
				([, command]) => command === "navigate_backward" || command === "navigate_forward",
			);
		expect(
			{
				chrome: navigation(
					{
						...CHROME,
						mac: true,
					},
				),
				electron: navigation(
					{
						...CHROME,
						mac: true,
						electron: true,
					},
				),
			},
		).toStrictEqual(
			{
				chrome: [],
				electron: [
					["meta+[", "navigate_backward"],
					["meta+]", "navigate_forward"],
					["ctrl+[", "navigate_backward"],
					["ctrl+]", "navigate_forward"],
				],
			},
		);
	});

	it("lets a later assignment win while keeping the combo's first position, like upstream's object", () =>
	{
		const table = buildHotkeys(
			{
				...CHROME,
				linux: true,
			},
		);
		expect(table.filter(([combo]) => combo === "ctrl+shift+8")).toStrictEqual([["ctrl+shift+8", "open_in_pane_8"]]);
		expect(table.findIndex(([combo]) => combo === "ctrl+shift+8")).toBe(1);
	});
});

describe("currentPlatform", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it.each([
		[
			"MacIntel",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
			{
				...CHROME,
				mac: true,
				safari: true,
			},
		],
		[
			"MacIntel",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
			{
				...CHROME,
				mac: true,
			},
		],
		[
			"MacIntel",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) WorkFlowy/4.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36",
			{
				...CHROME,
				mac: true,
				electron: true,
			},
		],
		[
			"Win32",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
			{
				...CHROME,
				windows: true,
			},
		],
		[
			"Linux x86_64",
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
			{
				...CHROME,
				linux: true,
			},
		],
		[
			"Linux x86_64",
			"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
			{
				...CHROME,
				chromeos: true,
			},
		],
	])("reads %s / %s", (platform, userAgent, expected) =>
	{
		vi.stubGlobal(
			"navigator",
			{
				platform,
				userAgent,
			},
		);
		expect(currentPlatform()).toStrictEqual(expected);
	});

	it("builds HOTKEYS for the platform the module loaded on", () =>
	{
		expect(HOTKEYS).toStrictEqual(buildHotkeys(currentPlatform()));
	});
});

describe("comboFromEvent", () =>
{
	it.each([
		[
			event(
				190,
				{
					metaKey: true,
					shiftKey: true,
				},
			),
			"meta+shift+.",
		],
		[
			event(
				57,
				{
					metaKey: true,
					shiftKey: true,
				},
			),
			"meta+shift+9",
		],
		[
			event(
				40,
				{
					altKey: true,
					metaKey: true,
				},
			),
			"alt+meta+down",
		],
		[
			event(
				13,
				{
					metaKey: true,
				},
			),
			"meta+return",
		],
		[event(27), "esc"],
		[
			event(
				32,
				{
					ctrlKey: true,
				},
			),
			"ctrl+space",
		],
		[
			event(
				91,
				{
					metaKey: true,
				},
			),
			"meta",
		],
		[
			event(
				186,
				{
					altKey: true,
				},
			),
			"alt+;",
		],
		[
			event(
				65,
				{
					altKey: true,
					ctrlKey: true,
					metaKey: true,
					shiftKey: true,
				},
			),
			"alt+ctrl+meta+shift+a",
		],
		[event(103), "7"],
	])("canonicalizes %o as %s", (keyEvent, combo) =>
	{
		expect(comboFromEvent(keyEvent)).toBe(combo);
	});
});

describe("color commands", () =>
{
	it("registers every command the color hotkeys and the selection menu run", () =>
	{
		const registry = readFileSync(
			fileURLToPath(new URL("../src/client/hooks/use-command-registry.ts", import.meta.url)),
			"utf8",
		);
		const bound = [...hotkeyTable("highlight_selected")];
		expect(
			{
				bound,
				registered: ["highlight_selected", "show_color_popup"].map((id) =>
					registry.includes(`\t\t${id}:\n\t\t{`),
				),
			},
		).toStrictEqual(
			{
				bound: ["meta+shift+h", "ctrl+shift+h"],
				registered: [true, true],
			},
		);
	});
});

function hotkeyTable(command: string): string[]
{
	return [
		...buildHotkeys(
			{
				...CHROME,
				mac: true,
			},
		).filter(([, id]) => id === command),
		...buildHotkeys(CHROME).filter(([, id]) => id === command),
	].map(([combo]) => combo);
}
