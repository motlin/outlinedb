import {describe, expect, it, afterEach, beforeEach, vi} from "vite-plus/test";
import {APP_MENU_CONFIG} from "../src/client/app-menu-config.js";
import fixture from "./fixtures/upstream-menu-config.json" with {type: "json"};
import {assembleFlatForId, assembleMenu, qualifyItemMenu, qualifyMultiSelect} from "../src/client/app-menu.js";
import type {AssembledEntry, MenuConfig} from "../src/client/app-menu.js";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {versionLabel, versionTags} from "../src/client/app-version.js";

describe("app menu config", () =>
{
	describe("APP_MENU_CONFIG", () =>
	{
		it("holds upstream's ordered menus, with false flags", () =>
		{
			expect(
				Object.fromEntries(
					Object.entries(APP_MENU_CONFIG.orderedUi).map(([menu, keys]) => [
						menu,
						keys.map(([id, flag]) => (flag ? id : `${id}:false`)),
					]),
				),
			).toStrictEqual(fixture.ordered_ui);
		});

		it("holds upstream's active and block sets", () =>
		{
			const asSets = (sets: Record<string, readonly string[]>) =>
				Object.fromEntries(
					Object.entries(sets).map(([key, ids]) => [key, Object.fromEntries(ids.map((id) => [id, true]))]),
				);
			expect(
				{
					active: asSets(APP_MENU_CONFIG.activeSets),
					block: asSets(APP_MENU_CONFIG.blockSets),
				},
			).toStrictEqual(
				{
					active: fixture.menu_active_set,
					block: fixture.menu_block_set,
				},
			);
		});

		it("marks node_type_picker as the one submenu with its label and icon", () =>
		{
			expect(
				{
					submenus: [...APP_MENU_CONFIG.isSubmenu],
					labels: APP_MENU_CONFIG.labels,
					icons: APP_MENU_CONFIG.icons,
				},
			).toStrictEqual(
				{
					submenus: Object.keys(fixture.is_submenu),
					labels: fixture.ui_label,
					icons: fixture.icon,
				},
			);
		});
	});
});

