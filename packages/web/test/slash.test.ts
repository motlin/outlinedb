import {readFileSync} from "node:fs";
import {describe, expect, it, afterEach, vi} from "vite-plus/test";
import {FA_ICONS} from "../src/client/components/fa-icons.js";
import type {SlashCommandKey} from "../src/client/slash-commands.js";
import {LOCAL_SLASH_AVAILABLE, SLASH_COMMANDS, SLASH_MENU_KEYS, resolveSlash} from "../src/client/slash-commands.js";
import {evalMath} from "../src/client/slash-math.js";
import {menuKeyboard} from "../src/client/components/flyout/menu-keyboard.js";
import type {MenuKeyboardState} from "../src/client/components/flyout/menu-keyboard.js";
import {slashKeyAction, slashMode} from "../src/client/slash-menu-state.js";
import type {SlashKeyAction, SlashKeyInput} from "../src/client/slash-menu-state.js";
import {QueryClient} from "@tanstack/react-query";
import {
	EMPTY_PREFERENCES,
	markSlashDiscovered,
	preferenceKeys,
	slashDiscoveredFrom,
} from "../src/client/hooks/use-preferences.js";
import type {PreferencesState} from "../src/client/hooks/use-preferences.js";
import {
	placeholderFor,
	planSlashOpen,
	planSlashRearm,
	SLASH_CHIP_CLASS,
	stripSlashChip,
} from "../src/client/slash-trigger.js";

