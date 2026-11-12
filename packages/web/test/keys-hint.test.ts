import {describe, expect, it} from "vite-plus/test";
import {MAC_HOTKEYS, hint} from "../src/client/keys/hint.js";

const COMMANDS = [
	"zoom_in",
	"navigate_to_today",
	"outdent",
	"move_up",
	"delete",
	"focus_or_unfocus_search",
	"navigate_home",
	"toggle_rightbar",
	"focus_or_open_pane_1",
	"open_in_pane_1",
	"close_pane",
	"mark_read",
	"toggle_ai_item",
	"previous_unread",
];

describe("hint", () =>
{
	it("formats each command's first mac combo the way upstream's hotkeys panel does", () =>
	{
		expect(Object.fromEntries(COMMANDS.map((command) => [command, hint(command)]))).toStrictEqual(
			{
				zoom_in: "⌘.",
				navigate_to_today: "⌃T",
				outdent: "⇧⇥",
				move_up: "⇧⌘↑",
				delete: "⇧⌘⌫",
				focus_or_unfocus_search: "ESC",
				navigate_home: "⌘'",
				toggle_rightbar: "⌘/",
				focus_or_open_pane_1: "⌃1",
				open_in_pane_1: "⌃⇧1",
				close_pane: "⌃⌘W",
				mark_read: "⇧⌘↵",
				toggle_ai_item: "⌥⇧Space",
				previous_unread: "⌥⌃P",
			},
		);
	});

	it("spells modifiers out and joins with + off mac", () =>
	{
		expect(
			Object.fromEntries(
				["navigate_to_today", "previous_unread"].map((command) => [command, hint(command, false)]),
			),
		).toStrictEqual(
			{
				navigate_to_today: "Alt+T",
				previous_unread: "Alt+Ctrl+P",
			},
		);
	});

	it("spells the off-mac complete chip as Ctrl+Enter", () =>
	{
		expect(hint("complete", false)).toBe("Ctrl+Enter");
	});

	it("derives off-mac chips from the off-mac table with upstream's arrow and space glyphs", () =>
	{
		expect(
			Object.fromEntries(
				[
					"zoom_in",
					"toggle_rightbar",
					"move_up",
					"expand",
					"toggle_ai_item",
					"delete",
					"focus_or_open_pane_1",
				].map((command) => [command, hint(command, false)]),
			),
		).toStrictEqual(
			{
				zoom_in: "Alt+↓",
				toggle_rightbar: "Ctrl+/",
				move_up: "Alt+Shift+↑",
				expand: "Ctrl+↓",
				toggle_ai_item: "Alt+Shift+Space",
				delete: "Ctrl+Shift+Backspace",
				focus_or_open_pane_1: "Alt+1",
			},
		);
	});

	it("is undefined for an unbound command", () =>
	{
		expect(hint("no_such_command")).toBeUndefined();
	});

	it("lists the mac table in upstream insertion order", () =>
	{
		expect(MAC_HOTKEYS.slice(0, 3)).toStrictEqual([
			["meta+shift+backspace", "delete"],
			["meta+shift+8", "star_current_item"],
			["meta+return", "complete"],
		]);
	});
});