describe("app menu", () =>
{
	function fromDump(dump: typeof fixture): MenuConfig
	{
		return {
			orderedUi: Object.fromEntries(
				Object.entries(dump.ordered_ui).map(([menu, keys]) => [
					menu,
					keys.map((key): [string, boolean] =>
					{
						const [id = "", flag] = key.split(":");
						return [id, flag !== "false"];
					}),
				]),
			),
			isSubmenu: new Set(Object.keys(dump.is_submenu)),
			activeSets: Object.fromEntries(
				Object.entries(dump.menu_active_set).map(([key, set]) => [key, Object.keys(set)]),
			),
			blockSets: Object.fromEntries(
				Object.entries(dump.menu_block_set).map(([key, set]) => [key, Object.keys(set)]),
			),
			labels: dump.ui_label,
			icons: dump.icon,
		};
	}

	const config: MenuConfig =
	{
		...fromDump(fixture),
	};
	const probeConfig: MenuConfig =
	{
		...config,
		activeSets:
		{
			...config.activeSets,
			"single_node_menu :: probe_q": ["delete", "delete_dates", "expand_all", "node_type_picker"],
			"single_node_menu :: empty_q": [],
		},
	};

	const UNAVAILABLE = new Set([
		"ask_ai",
		"mark_read",
		"mark_unread",
		"take_photo",
		"upload_image",
		"detach_mirror",
		"mcp_agents",
		"toggle_todo_mode",
	]);
	const lookup = (id: string): string | null => (UNAVAILABLE.has(id) ? null : id);

	function tokens(entries: AssembledEntry<string>[]): string
	{
		return entries
			.map((entry) =>
			{
				if (entry.kind === "separator")
				{
					return "|";
				}
				return entry.kind === "submenu" ? `[${entry.id}]` : entry.id;
			})
			.join(" ")
			.replaceAll(/ ?\| ?/gu, " | ")
			.trim();
	}

	function single(qualifiers: string[], cfg: MenuConfig = probeConfig): string
	{
		return tokens(assembleMenu("single_node_menu", qualifiers, lookup, cfg));
	}

	describe("assembleMenu single_node_menu", () =>
	{
		it("lists the full menu in config order with one separator between groups", () =>
		{
			expect(single([])).toBe(
				"[node_type_picker] | open_in_pane complete add_note add_date present_it comment move_to move_to_today move_to_tomorrow move_to_next_week move_to_date upload_file mirror_to mirror duplicate | share show_export copy_link make_template | delete | expand_all collapse_all sort_children_asc sort_children_desc",
			);
		});

		it("shows only the active set for a divider", () =>
		{
			expect(single(["is_divider"])).toBe(
				"[node_type_picker] | move_to duplicate | copy_link | delete | expand_all collapse_all",
			);
		});

		it("removes blocked ids for code blocks", () =>
		{
			expect(single(["is_code_block"])).toBe(
				"[node_type_picker] | open_in_pane complete add_note comment move_to move_to_today move_to_tomorrow move_to_next_week move_to_date upload_file mirror_to mirror duplicate | share show_export copy_link | delete | expand_all collapse_all sort_children_asc sort_children_desc",
			);
		});

		it("shows only Delete for dangling nodes, whatever else applies", () =>
		{
			expect([single(["is_dangling"]), single(["is_divider", "is_dangling"])]).toStrictEqual([
				"delete",
				"delete",
			]);
		});

		it("intersects the active sets of several qualifiers", () =>
		{
			expect(single(["is_ai_item", "is_divider"])).toBe("[node_type_picker] | move_to duplicate | delete");
		});

		it("unions block sets with active sets", () =>
		{
			expect(single(["is_divider", "is_readonly"])).toBe(
				"move_to duplicate | copy_link | delete | expand_all collapse_all",
			);
		});

		it("lets an active set override a base false flag", () =>
		{
			expect(single(["is_table_header_cell"])).toBe(
				"[node_type_picker] | complete add_note add_date upload_file duplicate_table_column | delete_table_column",
			);
		});

		it("shows the comment menu", () =>
		{
			expect(single(["is_bullets", "is_comment", "is_comment_not_draft"])).toBe(
				"focus_name add_note mirror_to mirror | share show_export copy_link | delete",
			);
		});

		it("appends active ids missing from the config walk after one separator", () =>
		{
			expect(single(["probe_q"])).toBe("[node_type_picker] | delete | expand_all | delete_dates");
		});

		it("yields nothing for an empty active set and an unknown menu", () =>
		{
			expect([single(["empty_q"]), tokens(assembleMenu("nope", [], lookup, config))]).toStrictEqual(["", ""]);
		});

		it("ignores qualifiers with no table entry", () =>
		{
			expect(single(["is_bullets"])).toBe(single([]));
		});
	});

	describe("assembleMenu multi_select_menu", () =>
	{
		const multi = (qualifiers: string[]): string =>
			tokens(assembleMenu("multi_select_menu", qualifiers, lookup, config));

		it("separates the four groups", () =>
		{
			expect(multi([])).toBe(
				"toggle_h1 toggle_h2 toggle_h3 toggle_paragraph toggle_code_block toggle_quote_block toggle_bullet toggle_numbered | toggle_bold toggle_italic toggle_underline toggle_strikethrough toggle_code show_color_popup | complete move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror mirror_to mirror_to_today mirror_to_date show_export | delete",
			);
		});

		it("drops move and mirror commands when an item is in a pane", () =>
		{
			expect(multi(["has_pane_item"])).toBe(
				"toggle_h1 toggle_h2 toggle_h3 toggle_paragraph toggle_code_block toggle_quote_block toggle_bullet toggle_numbered | toggle_bold toggle_italic toggle_underline toggle_strikethrough toggle_code show_color_popup | complete show_export | delete",
			);
		});

		it("restricts the menu for table cells", () =>
		{
			expect(multi(["has_table_cell"])).toBe(
				"toggle_bullet | toggle_bold toggle_italic toggle_underline toggle_strikethrough | complete move_to mirror mirror_to show_export | delete",
			);
		});

		it("hides the whole menu for comment paragraphs", () =>
		{
			expect(multi(["all_comment_paragraphs"])).toBe("");
		});
	});

	describe("assembleFlatForId", () =>
	{
		it("returns nothing for a menu made of groups", () =>
		{
			expect(assembleFlatForId("single_node_menu", [], lookup, config)).toStrictEqual([]);
		});

		it("applies block sets only", () =>
		{
			const flat = (qualifiers: string[]) =>
				assembleFlatForId("node_type_picker", qualifiers, lookup, config).map((entry) =>
					entry.kind === "command" ? entry.id : "?",
				);
			expect([
				flat([]).includes("turn_into_dashboard"),
				flat(["is_inside_side_pane"]).includes("turn_into_dashboard"),
			]).toStrictEqual([true, false]);
			expect(flat(["is_divider"])).toStrictEqual(flat([]));
		});
	});

	describe("qualifyItemMenu", () =>
	{
		it("derives the layout qualifier", () =>
		{
			expect([
				qualifyItemMenu(
					{
						data:
						{
							layoutMode: null,
						},
					},
				),
				qualifyItemMenu(
					{
						data:
						{
							layoutMode: "quote-block",
						},
					},
				),
				qualifyItemMenu(
					{
						data:
						{
							layoutMode: "code-block",
						},
					},
				),
			]).toStrictEqual([["is_bullets"], ["is_quote_block"], ["is_code_block"]]);
		});

		it("returns only is_dangling when the original is missing", () =>
		{
			expect(
				qualifyItemMenu(
					{
						isOriginalNotFound: true,
						data:
						{
							layoutMode: "divider",
						},
					},
					["is_comment"],
				),
			).toStrictEqual(["is_dangling"]);
		});

		it("adds is_readonly except on the main document root", () =>
		{
			expect([
				qualifyItemMenu(
					{
						readOnly: true,
						data:
						{
							layoutMode: null,
						},
					},
				),
				qualifyItemMenu(
					{
						readOnly: true,
						isMainDocumentRoot: true,
						data:
						{
							layoutMode: null,
						},
					},
				),
			]).toStrictEqual([["is_bullets", "is_readonly"], ["is_bullets"]]);
		});

		it("adds is_comment_not_draft for comments that are not drafts", () =>
		{
			expect([
				qualifyItemMenu(
					{
						data:
						{
							layoutMode: null,
						},
					},
					["is_comment"],
				),
				qualifyItemMenu(
					{
						data:
						{
							layoutMode: null,
						},
					},
					["is_comment", "is_draft"],
				),
			]).toStrictEqual([
				["is_comment", "is_bullets", "is_comment_not_draft"],
				["is_comment", "is_draft", "is_bullets"],
			]);
		});
	});

	describe("qualifyMultiSelect", () =>
	{
		const flags =
		{
			inSidePane: (id: string) => id === "pane",
			isTableCell: (id: string) => id === "cell",
		};

		it("flags pane items and table cells", () =>
		{
			expect([
				qualifyMultiSelect(["a", "b"], flags),
				qualifyMultiSelect(["a", "pane"], flags),
				qualifyMultiSelect(["cell", "pane"], flags),
			]).toStrictEqual([[], ["has_pane_item"], ["has_pane_item", "has_table_cell"]]);
		});
	});
});

