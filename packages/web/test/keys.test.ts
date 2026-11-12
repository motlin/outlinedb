import {describe, expect, it, vi} from "vite-plus/test";
import {
	BROWSER_NATIVE_COMMANDS,
	deferToFocusedControl,
	hotkeyTable,
	keymapCombo,
	listenForAppMessageKeys,
	presentCommand,
	printCommand,
	processAppMessageCombo,
	processCombo,
	processSelectionKey,
} from "../src/client/keys/dispatch.js";
import {buildHotkeys, currentPlatform} from "../src/client/keys/keymap.js";
import type {CommandContext, SelectionKeyEvent} from "../src/client/keys/dispatch.js";
import type {SelectionKeyAction} from "../src/client/item-selection.js";
import {MAC_HOTKEYS, hint} from "../src/client/keys/hint.js";

describe("keys dispatch", () => {
	const ctx: CommandContext = {items: ["a"], zoomedId: null};

	describe("processCombo show_command_palette", () => {
		it("claims alt+w and runs the command with the context, even with no items", () => {
			const execute = vi.fn<(ctx: CommandContext) => void>();
			const empty: CommandContext = {items: [], zoomedId: null};
			expect({
				result: processCombo("alt+w", {show_command_palette: {execute}}, empty, true),
				calls: execute.mock.calls,
			}).toStrictEqual({result: "claimed", calls: [[empty]]});
		});
	});

	describe("processCombo", () => {
		it("claims a bound combo with no registered command, so the browser never acts on it", () => {
			expect(processCombo("meta+s", {}, ctx, true)).toBe("claimed");
		});

		it("leaves an unavailable passthrough combo to the browser without executing it", () => {
			const execute = vi.fn<(ctx: CommandContext) => void>();
			expect({
				result: processCombo("alt+;", {teleport: {available: () => false, execute}}, ctx, true),
				calls: execute.mock.calls,
			}).toStrictEqual({result: "unclaimed", calls: []});
		});

		it("leaves ctrl+t to the browser on mac when nothing handles it", () => {
			expect(processCombo("ctrl+t", {}, ctx, true)).toBe("unclaimed");
		});

		it("claims ctrl+t off mac even when nothing handles it", () => {
			expect(processCombo("alt+t", {}, ctx, false)).toBe("claimed");
		});

		it("executes an available command once with the context and claims the combo", () => {
			const execute = vi.fn<(ctx: CommandContext) => void>();
			expect({
				result: processCombo("meta+.", {zoom_in: {execute}}, ctx, true),
				calls: execute.mock.calls,
			}).toStrictEqual({result: "claimed", calls: [[ctx]]});
		});

		it("claims an unavailable command outside the passthrough set without executing it", () => {
			const execute = vi.fn<(ctx: CommandContext) => void>();
			expect({
				result: processCombo("meta+s", {save_and_sync: {available: () => false, execute}}, ctx, true),
				calls: execute.mock.calls,
			}).toStrictEqual({result: "claimed", calls: []});
		});

		it("executes save_and_sync once on meta+s and claims the combo", () => {
			const execute = vi.fn<(ctx: CommandContext) => void>();
			expect({
				result: processCombo("meta+s", {save_and_sync: {execute}}, ctx, true),
				calls: execute.mock.calls,
			}).toStrictEqual({result: "claimed", calls: [[ctx]]});
		});

		it("leaves an unbound combo to the browser", () => {
			expect(processCombo("meta+q", {}, ctx, true)).toBe("unclaimed");
		});

		it("leaves Back/Forward to the browser with no pane open, and claims them while panes are open", () => {
			const back = vi.fn<(ctx: CommandContext) => void>();
			const forward = vi.fn<(ctx: CommandContext) => void>();
			const registry = {
				navigate_backward: {execute: back},
				navigate_forward: {execute: forward},
			};
			const run = (combo: string, isMac: boolean, panesOpen: boolean) =>
				processCombo(combo, registry, ctx, isMac, hotkeyTable(isMac), panesOpen);
			expect({
				closed: [run("meta+[", true, false), run("meta+]", true, false), run("alt+left", false, false)],
				open: [
					run("meta+[", true, true),
					run("meta+]", true, true),
					run("alt+left", false, true),
					run("alt+right", false, true),
				],
				offMacCmd: run("meta+[", false, true),
				calls: [back.mock.calls.length, forward.mock.calls.length],
			}).toStrictEqual({
				closed: ["unclaimed", "unclaimed", "unclaimed"],
				open: ["claimed", "claimed", "claimed", "claimed"],
				offMacCmd: "unclaimed",
				calls: [2, 2],
			});
		});

		it("keeps the Electron table's claim of an unavailable Back", () => {
			const electron = new Map(buildHotkeys({...currentPlatform(), mac: true, electron: true}));
			const registry = {navigate_backward: {available: () => false, execute: vi.fn<() => void>()}};
			expect(processCombo("meta+[", registry, ctx, true, electron)).toBe("claimed");
		});

		it("toggles the right bar on meta+/ only, leaving meta+shift+/ to the browser", () => {
			const toggle = vi.fn<(ctx: CommandContext) => void>();
			const registry = {toggle_rightbar: {execute: toggle}};
			expect({
				results: ["meta+/", "meta+shift+/"].map((combo) => processCombo(combo, registry, ctx, true)),
				calls: toggle.mock.calls,
			}).toStrictEqual({results: ["claimed", "unclaimed"], calls: [[ctx]]});
		});

		it("toggles the left bar on ⌃L on mac and ⌥L elsewhere, leaving ctrl+l off mac to the browser", () => {
			const toggle = vi.fn<(ctx: CommandContext) => void>();
			const registry = {toggle_leftbar: {execute: toggle}};
			const key = {which: 76, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false};
			const dispatch = (event: typeof key, isMac: boolean) => {
				const combo = keymapCombo(event, isMac);
				return combo === null ? null : processCombo(combo, registry, ctx, isMac);
			};
			expect({
				macCtrl: dispatch({...key, ctrlKey: true}, true),
				otherAlt: dispatch({...key, altKey: true}, false),
				otherCtrl: dispatch({...key, ctrlKey: true}, false),
				calls: toggle.mock.calls,
			}).toStrictEqual({macCtrl: "claimed", otherAlt: "claimed", otherCtrl: "unclaimed", calls: [[ctx], [ctx]]});
		});
	});

	describe("hotkeyTable", () => {
		it("maps the platform's upstream combos", () => {
			const table = hotkeyTable(true);
			expect({
				save: table.get("meta+s"),
				zoomIn: table.get("meta+."),
				today: table.get("ctrl+t"),
				back: table.get("meta+["),
				help: table.get("meta+/"),
				shiftHelp: table.get("meta+shift+/"),
				quit: table.get("meta+q"),
			}).toStrictEqual({
				save: "save_and_sync",
				zoomIn: "zoom_in",
				today: "navigate_to_today",
				back: undefined,
				help: "toggle_rightbar",
				shiftHelp: undefined,
				quit: undefined,
			});
		});

		it("binds the off-mac upstream combos", () => {
			const table = hotkeyTable(false);
			expect({
				complete: table.get("ctrl+return"),
				today: table.get("alt+t"),
				macComplete: table.get("meta+return"),
			}).toStrictEqual({complete: "complete", today: "navigate_to_today", macComplete: undefined});
		});
	});

	describe("deferToFocusedControl", () => {
		const control = (tabIndex: number, inName: boolean) => ({
			tabIndex,
			closest: (selector: string) => (selector === ".name" && inName ? {} : null),
		});

		it("lets a focused button or input keep tab, select-all and return", () => {
			expect(
				["tab", "shift+tab", "meta+a", "ctrl+a", "return"].map((combo) =>
					deferToFocusedControl(combo, control(0, false)),
				),
			).toStrictEqual([true, true, true, true, true]);
		});

		it("keeps dispatching from the outline's editable text", () => {
			expect(deferToFocusedControl("tab", control(0, true))).toBe(false);
		});

		it("keeps dispatching from elements outside the tab order and for other combos", () => {
			expect({
				unfocusable: deferToFocusedControl("tab", control(-1, false)),
				otherCombo: deferToFocusedControl("meta+s", control(0, false)),
				nothingFocused: deferToFocusedControl("tab", null),
			}).toStrictEqual({unfocusable: false, otherCombo: false, nothingFocused: false});
		});
	});

	describe("keymapCombo", () => {
		const event = {which: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false};

		it("skips combos whose commands the browser or the editor still own", () => {
			expect({
				escape: keymapCombo({...event, which: 27}, true),
				selectUp: keymapCombo({...event, which: 38, shiftKey: true}, true),
				zoomIn: keymapCombo({...event, which: 190, metaKey: true}, true),
			}).toStrictEqual({escape: null, selectUp: null, zoomIn: "meta+."});
		});

		it("dispatches ⌘Home / ⌘End to focus_first / focus_last", () => {
			expect({
				home: keymapCombo({...event, which: 36, metaKey: true}, true),
				end: keymapCombo({...event, which: 35, metaKey: true}, true),
			}).toStrictEqual({home: "meta+home", end: "meta+end"});
		});

		it("dispatches undo and redo combos from the outline", () => {
			expect({
				undo: keymapCombo({...event, which: 90, metaKey: true}, true),
				redo: keymapCombo({...event, which: 90, metaKey: true, shiftKey: true}, true),
				redoY: keymapCombo({...event, which: 89, metaKey: true}, true),
				undoCtrl: keymapCombo({...event, which: 90, ctrlKey: true}, false),
				redoCtrl: keymapCombo({...event, which: 90, ctrlKey: true, shiftKey: true}, false),
			}).toStrictEqual({
				undo: "meta+z",
				redo: "meta+shift+z",
				redoY: "meta+y",
				undoCtrl: "ctrl+z",
				redoCtrl: "ctrl+shift+z",
			});
		});

		it("leaves undo and redo to a focused form field but dispatches its other combos", () => {
			expect({
				undo: keymapCombo({...event, which: 90, metaKey: true}, true, true),
				redo: keymapCombo({...event, which: 90, metaKey: true, shiftKey: true}, true, true),
				zoomIn: keymapCombo({...event, which: 190, metaKey: true}, true, true),
			}).toStrictEqual({undo: null, redo: null, zoomIn: "meta+."});
		});

		it("executes undo on meta+z and redo on meta+shift+z", () => {
			const undo = vi.fn<(ctx: CommandContext) => void>();
			const redo = vi.fn<(ctx: CommandContext) => void>();
			const registry = {undo: {execute: undo}, redo: {execute: redo}};
			expect({
				results: ["meta+z", "meta+shift+z", "meta+y"].map((combo) => processCombo(combo, registry, ctx, true)),
				calls: [undo.mock.calls.length, redo.mock.calls.length],
			}).toStrictEqual({results: ["claimed", "claimed", "claimed"], calls: [1, 2]});
		});

		it("lists the commands the local app leaves to the browser", () => {
			expect([...BROWSER_NATIVE_COMMANDS]).toStrictEqual([
				"select_all",
				"expand_selection_up",
				"expand_selection_down",
				"focus_or_unfocus_search",
			]);
		});
	});

	describe("processAppMessageCombo", () => {
		it("runs the shown message's action bound to the combo once and claims it", () => {
			const view = vi.fn<() => void>();
			const undo = vi.fn<() => void>();
			expect({
				result: processAppMessageCombo("shift+return", [
					{label: "View", shortcut: "shift+return", run: view},
					{label: "Undo", run: undo},
				]),
				view: view.mock.calls,
				undo: undo.mock.calls,
			}).toStrictEqual({result: "claimed", view: [[]], undo: []});
		});

		it("leaves a combo no action binds to the keymap", () => {
			const view = vi.fn<() => void>();
			expect({
				result: processAppMessageCombo("return", [{label: "View", shortcut: "shift+return", run: view}]),
				view: view.mock.calls,
			}).toStrictEqual({result: "unclaimed", view: []});
		});
	});

	describe("processSelectionKey", () => {
		const keydown = (key: string, extra: Partial<SelectionKeyEvent> = {}): SelectionKeyEvent => ({
			key,
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			defaultPrevented: false,
			isComposing: false,
			...extra,
		});
		const selected = {hasSelection: true, inText: false};

		it("runs and claims a key the item selection owns", () => {
			const run = vi.fn<(action: SelectionKeyAction) => void>();
			expect({
				results: [
					processSelectionKey(keydown("ArrowDown", {shiftKey: true}), true, selected, run),
					processSelectionKey(keydown("Backspace"), true, selected, run),
				],
				calls: run.mock.calls,
			}).toStrictEqual({results: ["claimed", "claimed"], calls: [["EXPAND_DOWN"], ["DELETE"]]});
		});

		it("leaves a keydown alone when nothing is selected, focus is in text, an editor already handled it, or it is composing", () => {
			const run = vi.fn<(action: SelectionKeyAction) => void>();
			const shiftDown = keydown("ArrowDown", {shiftKey: true});
			expect({
				results: [
					processSelectionKey(shiftDown, true, {hasSelection: false, inText: false}, run),
					processSelectionKey(shiftDown, true, {hasSelection: true, inText: true}, run),
					processSelectionKey({...shiftDown, defaultPrevented: true}, true, selected, run),
					processSelectionKey({...shiftDown, isComposing: true}, true, selected, run),
					processSelectionKey(keydown("x"), true, selected, run),
				],
				calls: run.mock.calls,
			}).toStrictEqual({
				results: ["unclaimed", "unclaimed", "unclaimed", "unclaimed", "unclaimed"],
				calls: [],
			});
		});
	});

	describe("listenForAppMessageKeys", () => {
		it("listens in the capture phase and claims a matching combo with preventDefault only", () => {
			const view = vi.fn<() => void>();
			let registered: {type: string; handler: (event: never) => void; capture: unknown} | undefined;
			const removed: string[] = [];
			const target = {
				addEventListener: (type: string, handler: (event: never) => void, capture: unknown) => {
					registered = {type, handler, capture};
				},
				removeEventListener: (type: string) => {
					removed.push(type);
				},
			};
			const stop = listenForAppMessageKeys(
				target,
				() => [{label: "View", shortcut: "shift+return", run: view}],
				() => "shift+return",
			);
			const event = {
				preventDefault: vi.fn<() => void>(),
				stopPropagation: vi.fn<() => void>(),
				isComposing: false,
			};
			registered?.handler(event as never);
			stop();
			expect({
				type: registered?.type,
				capture: registered?.capture,
				view: view.mock.calls,
				prevented: event.preventDefault.mock.calls,
				stopped: event.stopPropagation.mock.calls,
				removed,
			}).toStrictEqual({
				type: "keydown",
				capture: true,
				view: [[]],
				prevented: [[]],
				stopped: [],
				removed: ["keydown"],
			});
		});
	});

	describe("print command", () => {
		it("prints once on meta+p and leaves ctrl+p to the browser on mac", () => {
			const print = vi.fn<() => void>();
			expect({
				meta: processCombo("meta+p", {print: printCommand(print)}, ctx, true),
				afterMeta: print.mock.calls.length,
				ctrl: processCombo("ctrl+p", {print: printCommand(print)}, ctx, true),
				afterCtrl: print.mock.calls.length,
			}).toStrictEqual({meta: "claimed", afterMeta: 1, ctrl: "unclaimed", afterCtrl: 1});
		});
	});

	describe("present_it command", () => {
		it("expands the focused item and opens the presentation on the zoomed node", () => {
			const open = vi.fn<(nodeId: string) => void>();
			const expand = vi.fn<(nodeId: string) => void>();
			const registry = {present_it: presentCommand({open, expand})};
			expect({
				result: processCombo("meta+shift+p", registry, {items: ["a"], zoomedId: "z"}, true),
				expand: expand.mock.calls,
				open: open.mock.calls,
			}).toStrictEqual({result: "claimed", expand: [["a"]], open: [["z"]]});
		});

		it("opens the root presentation and expands nothing with no focused item", () => {
			const open = vi.fn<(nodeId: string) => void>();
			const expand = vi.fn<(nodeId: string) => void>();
			processCombo(
				"meta+shift+p",
				{present_it: presentCommand({open, expand})},
				{items: [], zoomedId: null},
				true,
			);
			expect({expand: expand.mock.calls, open: open.mock.calls}).toStrictEqual({expand: [], open: [["root"]]});
		});
	});
});

