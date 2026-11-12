import {describe, expect, it} from "vite-plus/test";
import {buildSelectionMenu} from "../src/client/selection-menu-model.js";
import type {SelectionMenuContext} from "../src/client/selection-menu-model.js";
import {
	initialToolbarState,
	toolbarFormatAttr,
	toolbarLayoutCommand,
	toolbarState,
	toolbarRefreshKey,
} from "../src/client/hooks/use-selection-toolbar.js";
import type {ToolbarEvent, ToolbarState} from "../src/client/hooks/use-selection-toolbar.js";

describe("selection menu model", () => {
	const LOCAL = new Set([
		"toggle_h1",
		"toggle_h2",
		"toggle_h3",
		"toggle_paragraph",
		"toggle_code_block",
		"toggle_quote_block",
		"toggle_bullet",
		"toggle_numbered",
		"complete",
		"move_to",
		"show_export",
		"delete",
	]);

	function menu(overrides: Partial<SelectionMenuContext> = {}) {
		return buildSelectionMenu({
			available: () => true,
			allCompleted: false,
			firstEmbedded: false,
			qualifiers: new Set(),
			...overrides,
		}).map((entry) => (entry.kind === "separator" ? "sep" : entry.id));
	}

	describe("buildSelectionMenu", () => {
		it("lists all 26 commands in upstream order with a separator between each pair of groups", () => {
			expect(menu()).toStrictEqual([
				"toggle_h1",
				"toggle_h2",
				"toggle_h3",
				"toggle_paragraph",
				"toggle_code_block",
				"toggle_quote_block",
				"toggle_bullet",
				"toggle_todo_mode",
				"toggle_numbered",
				"sep",
				"toggle_bold",
				"toggle_italic",
				"toggle_underline",
				"toggle_strikethrough",
				"toggle_code",
				"show_color_popup",
				"sep",
				"complete",
				"move_to",
				"move_to_today",
				"move_to_tomorrow",
				"move_to_next_week",
				"move_to_date",
				"mirror",
				"mirror_to",
				"mirror_to_today",
				"mirror_to_date",
				"show_export",
				"sep",
				"delete",
			]);
		});

		it("shows only the registered commands, with one separator where a group is empty", () => {
			expect(menu({available: (id) => LOCAL.has(id)})).toStrictEqual([
				"toggle_h1",
				"toggle_h2",
				"toggle_h3",
				"toggle_paragraph",
				"toggle_code_block",
				"toggle_quote_block",
				"toggle_bullet",
				"toggle_numbered",
				"sep",
				"complete",
				"move_to",
				"show_export",
				"sep",
				"delete",
			]);
		});

		it("shows only the table-cell rows for has_table_cell", () => {
			expect(menu({qualifiers: new Set(["has_table_cell"])})).toStrictEqual([
				"toggle_bullet",
				"toggle_todo_mode",
				"sep",
				"toggle_bold",
				"toggle_italic",
				"toggle_underline",
				"toggle_strikethrough",
				"sep",
				"complete",
				"move_to",
				"mirror",
				"mirror_to",
				"show_export",
				"sep",
				"delete",
			]);
		});

		it("drops the move and mirror rows for has_pane_item", () => {
			const ids = menu({qualifiers: new Set(["has_pane_item"])});
			expect(ids.filter((id) => id.startsWith("move_to") || id.startsWith("mirror"))).toStrictEqual([]);
		});

		it("is empty for the comment-paragraph and calendar-search qualifiers", () => {
			expect([
				menu({qualifiers: new Set(["all_comment_paragraphs"])}),
				menu({qualifiers: new Set(["has_calendar_search_container"])}),
			]).toStrictEqual([[], []]);
		});

		it("reads Uncomplete and Remove, and carries icons and shortcut sources", () => {
			const entries = buildSelectionMenu({
				available: (id) => ["toggle_todo_mode", "complete", "move_to_today", "delete"].includes(id),
				allCompleted: true,
				firstEmbedded: true,
				qualifiers: new Set(),
			});
			expect(entries).toStrictEqual([
				{
					kind: "command",
					id: "toggle_todo_mode",
					label: "To-do",
					icon: "fal:list-check",
					shortcutCommand: "toggle_todo",
				},
				{kind: "separator"},
				{kind: "command", id: "complete", label: "Uncomplete", icon: "fal:check", shortcutCommand: "complete"},
				{
					kind: "command",
					id: "move_to_today",
					label: "Move to Today",
					icon: "fal:calendar-day",
					shortcutCommand: null,
				},
				{kind: "separator"},
				{kind: "command", id: "delete", label: "Remove", icon: "fal:trash-can", shortcutCommand: "delete"},
			]);
		});
	});
});