describe("slash commands", () => {
	const HIDDEN_ON_PLAIN_ROW: ReadonlySet<string> = new Set([
		"toggle_ai_item",
		"delete_file",
		"ask_ai",
		"show_mirror_breadcrumbs",
		"detach_mirror",
		"swap_mirror_origin",
		"insert_board_column_left",
		"insert_board_column_right",
		"ai_item_summarize",
		"ai_item_find_tasks",
		"ai_item_draft_outline",
		"ai_item_fix_grammar",
		"ai_item_shorten",
		"set_priority_default_top",
		"toggle_good_dashboard",
		"show_treemap",
	]);

	const plainRow = {available: (key: SlashCommandKey) => !HIDDEN_ON_PLAIN_ROW.has(key)};

	const PLAIN_ROW_LABELS = [
		"Bullets",
		"Board",
		"Table",
		"To-do",
		"Heading 1",
		"Heading 2",
		"Heading 3",
		"Paragraph",
		"Quote",
		"Code Block",
		"Divider",
		"Shortcut",
		"Upload file",
		"Number",
		"Complete",
		"Add date",
		"Add comment",
		"Add note",
		"Open in Pane",
		"Duplicate",
		"Move To...",
		"Move Here...",
		"Move To Child...",
		"Move to Today",
		"Move to Tomorrow",
		"Move to Next Week",
		"Move to Date...",
		"Share",
		"Export",
		"Mirror",
		"Mirror To...",
		"Mirror To Child...",
		"Mirror Here...",
		"Mirror to Today",
		"Mirror to Date...",
		"Expand all",
		"Collapse all",
		"Sort A-Z",
		"Sort Z-A",
		"Copy internal link",
		"Add from template",
		"Delete",
		"Count",
		"Priority: Default to Bottom",
		"Show Command Palette",
	];

	describe("SLASH_MENU_KEYS", () => {
		it("has the 61 upstream keys, 45 of which render on a plain row", () => {
			expect(SLASH_MENU_KEYS).toHaveLength(61);
			expect(SLASH_MENU_KEYS.filter((key) => plainRow.available(key))).toHaveLength(45);
		});

		it("maps every rendered command to an icon in the shared FA map", () => {
			const missing = Object.values(SLASH_COMMANDS)
				.map((command) => command.icon)
				.filter((icon) => !(icon in FA_ICONS));
			expect(missing).toStrictEqual([]);
		});
	});

	describe("resolveSlash", () => {
		it("lists the 45 plain-row commands in upstream order for a bare slash", () => {
			const groups = resolveSlash(" /", plainRow);
			expect(groups?.map((group) => group.name)).toStrictEqual(["Actions"]);
			expect(groups?.[0]?.options.map((option) => option.label)).toStrictEqual(PLAIN_ROW_LABELS);
		});

		it("carries key and icon on each option", () => {
			expect(resolveSlash("/h1", plainRow)).toStrictEqual([
				{name: "Actions", options: [{key: "toggle_h1", label: "Heading 1", icon: "fal:h1"}]},
			]);
		});

		it("filters fuzzily and ranks by score with a stable sort", () => {
			expect(resolveSlash(" /mo", plainRow)?.[0]?.options.map((option) => option.label)).toStrictEqual([
				"Move To...",
				"Move Here...",
				"Move To Child...",
				"Move to Today",
				"Move to Tomorrow",
				"Move to Next Week",
				"Move to Date...",
				"Mirror",
				"Mirror To...",
				"Mirror To Child...",
				"Mirror Here...",
				"Mirror to Today",
				"Mirror to Date...",
			]);
			expect(resolveSlash(" /ex", plainRow)?.[0]?.options.map((option) => option.label)).toStrictEqual([
				"Export",
				"Expand all",
				"Move to Next Week",
			]);
		});

		it("drops unavailable commands", () => {
			expect(resolveSlash("/", {available: (key) => key === "complete" || key === "ask_ai"})).toStrictEqual([
				{name: "Actions", options: [{key: "complete", label: "Complete", icon: "fal:check"}]},
			]);
		});

		it("returns null when the term starts with whitespace", () => {
			expect(resolveSlash("/ x", plainRow)).toBeNull();
		});

		it("falls back to the math group", () => {
			expect(resolveSlash(" /2*3", {...plainRow, evalMath: () => "6"})).toStrictEqual([
				{name: "=", options: [{label: "6"}]},
			]);
			expect(resolveSlash(" /2*", {...plainRow, evalMath: () => "incomplete"})).toStrictEqual([
				{name: "=", options: [{label: "...", noop: true}]},
			]);
		});

		it("returns null when neither commands nor math match", () => {
			expect(resolveSlash(" /moq", plainRow)).toBeNull();
			expect(resolveSlash(" /moq", {...plainRow, evalMath: () => null})).toBeNull();
		});
	});

	describe("LOCAL_SLASH_AVAILABLE", () => {
		it("offers only the commands with a local executor, in upstream order", () => {
			expect(
				resolveSlash(" /", {available: LOCAL_SLASH_AVAILABLE})?.[0]?.options.map((o) => o.label),
			).toStrictEqual([
				"Bullets",
				"Board",
				"Table",
				"To-do",
				"Heading 1",
				"Heading 2",
				"Heading 3",
				"Paragraph",
				"Quote",
				"Code Block",
				"Divider",
				"Number",
				"Complete",
				"Add date",
				"Add note",
				"Open in Pane",
				"Duplicate",
				"Move To...",
				"Move to Today",
				"Move to Tomorrow",
				"Move to Next Week",
				"Move to Date...",
				"Export",
				"Mirror",
				"Mirror To...",
				"Mirror To Child...",
				"Mirror Here...",
				"Mirror to Today",
				"Mirror to Date...",
				"View mirrors",
				"Detach Mirror",
				"Expand all",
				"Collapse all",
				"Sort A-Z",
				"Sort Z-A",
				"Copy internal link",
				"Insert column left",
				"Insert column right",
				"Delete",
				"Show Command Palette",
			]);
		});

		it("carries key and icon for /palette", () => {
			expect(resolveSlash("/palette", {available: LOCAL_SLASH_AVAILABLE})).toStrictEqual([
				{
					name: "Actions",
					options: [{key: "show_command_palette", label: "Show Command Palette", icon: "fal:palette"}],
				},
			]);
		});

		it("matches Add date for /add d", () => {
			expect(
				resolveSlash(" /add d", {available: LOCAL_SLASH_AVAILABLE})?.[0]?.options.map((o) => o.label),
			).toStrictEqual(["Add date"]);
		});

		it("has a command-registry executor for every locally available key, and the slash hook gates on it", () => {
			const registry = readFileSync(
				new URL("../src/client/hooks/use-command-registry.ts", import.meta.url),
				"utf8",
			);
			const hook = readFileSync(new URL("../src/client/hooks/use-slash-menu.tsx", import.meta.url), "utf8");
			expect({
				missing: SLASH_MENU_KEYS.filter(
					(key) => LOCAL_SLASH_AVAILABLE(key) && !new RegExp(`^\\t\\t${key}: `, "mu").test(registry),
				),
				gated: hook.includes("LOCAL_SLASH_AVAILABLE(key)"),
			}).toStrictEqual({missing: [], gated: true});
		});
	});
});