describe("app message", () =>
{
	function stripPaths(markup: string): string
	{
		return markup.replaceAll(/ d="[^"]*"/gu, ' d=""');
	}

	const CHECK_ICON =
		'<div class="h-full flex items-center"><svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="circle-check" class="svg-inline--fa fa-circle-check fa-lg text-success" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d=""></path></svg></div>';
	function icon(name: string, color: string): string
	{
		return `<div class="h-full flex items-center"><svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="${name}" class="svg-inline--fa fa-${name} fa-lg ${color}" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d=""></path></svg></div>`;
	}
	const CLOSE =
		'<div class="h-full flex items-center"><span class="p-s cursor-pointer text-tertiary"><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="xmark" class="svg-inline--fa fa-xmark fa-1x " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path fill="currentColor" d=""></path></svg></span></div>';
	const OPEN =
		'<div class="flex justify-center fixed left-0 right-0 leading-xs" style="z-index:500;bottom:calc(72px + var(--safe-area-inset-bottom))"><div class="flex flex-row max-w-[90vw] gap-ml px-m shadow-sm bg-primary border border-solid border-primary rounded-s">';

	function stubGlobals(): void
	{
		vi.stubGlobal(
			"localStorage",
			{
				getItem: () => null,
				setItem: () =>
				{
				},
				removeItem: () =>
				{
				},
			},
		);
		vi.stubGlobal("innerWidth", 1272);
		vi.stubGlobal("matchMedia", () => (
		{
			matches: false,
			addEventListener: () =>
			{
			},
		}));
		vi.stubGlobal(
			"document",
			{
				documentElement:
				{
					dataset: {},
				},
				body:
				{
					classList:
					{
						toggle: () => true,
						contains: () => false,
					},
				},
			},
		);
		vi.stubGlobal("addEventListener", () => {});
	}

	async function loadStore()
	{
		vi.resetModules();
		stubGlobals();
		const {useOutlineStore} = await import("../src/client/stores/outline.js");
		return useOutlineStore;
	}

	async function loadAppMessage()
	{
		stubGlobals();
		const {AppMessage} = await import("../src/client/components/app-message.js");
		return AppMessage;
	}

	describe("AppMessage markup", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("renders upstream's success toast", async () =>
		{
			const AppMessage = await loadAppMessage();
			expect(
				stripPaths(
					renderToStaticMarkup(
						createElement(
							AppMessage,
							{
								text: "Link copied.",
							},
						),
					),
				),
			).toBe(
				`${OPEN}${CHECK_ICON}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Link copied.</div>${CLOSE}</div></div>`,
			);
		});

		it("renders a failure toast with the red circle-exclamation icon", async () =>
		{
			const AppMessage = await loadAppMessage();
			const markup = stripPaths(
				renderToStaticMarkup(
					createElement(
						AppMessage,
						{
							text: "Can't move to 'X'",
							type: "failure",
						},
					),
				),
			);
			expect(markup).toBe(
				`${OPEN}${icon("circle-exclamation", "text-danger")}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Can&#x27;t move to &#x27;X&#x27;</div>${CLOSE}</div></div>`,
			);
		});

		it("renders a warning toast with the amber triangle-exclamation icon", async () =>
		{
			const AppMessage = await loadAppMessage();
			const markup = stripPaths(
				renderToStaticMarkup(
					createElement(
						AppMessage,
						{
							text: "Careful",
							type: "warning",
						},
					),
				),
			);
			expect(markup).toBe(
				`${OPEN}${icon("triangle-exclamation", "text-warning")}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Careful</div>${CLOSE}</div></div>`,
			);
		});

		it("raises the toast above an open dialog with zIndex 1100", async () =>
		{
			const AppMessage = await loadAppMessage();
			expect(
				stripPaths(
					renderToStaticMarkup(
						createElement(
							AppMessage,
							{
								text: "x",
								zIndex: 1100,
							},
						),
					),
				),
			).toBe(
				`${OPEN.replace("z-index:500", "z-index:1100")}${CHECK_ICON}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">x</div>${CLOSE}</div></div>`,
			);
		});

		it("renders action buttons between the text and the close button", async () =>
		{
			const AppMessage = await loadAppMessage();
			expect(
				stripPaths(
					renderToStaticMarkup(
						createElement(
							AppMessage,
							{
								text: "Moved to",
								actions: [
									{
										label: "View",
										shortcut: "shift+return",
										run: () =>
										{
										},
									},
									{
										label: "Undo",
										run: () =>
										{
										},
									},
								],
							},
						),
					),
				),
			).toBe(
				`${OPEN}${CHECK_ICON}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Moved to</div>` +
					'<div class="flex items-center text-primary content-end font-medium desktop:hover:underline cursor-pointer" style="height:100%"><div class="flex items-baseline"><span class="">View</span><span class="mobile:hidden text-s text-tertiary font-normal ml-xs">(shift+return)</span></div></div>' +
					'<div class="flex items-center text-primary content-end font-medium desktop:hover:underline cursor-pointer" style="height:100%"><div class="flex items-baseline"><span class="">Undo</span></div></div>' +
					`${CLOSE}</div></div>`,
			);
		});
	});

	describe("showAppMessage", () =>
	{
		beforeEach(() =>
		{
			vi.useFakeTimers();
		});

		afterEach(() =>
		{
			vi.useRealTimers();
			vi.unstubAllGlobals();
		});

		it("shows the message and clears it after the timeout", async () =>
		{
			const store = await loadStore();
			store.getState().showAppMessage(
				"x",
				{
					timeout: 1000,
				},
			);
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "x",
					type: "success",
					actions: [],
				},
			);
			vi.advanceTimersByTime(999);
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "x",
					type: "success",
					actions: [],
				},
			);
			vi.advanceTimersByTime(1);
			expect(store.getState().appMessage).toBeNull();
		});

		it("replaces the current message and drops its pending timeout", async () =>
		{
			const store = await loadStore();
			const undo =
			{
				label: "Undo",
				run: () =>
				{
				},
			};
			store.getState().showAppMessage(
				"first",
				{
					timeout: 1000,
				},
			);
			vi.advanceTimersByTime(500);
			store.getState().showAppMessage(
				"Sorted A-Z",
				{
					timeout: 5000,
					actions: [undo],
				},
			);
			vi.advanceTimersByTime(4999);
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "Sorted A-Z",
					type: "success",
					actions: [undo],
				},
			);
			vi.advanceTimersByTime(1);
			expect(store.getState().appMessage).toBeNull();
		});

		it("hides after 300000ms by default", async () =>
		{
			const store = await loadStore();
			store.getState().showAppMessage("default");
			vi.advanceTimersByTime(299_999);
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "default",
					type: "success",
					actions: [],
				},
			);
			vi.advanceTimersByTime(1);
			expect(store.getState().appMessage).toBeNull();
		});

		it("never auto-hides with timeout 0, but hides when asked", async () =>
		{
			const store = await loadStore();
			store.getState().showAppMessage(
				"sticky",
				{
					timeout: 0,
				},
			);
			vi.advanceTimersByTime(600_000);
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "sticky",
					type: "success",
					actions: [],
				},
			);
			store.getState().hideAppMessage();
			expect(store.getState().appMessage).toBeNull();
		});

		it("records the message type, defaulting to success", async () =>
		{
			const store = await loadStore();
			store.getState().showAppMessage(
				"x",
				{
					type: "warning",
					timeout: 1000,
				},
			);
			expect(store.getState().appMessage?.type).toBe("warning");
			store.getState().showAppMessage(
				"y",
				{
					timeout: 1000,
				},
			);
			expect(store.getState().appMessage?.type).toBe("success");
		});
	});

	describe("hide on navigation", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("hides the message when the location changes", async () =>
		{
			const store = await loadStore();
			store.getState().dispatchNav(
				{
					type: "navigate",
					loc:
					{
						id: "a",
						query: null,
					},
				},
			);
			store.getState().showAppMessage("Moved to 'b'");
			store.getState().dispatchNav(
				{
					type: "navigate",
					loc:
					{
						id: "b",
						query: null,
					},
				},
			);
			expect(store.getState().appMessage).toBeNull();
		});

		it("keeps the message when the location is unchanged", async () =>
		{
			const store = await loadStore();
			store.getState().dispatchNav(
				{
					type: "navigate",
					loc:
					{
						id: "a",
						query: null,
					},
				},
			);
			store.getState().showAppMessage("Link copied.");
			store.getState().dispatchNav(
				{
					type: "popstate",
					loc:
					{
						id: "a",
						query: null,
					},
				},
			);
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "Link copied.",
					type: "success",
					actions: [],
				},
			);
		});
	});

	describe("dismissOn", () =>
	{
		let target: EventTarget;

		async function loadStoreWithWindow()
		{
			const store = await loadStore();
			target = new EventTarget();
			vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
			vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
			return store;
		}

		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("hides the message on one of its dismissOn window events", async () =>
		{
			const store = await loadStoreWithWindow();
			store.getState().showAppMessage(
				"Mirror(s) copied.",
				{
					dismissOn: ["copy", "paste"],
				},
			);
			target.dispatchEvent(new Event("paste"));
			expect(store.getState().appMessage).toBeNull();
		});

		it("ignores events outside dismissOn", async () =>
		{
			const store = await loadStoreWithWindow();
			store.getState().showAppMessage(
				"Mirror(s) copied.",
				{
					dismissOn: ["copy"],
				},
			);
			target.dispatchEvent(new Event("paste"));
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "Mirror(s) copied.",
					type: "success",
					actions: [],
				},
			);
		});

		it("drops the previous message's dismissOn listeners when replaced", async () =>
		{
			const store = await loadStoreWithWindow();
			store.getState().showAppMessage(
				"Mirror(s) copied.",
				{
					dismissOn: ["copy"],
				},
			);
			store.getState().showAppMessage("Link copied.");
			target.dispatchEvent(new Event("copy"));
			expect(store.getState().appMessage).toStrictEqual(
				{
					text: "Link copied.",
					type: "success",
					actions: [],
				},
			);
		});
	});

	describe("appMessageZIndex", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("is 500 normally and 1100 (modal 600 + message 500) while a dialog is open", async () =>
		{
			const store = await loadStore();
			const {appMessageZIndex} = await import("../src/client/components/app-message.js");
			const closed = appMessageZIndex();
			store.setState(
				{
					exportDialogOpen: true,
				},
			);
			expect(
				{
					closed,
					open: appMessageZIndex(),
				},
			).toStrictEqual(
				{
					closed: 500,
					open: 1100,
				},
			);
		});
	});
});

describe("app version", () =>
{
	const MAC =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
	const WINDOWS =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
	const IPHONE =
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
	const ANDROID =
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
	const EDGE = `${MAC} Edg/155.0.0.0`;

	describe("version label", () =>
	{
		it("tags the browser and platform like upstream's version line", () =>
		{
			expect(
				{
					mac: versionLabel("4.3.1", versionTags(MAC)),
					windows: versionTags(WINDOWS),
					iphone: versionTags(IPHONE),
					android: versionTags(ANDROID),
					edge: versionTags(EDGE),
					linux: versionTags("Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0"),
					bare: versionLabel("4.3.1", []),
				},
			).toStrictEqual(
				{
					mac: "4.3.1 [chrome-155, mac]",
					windows: ["chrome-155", "win"],
					iphone: ["ios-17.5"],
					android: ["chrome-130", "android-14"],
					edge: ["mac"],
					linux: ["linx"],
					bare: "4.3.1",
				},
			);
		});
	});
});