describe("keys hint", () => {
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

	describe("hint", () => {
		it("formats each command's first mac combo the way upstream's hotkeys panel does", () => {
			expect(Object.fromEntries(COMMANDS.map((command) => [command, hint(command)]))).toStrictEqual({
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
			});
		});

		it("spells modifiers out and joins with + off mac", () => {
			expect(
				Object.fromEntries(
					["navigate_to_today", "previous_unread"].map((command) => [command, hint(command, false)]),
				),
			).toStrictEqual({
				navigate_to_today: "Alt+T",
				previous_unread: "Alt+Ctrl+P",
			});
		});

		it("spells the off-mac complete chip as Ctrl+Enter", () => {
			expect(hint("complete", false)).toBe("Ctrl+Enter");
		});

		it("derives off-mac chips from the off-mac table with upstream's arrow and space glyphs", () => {
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
			).toStrictEqual({
				zoom_in: "Alt+↓",
				toggle_rightbar: "Ctrl+/",
				move_up: "Alt+Shift+↑",
				expand: "Ctrl+↓",
				toggle_ai_item: "Alt+Shift+Space",
				delete: "Ctrl+Shift+Backspace",
				focus_or_open_pane_1: "Alt+1",
			});
		});

		it("is undefined for an unbound command", () => {
			expect(hint("no_such_command")).toBeUndefined();
		});

		it("lists the mac table in upstream insertion order", () => {
			expect(MAC_HOTKEYS.slice(0, 3)).toStrictEqual([
				["meta+shift+backspace", "delete"],
				["meta+shift+8", "star_current_item"],
				["meta+return", "complete"],
			]);
		});
	});
});