describe("slash math", () => {
	describe("evalMath", () => {
		it("returns the result as a string", () => {
			expect(evalMath("2*3")).toBe("6");
			expect(evalMath("10/4")).toBe("2.5");
		});

		it("returns incomplete while the expression is still being typed", () => {
			expect(evalMath("2*")).toBe("incomplete");
		});

		it("returns null for anything that is not math", () => {
			expect(evalMath("abc")).toBeNull();
		});
	});
});

describe("slash menu state", () => {
	const input = (key: string, extra: Partial<SlashKeyInput> = {}): SlashKeyInput => ({
		key,
		ctrlKey: false,
		metaKey: false,
		caretAtChipEnd: false,
		...extra,
	});

	describe("slashKeyAction", () => {
		it.each<[string, SlashKeyInput, SlashKeyAction | null]>([
			["ArrowDown", input("ArrowDown"), "down"],
			["Ctrl+N", input("n", {ctrlKey: true}), "down"],
			["ArrowUp", input("ArrowUp"), "up"],
			["Ctrl+P", input("p", {ctrlKey: true}), "up"],
			["Enter", input("Enter"), "select"],
			["Tab", input("Tab"), "select"],
			["Escape", input("Escape"), "abandon"],
			["ArrowRight at chip end", input("ArrowRight", {caretAtChipEnd: true}), "abandon"],
			["ArrowRight inside chip", input("ArrowRight"), null],
			["Meta+Z", input("z", {metaKey: true}), "disarmNoAbandon"],
			["Ctrl+Z", input("z", {ctrlKey: true}), "disarmNoAbandon"],
			["plain z", input("z"), null],
			["Ctrl+X", input("x", {ctrlKey: true}), null],
		])("%s", (_name, event, expected) => {
			expect(slashKeyAction(event)).toStrictEqual(expected);
		});
	});

	describe("slashMode", () => {
		const keyboardAt2: MenuKeyboardState = {index: 2, hidden: false, keyboardMode: true};

		it("mouseMove leaves the index and enters mouse mode", () => {
			expect(slashMode(keyboardAt2, {type: "mouseMove"})).toStrictEqual({
				index: 2,
				hidden: false,
				keyboardMode: false,
			});
		});

		it("hover then ArrowDown continues from the hovered row in keyboard mode", () => {
			const mouse = slashMode(keyboardAt2, {type: "mouseMove"});
			const hovered = slashMode(mouse, {type: "hover", index: 4});
			expect(hovered).toStrictEqual({index: 4, hidden: false, keyboardMode: false});
			const down = menuKeyboard(
				hovered,
				{key: "ArrowDown", ctrlKey: false, shiftKey: false, composing: false},
				{count: 13, cyclic: true, selectOnTab: true, stopPropagation: true},
			);
			expect(down.state).toStrictEqual({index: 5, hidden: false, keyboardMode: true});
		});
	});
});