describe("selection toolbar state", () => {
	function run(events: readonly ToolbarEvent[], start: ToolbarState = initialToolbarState(false)): ToolbarState {
		return events.reduce(toolbarState, start);
	}

	const stretched = {type: "selectionchange", stretched: true, popupOpen: false} as const;
	const collapsed = {type: "selectionchange", stretched: false, popupOpen: false} as const;
	const pointerupStretched = {type: "pointerup", stretched: true, popupOpen: false} as const;
	const pointerdownOutside = {type: "pointerdown", insideCtxMenu: false} as const;

	describe("toolbarState", () => {
		it("starts hidden, remembering whether the primary button is down", () => {
			expect(initialToolbarState(false)).toStrictEqual({visible: false, pointerDown: false, composing: false});
			expect(initialToolbarState(true)).toStrictEqual({visible: false, pointerDown: true, composing: false});
		});

		it("ignores selection changes while the primary button is down and opens on pointerup", () => {
			const dragging = run([pointerdownOutside, stretched]);
			expect(dragging).toStrictEqual({visible: false, pointerDown: true, composing: false});
			expect(run([pointerupStretched], dragging)).toStrictEqual({
				visible: true,
				pointerDown: false,
				composing: false,
			});
		});

		it("opens on a keyboard-stretched selection and closes when it collapses", () => {
			const open = run([stretched]);
			expect(open).toStrictEqual({visible: true, pointerDown: false, composing: false});
			expect(run([collapsed], open)).toStrictEqual({visible: false, pointerDown: false, composing: false});
		});

		it("stays closed through a composition and resumes at compositionend", () => {
			const composing = run([{type: "compositionstart"}, stretched]);
			expect(composing).toStrictEqual({visible: false, pointerDown: false, composing: true});
			expect(run([{type: "compositionend"}, stretched], composing)).toStrictEqual({
				visible: true,
				pointerDown: false,
				composing: false,
			});
		});

		it("closes when composition starts while open", () => {
			expect(run([stretched, {type: "compositionstart"}])).toStrictEqual({
				visible: false,
				pointerDown: false,
				composing: true,
			});
		});

		it("stays open on a pointerdown inside the ctx-menu and closes on one outside", () => {
			expect(run([stretched, {type: "pointerdown", insideCtxMenu: true}])).toStrictEqual({
				visible: true,
				pointerDown: true,
				composing: false,
			});
			expect(run([stretched, pointerdownOutside])).toStrictEqual({
				visible: false,
				pointerDown: true,
				composing: false,
			});
		});

		it("does not open while another popup is open, but stays open when already open", () => {
			expect(run([{type: "pointerup", stretched: true, popupOpen: true}])).toStrictEqual({
				visible: false,
				pointerDown: false,
				composing: false,
			});
			expect(run([stretched, {type: "selectionchange", stretched: true, popupOpen: true}])).toStrictEqual({
				visible: true,
				pointerDown: false,
				composing: false,
			});
		});

		it("closes on Escape", () => {
			expect(run([stretched, {type: "escape"}])).toStrictEqual({
				visible: false,
				pointerDown: false,
				composing: false,
			});
		});
	});

	describe("toolbar actions", () => {
		it("maps format buttons to inline attributes and type buttons to layout toggles", () => {
			const actions = [
				"h1",
				"h2",
				"h3",
				"p",
				"bold",
				"underline",
				"italic",
				"strikethrough",
				"code-format",
				"link",
				"latest-color",
				"show-palette",
			] as const;
			expect(
				actions.map((action) => [action, toolbarFormatAttr(action), toolbarLayoutCommand(action)]),
			).toStrictEqual([
				["h1", null, "toggle_h1"],
				["h2", null, "toggle_h2"],
				["h3", null, "toggle_h3"],
				["p", null, "toggle_paragraph"],
				["bold", "b", null],
				["underline", "u", null],
				["italic", "i", null],
				["strikethrough", "s", null],
				["code-format", "code", null],
				["link", null, null],
				["latest-color", null, null],
				["show-palette", null, null],
			]);
		});
	});

	describe("toolbarRefreshKey", () => {
		it("is stable per normalized layout and differs between layouts", () => {
			expect([
				toolbarRefreshKey("h1") === toolbarRefreshKey("h1"),
				toolbarRefreshKey("h1") === toolbarRefreshKey(null),
				toolbarRefreshKey("paragraph") === toolbarRefreshKey("p"),
				toolbarRefreshKey(undefined) === toolbarRefreshKey(null),
			]).toStrictEqual([true, false, true, true]);
		});
	});
});