describe("slash trigger", () => {
	describe("planSlashOpen", () => {
		it.each([
			["Slash Alpha /", 12, {start: 11, end: 13}],
			["/", 0, {start: 0, end: 1}],
			["Betax/", 5, null],
			["a / b", 2, {start: 2, end: 3}],
			["a /b", 2, null],
			["/b", 0, {start: 0, end: 1}],
			["a\t/", 2, {start: 1, end: 3}],
		] as const)("planSlashOpen(%j, %i)", (text, slashIndex, expected) => {
			expect(planSlashOpen(text, slashIndex)).toStrictEqual(expected);
		});
	});

	describe("planSlashRearm", () => {
		it.each([
			["Slash Alpha /mo", 15, {start: 11, end: 15}],
			["x/mo", 4, null],
			["a / mo", 6, null],
			["/mo", 3, {start: 0, end: 3}],
			["a /mo", 4, {start: 1, end: 4}],
			["a /abcdefghij", 13, null],
			["a /abcdefgh", 11, {start: 1, end: 11}],
			["plain", 5, null],
		] as const)("planSlashRearm(%j, %i)", (text, caret, expected) => {
			expect(planSlashRearm(text, caret)).toStrictEqual(expected);
		});
	});

	describe("stripSlashChip", () => {
		it("unwraps the chip span to its text", () => {
			expect(
				stripSlashChip(
					'Slash Alpha<span class="slash-input bg-tertiary py-2xs pr-xs pl-xs rounded-s leading-none"> /mo</span>',
				),
			).toBe("Slash Alpha /mo");
		});

		it("returns HTML without a chip unchanged", () => {
			const html = 'a <b>bold</b> <span class="colored c-red">red</span> /x';
			expect(stripSlashChip(html)).toBe(html);
		});

		it("exports the upstream chip class", () => {
			expect(SLASH_CHIP_CLASS).toBe("slash-input bg-tertiary py-2xs pr-xs pl-xs rounded-s leading-none");
		});
	});

	describe("placeholderFor", () => {
		it.each([
			[{focused: true, empty: true, layoutMode: "bullets", slashDiscovered: false}, 'Type "/" for commands'],
			[{focused: true, empty: true, layoutMode: undefined, slashDiscovered: false}, 'Type "/" for commands'],
			[{focused: true, empty: true, layoutMode: "bullets", slashDiscovered: true}, undefined],
			[{focused: true, empty: true, layoutMode: "divider", slashDiscovered: false}, undefined],
			[{focused: true, empty: true, layoutMode: "numbered", slashDiscovered: false}, undefined],
			[{focused: true, empty: true, layoutMode: "code-block", slashDiscovered: false}, undefined],
			[{focused: true, empty: true, layoutMode: "quote-block", slashDiscovered: false}, undefined],
			[{focused: false, empty: true, layoutMode: "divider", isZoomRoot: true}, undefined],
			[{focused: false, empty: true, layoutMode: "code-block", isZoomRoot: true}, undefined],
			[{focused: false, empty: true, layoutMode: "h1", isZoomRoot: true}, "Untitled"],
			[{focused: false, empty: true, layoutMode: "bullets", slashDiscovered: false}, undefined],
			[{focused: true, empty: false, layoutMode: "bullets", slashDiscovered: false}, undefined],
			[{isZoomRoot: true, empty: true, focused: false}, "Untitled"],
			[{isZoomRoot: true, empty: true, focused: true, slashDiscovered: true}, "Untitled"],
			[{isZoomRoot: true, empty: false, focused: false}, undefined],
		] as const)("placeholderFor(%j)", (input, expected) => {
			expect(placeholderFor(input)).toBe(expected);
		});
	});

	function preferencesClient(state: PreferencesState | undefined): QueryClient {
		const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
		if (state !== undefined) {
			queryClient.setQueryData(preferenceKeys.all, state);
		}
		return queryClient;
	}

	const AVAILABLE = (slashDiscovered: boolean): PreferencesState => ({
		preferences: {...EMPTY_PREFERENCES, slashDiscovered},
		available: true,
		error: null,
	});

	describe("slashDiscoveredFrom", () => {
		it("is true while loading or unavailable so the hint never flashes", () => {
			expect({
				loading: slashDiscoveredFrom(undefined),
				unavailable: slashDiscoveredFrom({preferences: EMPTY_PREFERENCES, available: false, error: "x"}),
				undiscovered: slashDiscoveredFrom(AVAILABLE(false)),
				discovered: slashDiscoveredFrom(AVAILABLE(true)),
			}).toStrictEqual({loading: true, unavailable: true, undiscovered: false, discovered: true});
		});
	});

	describe("markSlashDiscovered", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function stubFetch(): {url: string; method: string; body: unknown}[] {
			const requests: {url: string; method: string; body: unknown}[] = [];
			vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
				requests.push({url, method: init?.method ?? "GET", body: init?.body});
				return Promise.resolve(Response.json({...EMPTY_PREFERENCES, slashDiscovered: true}));
			});
			return requests;
		}

		it("PATCHes slashDiscovered once when it is false", async () => {
			const requests = stubFetch();
			const queryClient = preferencesClient(AVAILABLE(false));
			await markSlashDiscovered(queryClient);
			await markSlashDiscovered(queryClient);
			expect(requests).toStrictEqual([
				{url: "/api/v1/preferences", method: "PATCH", body: '{"slashDiscovered":true}'},
			]);
		});

		it("issues no request when already discovered, loading or unavailable", async () => {
			const requests = stubFetch();
			await markSlashDiscovered(preferencesClient(AVAILABLE(true)));
			await markSlashDiscovered(preferencesClient(undefined));
			await markSlashDiscovered(
				preferencesClient({preferences: EMPTY_PREFERENCES, available: false, error: "x"}),
			);
			expect(requests).toStrictEqual([]);
		});
	});
});

describe("slash wiring", () => {
	function source(path: string): string {
		return readFileSync(new URL(`../src/client/components/${path}`, import.meta.url), "utf8");
	}

	/** The body of the `const <name> = useCallback(` declaration, up to its dependency list. */
	function callbackBody(text: string, name: string): string {
		const start = text.indexOf(`const ${name} = useCallback(`);
		if (start === -1) {
			return "";
		}
		const end = text.indexOf("\n\t}, [", start);
		return text.slice(start, end === -1 ? undefined : end);
	}

	describe("slash menu wiring", () => {
		it("wires useSlashMenu into both editors' input and keydown, and strips the chip in their save paths", () => {
			const files = [
				["editable-text.tsx", "saveInPlace"],
				["editable-note.tsx", "saveNow"],
			] as const;
			expect(
				files.map(([file, save]) => {
					const text = source(file);
					return [
						file,
						text.includes('import {useSlashMenu} from "../hooks/use-slash-menu.js";'),
						text.includes("onInput={handleInput}"),
						/handleSlashInput\(/u.test(callbackBody(text, "handleInput")),
						/^\t{3}if \(handleSlashKey\(event\)\) \{$/mu.test(callbackBody(text, "handleKeyDown")),
						callbackBody(text, save).includes("stripSlashChip("),
					];
				}),
			).toStrictEqual([
				["editable-text.tsx", true, true, true, true, true],
				["editable-note.tsx", true, true, true, true, true],
			]);
		});

		it("passes evalMath to resolveSlash so /2*3 offers the = math group", () => {
			const text = readFileSync(new URL("../src/client/hooks/use-slash-menu.tsx", import.meta.url), "utf8");
			expect([
				text.includes('import {evalMath} from "../slash-math.js";'),
				/resolveSlash\(chipText, \{[\s\S]*?\n\t\tevalMath,\n\t\}\);/u.test(text),
			]).toStrictEqual([true, true]);
		});
	});
});
