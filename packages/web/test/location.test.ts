import {QueryClient} from "@tanstack/react-query";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {EMPTY_PREFERENCES} from "../src/client/hooks/use-preferences.js";
import {
	ancestorCrumbs,
	buildPickerRows,
	firstEnabledIndex,
	reducePicker,
	resolveDefaultLocation,
	starRowIds,
	starredPickerIds,
} from "../src/client/location-picker-model.js";
import {ensureNotesLocation, notesRootIdFor} from "../src/client/notes-location.js";
import type {PickerRow, PickerState} from "../src/client/location-picker-model.js";
import {filterLocations, highlightLabel} from "../src/server/location-search.js";
import type {TreeSearchRow} from "../src/server/tree-search.js";
import {locationUrl, parseLocationHash, shortId} from "../src/client/location.js";

describe("location picker model", () => {
	const NAMES: Record<string, string> = {hub: "Qzpick Hub", cal: "📆 Calendar", mover: "Mover"};

	function labelOf(id: string): string {
		return NAMES[id] ?? id;
	}

	function results(count: number): {id: string; labelHtml: string}[] {
		return Array.from({length: count}, (_, i) => ({id: `r${i + 1}`, labelHtml: `<b><u>Qzpick</u></b> ${i + 1}`}));
	}

	function resultRow(i: number): PickerRow {
		return {kind: "result", id: `r${i}`, labelHtml: `<b><u>Qzpick</u></b> ${i}`, disabled: false, icon: null};
	}

	function createRows(query: string, disabled: boolean): PickerRow[] {
		return [
			{
				kind: "create-default",
				labelHtml: `New "${query}" in: <b>Qzpick Hub</b>`,
				disabled,
				icon: "plus",
			},
			{kind: "create-elsewhere", labelHtml: `New "${query}" in…`, disabled, icon: "arrow-up"},
		];
	}

	const BASE = {
		results: [],
		recentIds: [],
		starredIds: [],
		forItemId: "mover",
		expanded: false,
		recentLabel: "Qzpick Hub",
		labelOf,
	};

	describe("buildPickerRows", () => {
		it("cuts a query's results to 5, adds More results and two enabled create rows", () => {
			expect(buildPickerRows({...BASE, query: "qzpick", results: results(9)})).toStrictEqual([
				resultRow(1),
				resultRow(2),
				resultRow(3),
				resultRow(4),
				resultRow(5),
				{kind: "more", labelHtml: "More results", disabled: false, icon: "ellipsis"},
				...createRows("qzpick", false),
			]);
		});

		it("shows every result without More results once expanded", () => {
			expect(buildPickerRows({...BASE, query: "qzpick", results: results(9), expanded: true})).toStrictEqual([
				...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(resultRow),
				...createRows("qzpick", false),
			]);
		});

		it("drops forItem from results but keeps exactly 5 without More results", () => {
			const five = [{id: "mover", labelHtml: "Mover"}, ...results(5)];
			expect(buildPickerRows({...BASE, query: "qzpick", results: five})).toStrictEqual([
				...[1, 2, 3, 4, 5].map(resultRow),
				...createRows("qzpick", false),
			]);
		});

		it("lists recent then unlisted starred rows and disabled create rows for an empty query", () => {
			expect(
				buildPickerRows({
					...BASE,
					query: "",
					recentIds: ["hub", "mover", "hub"],
					starredIds: ["cal", "hub", "mover"],
				}),
			).toStrictEqual([
				{kind: "recent", id: "hub", labelHtml: "Qzpick Hub", disabled: false, icon: "clock"},
				{kind: "recent", id: "mover", labelHtml: "Mover", disabled: false, icon: "clock"},
				{kind: "starred", id: "cal", labelHtml: "📆 Calendar", disabled: false, icon: "star"},
				...createRows("", true),
			]);
		});

		it("shows the help row and enabled create rows when nothing matches", () => {
			const rows = buildPickerRows({...BASE, query: "zq", results: []});
			expect(rows).toStrictEqual([
				{kind: "help", labelHtml: "No matching locations found", disabled: true, icon: null},
				...createRows("zq", false),
			]);
			expect(firstEnabledIndex(rows)).toBe(1);
		});

		it("HTML-escapes the query in the create labels", () => {
			const rows = buildPickerRows({...BASE, query: `<a&"b>`, results: []});
			expect(rows.slice(1).map((row) => row.labelHtml)).toStrictEqual([
				`New "&lt;a&amp;&quot;b&gt;" in: <b>Qzpick Hub</b>`,
				`New "&lt;a&amp;&quot;b&gt;" in…`,
			]);
		});

		it("names the sub-action in both create rows", () => {
			const rows = buildPickerRows({...BASE, query: "x", results: results(1), subActionName: "Mirror to"});
			expect(rows.slice(-2).map((row) => row.labelHtml)).toStrictEqual([
				`Mirror to "x" in: <b>${BASE.recentLabel}</b>`,
				'Mirror to "x" in…',
			]);
		});

		it("omits the create rows when the searcher has no action", () => {
			expect(buildPickerRows({...BASE, query: "qzpick", results: results(1), action: false})).toStrictEqual([
				resultRow(1),
			]);
		});
	});

	describe("firstEnabledIndex", () => {
		it("is -1 when every row is disabled", () => {
			expect(firstEnabledIndex(buildPickerRows({...BASE, query: ""}))).toBe(-1);
		});
	});

	const STEP1: PickerState = {step: 1, query: "qzpick", expanded: false, active: 0, name: ""};

	describe("reducePicker", () => {
		const rows = buildPickerRows({...BASE, query: "qzpick", results: results(9)});

		it("selects the active row on Tab, Shift+Tab and Enter", () => {
			const state = {...STEP1, active: 1};
			const expected = {state, effect: {type: "action", id: "r2"}};
			expect(reducePicker(state, {type: "key", key: "Tab"}, rows)).toStrictEqual(expected);
			expect(reducePicker(state, {type: "key", key: "Tab", shiftKey: true}, rows)).toStrictEqual(expected);
			expect(reducePicker(state, {type: "key", key: "Enter"}, rows)).toStrictEqual(expected);
		});

		it("does nothing on Enter when no row is active", () => {
			const state = {...STEP1, query: "", active: -1};
			expect(
				reducePicker(state, {type: "key", key: "Enter"}, buildPickerRows({...BASE, query: ""})),
			).toStrictEqual({
				state,
				effect: {type: "none"},
			});
		});

		it("indexes enabled rows only, skipping the disabled help row", () => {
			const helpRows = buildPickerRows({...BASE, query: "zq", results: []});
			expect(reducePicker({...STEP1, query: "zq"}, {type: "select", index: 0}, helpRows)).toStrictEqual({
				state: {...STEP1, query: "zq"},
				effect: {type: "sub-action", name: "zq"},
			});
		});

		it("expands on More results and keeps the active index", () => {
			expect(reducePicker(STEP1, {type: "select", index: 5}, rows)).toStrictEqual({
				state: {...STEP1, expanded: true, active: 5},
				effect: {type: "none"},
			});
		});

		it("enters step 2 with the query as the name on create-elsewhere", () => {
			expect(reducePicker(STEP1, {type: "select", index: 7}, rows)).toStrictEqual({
				state: {step: 2, name: "qzpick", query: "", expanded: false, active: 0},
				effect: {type: "none"},
			});
		});

		it("creates under the chosen location in step 2", () => {
			const state: PickerState = {step: 2, name: "qzpick", query: "hub", expanded: false, active: 0};
			const step2Rows = buildPickerRows({
				...BASE,
				query: "hub",
				results: [{id: "hub", labelHtml: "Hub"}],
				action: false,
			});
			expect(reducePicker(state, {type: "key", key: "Enter"}, step2Rows)).toStrictEqual({
				state,
				effect: {type: "sub-action", id: "hub", name: "qzpick"},
			});
		});

		it("resets the active row and collapses on every filter change", () => {
			expect(
				reducePicker({...STEP1, expanded: true, active: 4}, {type: "query", query: "qz"}, rows),
			).toStrictEqual({
				state: {...STEP1, query: "qz"},
				effect: {type: "none"},
			});
		});

		it("returns from step 2 to step 1 with an empty query on Escape", () => {
			const state: PickerState = {step: 2, name: "qzpick", query: "hub", expanded: true, active: 2};
			expect(reducePicker(state, {type: "key", key: "Escape"}, rows)).toStrictEqual({
				state: {step: 1, query: "", expanded: false, active: 0, name: ""},
				effect: {type: "none"},
			});
		});

		it("closes on Escape in step 1 and when focus leaves", () => {
			expect(reducePicker(STEP1, {type: "key", key: "Escape"}, rows)).toStrictEqual({
				state: STEP1,
				effect: {type: "close"},
			});
			expect(reducePicker(STEP1, {type: "focus-leave"}, rows)).toStrictEqual({
				state: STEP1,
				effect: {type: "close"},
			});
		});
	});

	describe("resolveDefaultLocation", () => {
		const exists = (id: string) => id === "notes" || id === "hub";

		it("prefers the newest recent location", () => {
			expect(resolveDefaultLocation({recentIds: ["hub"], notesRootId: "notes", exists})).toStrictEqual({
				id: "hub",
			});
		});

		it("uses the account's notesRootId when that node exists", () => {
			expect(resolveDefaultLocation({recentIds: [], notesRootId: "notes", exists})).toStrictEqual({id: "notes"});
		});

		it("creates Notes when notesRootId is unset or points at a missing node", () => {
			expect(resolveDefaultLocation({recentIds: [], notesRootId: null, exists})).toStrictEqual({create: "Notes"});
			expect(resolveDefaultLocation({recentIds: [], notesRootId: "gone", exists})).toStrictEqual({
				create: "Notes",
			});
		});
	});

	describe("resolveDefaultLocation with recents", () => {
		it("skips recents that no longer exist and falls back to Notes when none resolve", () => {
			expect(
				resolveDefaultLocation({recentIds: ["gone", "hub"], notesRootId: null, exists: (id) => id === "hub"}),
			).toStrictEqual({id: "hub"});
			expect(resolveDefaultLocation({recentIds: ["gone"], notesRootId: null, exists: () => false})).toStrictEqual(
				{
					create: "Notes",
				},
			);
		});
	});

	describe("step 2 rows", () => {
		it("lists recents with no footer rows for an empty query", () => {
			expect(buildPickerRows({...BASE, step: 2, query: "", recentIds: ["hub"], starredIds: []})).toStrictEqual([
				{kind: "recent", id: "hub", labelHtml: "Qzpick Hub", disabled: false, icon: "clock"},
			]);
		});

		it("shows every result with no More or create rows", () => {
			expect(buildPickerRows({...BASE, step: 2, query: "qz", results: results(9)})).toStrictEqual(
				Array.from({length: 9}, (_, i) => resultRow(i + 1)),
			);
		});

		it("creates under the first result on Enter", () => {
			const state: PickerState = {step: 2, name: "qzpick", query: "qz", expanded: false, active: 0};
			const step2Rows = buildPickerRows({...BASE, step: 2, query: "qz", results: results(9)});
			expect(reducePicker(state, {type: "key", key: "Enter"}, step2Rows)).toStrictEqual({
				state,
				effect: {type: "sub-action", id: "r1", name: "qzpick"},
			});
		});
	});

	describe("recent rows", () => {
		it("drops recents that do not exist and keeps forItem as a recent", () => {
			expect(
				buildPickerRows({
					...BASE,
					query: "",
					recentIds: ["gone", "hub"],
					exists: (id) => id !== "gone",
					forItemId: "hub",
					starredIds: ["hub"],
				}),
			).toStrictEqual([
				{kind: "recent", id: "hub", labelHtml: "Qzpick Hub", disabled: false, icon: "clock"},
				...createRows("", true),
			]);
		});
	});

	describe("pending search", () => {
		it("shows no help row and no results while the reply is pending, keeping the footers", () => {
			expect(buildPickerRows({...BASE, query: "qz", pending: true})).toStrictEqual(createRows("qz", false));
		});
	});

	describe("starRowIds", () => {
		it("maps every star, searches included, to its deduplicated page in order", () => {
			expect(
				starRowIds([
					{nodeId: "p1", query: "date:past"},
					{nodeId: "p2", query: null},
					{nodeId: "p1", query: null},
					{nodeId: null, query: null},
				]),
			).toStrictEqual(["p1", "p2"]);
		});
	});

	describe("ancestorCrumbs", () => {
		it("drops the location itself and strips markup from each ancestor name", () => {
			const chain = [
				{id: "sandbox", name: "🧪 <b>Sync</b> sandbox"},
				{id: "hub", name: null},
				{id: "deep", name: "Deep"},
			];
			expect(ancestorCrumbs(chain)).toStrictEqual([
				{id: "sandbox", name: "🧪 Sync sandbox"},
				{id: "hub", name: ""},
			]);
		});

		it("is empty for a top-level location or an unloaded chain", () => {
			expect(ancestorCrumbs([{id: "hub", name: "Hub"}])).toStrictEqual([]);
			expect(ancestorCrumbs([])).toStrictEqual([]);
		});
	});

	describe("ensureNotesLocation", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function stubFetch(patchResponse: () => Response) {
			const requests: {url: string; method: string; body: unknown}[] = [];
			vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				requests.push({url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined});
				if (method === "POST") {
					return Promise.resolve(Response.json({node: {id: "n1", name: "Notes"}}));
				}
				return Promise.resolve(patchResponse());
			});
			return requests;
		}

		it("creates Notes at the bottom of Home, then records it as notesRootId", async () => {
			const requests = stubFetch(() => Response.json({...EMPTY_PREFERENCES, notesRootId: "n1"}));
			const queryClient = new QueryClient();
			await expect(ensureNotesLocation(queryClient)).resolves.toBe("n1");
			expect(requests).toStrictEqual([
				{url: "/api/v1/nodes", method: "POST", body: {parent_id: null, name: "Notes"}},
				{url: "/api/v1/preferences", method: "PATCH", body: {notesRootId: "n1"}},
			]);
		});

		it("keeps the created node for the session when preferences answer 503", async () => {
			stubFetch(() => Response.json({error: "Workflowy internal API is not configured"}, {status: 503}));
			await expect(ensureNotesLocation(new QueryClient())).resolves.toBe("n1");
			expect(notesRootIdFor(EMPTY_PREFERENCES)).toBe("n1");
			expect(notesRootIdFor({...EMPTY_PREFERENCES, notesRootId: "acct"})).toBe("acct");
		});
	});

	describe("starredPickerIds", () => {
		it("lists search stars' pages in mostRecent order, deduplicated", () => {
			const stars = [
				{key: "A", nodeId: "A", query: null, name: null, position: 0},
				{key: "B_q", nodeId: "B", query: "q", name: null, position: 1},
				{key: "A_z", nodeId: "A", query: "z", name: null, position: 2},
			];
			expect(starredPickerIds(stars, {"None/B/q": 9, "None/A/": 5})).toStrictEqual(["B", "A"]);
		});
	});
});

describe("location search", () => {
	const NOW_SEC = Date.UTC(2026, 9, 1) / 1000;
	const JOINED_SEC = Date.UTC(2017, 6, 14) / 1000;
	const MODIFIED_MS = Date.UTC(2026, 8, 30);

	function row(
		id: string,
		parentId: string | null,
		priority: number,
		name: string,
		overrides: Partial<TreeSearchRow> = {},
	): TreeSearchRow {
		return {
			id,
			parentId,
			priority,
			name,
			note: null,
			createdAt: null,
			modifiedAt: MODIFIED_MS,
			completedAt: null,
			layoutMode: null,
			isMirror: false,
			isBacklink: false,
			fileType: null,
			...overrides,
		};
	}

	// Hub > [One > [Deep], Two, Done (completed) > [Under]], every name holding the word "qzpick".
	const ROWS: TreeSearchRow[] = [
		row("hub", null, 0, "Hub qzpick"),
		row("one", "hub", 0, "One qzpick"),
		row("deep", "one", 0, "Deep qzpick"),
		row("two", "hub", 1, "Qzpick Two"),
		row("done", "hub", 2, "Done qzpick", {completedAt: MODIFIED_MS}),
		row("under", "done", 0, "Under qzpick"),
	];

	function filter(query: string, options: {excludeId?: string; limit?: number; offset?: number} = {}) {
		return filterLocations(ROWS, {query, ...options, joinedSec: JOINED_SEC, nowSec: NOW_SEC});
	}

	describe("filterLocations", () => {
		it("drops completed nodes, nodes under a completed ancestor and the excluded node", () => {
			const {results, hasMore} = filter("qzpick", {excludeId: "two"});
			expect({ids: results.map((result) => result.id), hasMore}).toStrictEqual({
				ids: ["hub", "one", "deep"],
				hasMore: false,
			});
		});

		it("returns highlighted labels and root-first ancestors", () => {
			const {results} = filter("deep");
			expect(results).toStrictEqual([
				{
					id: "deep",
					labelHtml: "<b><u>Deep</u></b> qzpick",
					ancestors: [
						{id: "hub", name: "Hub qzpick"},
						{id: "one", name: "One qzpick"},
					],
				},
			]);
		});

		it("pages with offset and limit", () => {
			const first = filter("qzpick", {limit: 2});
			const rest = filter("qzpick", {limit: 2, offset: 2});
			expect({
				firstCount: first.results.length,
				firstHasMore: first.hasMore,
				restCount: rest.results.length,
				restHasMore: rest.hasMore,
			}).toStrictEqual({firstCount: 2, firstHasMore: true, restCount: 2, restHasMore: false});
		});

		it("returns nothing for an empty query", () => {
			expect(filter("  ")).toStrictEqual({results: [], hasMore: false});
		});
	});

	describe("highlightLabel", () => {
		it("wraps each word-start hit in <b><u>", () => {
			expect(highlightLabel("qz", "Qzpick Two")).toBe("<b><u>Qz</u></b>pick Two");
		});

		it("wraps every matched word", () => {
			expect(highlightLabel("qzpick two", "Qzpick Two")).toBe("<b><u>Qzpick</u></b> <b><u>Two</u></b>");
		});
	});

	describe("filterLocations star boost and mirrors", () => {
		it("multiplies starred pages by 20 and leaves mirrors out (ISR10, ISR2)", () => {
			const rows = [
				row("parent", null, 0, "abc parent"),
				row("a", "parent", 0, "A"),
				row("b", "a", 0, "B"),
				row("c", "b", 0, "C"),
				row("star", "c", 0, "abc star"),
				row("mirror", "parent", 1, "abc parent", {isMirror: true}),
			];
			const ids = (starredIds?: string[]) =>
				filterLocations(rows, {query: "abc", starredIds, joinedSec: JOINED_SEC, nowSec: NOW_SEC}).results.map(
					(result) => result.id,
				);
			expect({boosted: ids(["star"]), plain: ids()}).toStrictEqual({
				boosted: ["star", "parent"],
				plain: ["parent", "star"],
			});
		});
	});
});

describe("location", () => {
	const UUID = "4823cefa-5fc0-478c-88ac-35035d443bf1";

	describe("shortId", () => {
		it("keeps the last 12 characters of a uuid", () => {
			expect(shortId(UUID)).toBe("35035d443bf1");
		});

		it("returns an already-short id unchanged", () => {
			expect(shortId("35035d443bf1")).toBe("35035d443bf1");
		});
	});

	describe("locationUrl", () => {
		it("maps home to /", () => {
			expect(locationUrl({id: null})).toBe("/");
		});

		it("maps an item to its short-id hash", () => {
			expect(locationUrl({id: UUID})).toBe("/#/35035d443bf1");
		});

		it("appends an encoded search query to an item", () => {
			expect(locationUrl({id: UUID, query: "a b&c"})).toBe("/#/35035d443bf1?q=a%20b%26c");
		});

		it("appends a search query at home", () => {
			expect(locationUrl({id: null, query: "x"})).toBe("/#?q=x");
		});

		it("appends extra fragments after the query joined by &", () => {
			expect(locationUrl({id: UUID, query: "x", fragments: {view: "board"}})).toBe(
				"/#/35035d443bf1?q=x&view=board",
			);
		});
	});

	describe("parseLocationHash", () => {
		it("parses an item with a query", () => {
			expect(parseLocationHash("#/35035d443bf1?q=A2")).toStrictEqual({
				id: "35035d443bf1",
				query: "A2",
				fragments: {},
			});
		});

		it("treats an empty hash as home", () => {
			expect(parseLocationHash("")).toStrictEqual({id: null, query: null, fragments: {}});
		});

		it("treats #/ as home", () => {
			expect(parseLocationHash("#/")).toStrictEqual({id: null, query: null, fragments: {}});
		});

		it("drops an empty query and keeps other params as fragments", () => {
			expect(parseLocationHash("#/abc?q=&x=1")).toStrictEqual({id: "abc", query: null, fragments: {x: "1"}});
		});

		it("decodes an encoded query at home", () => {
			expect(parseLocationHash("#?q=a%20b%26c")).toStrictEqual({id: null, query: "a b&c", fragments: {}});
		});
	});

	describe("upstream URL edge cases", () => {
		it("reads + in a query as a space, as URLSearchParams does", () => {
			expect(parseLocationHash("#/abc?q=a+b")).toStrictEqual({id: "abc", query: "a b", fragments: {}});
		});

		it("keeps only the text between the first and second ?", () => {
			expect(parseLocationHash("#/abc?q=x?y=1")).toStrictEqual({id: "abc", query: "x", fragments: {}});
		});

		it("writes a fragment with an empty value as the bare key", () => {
			expect(locationUrl({id: null, fragments: {flag: ""}})).toBe("/#?flag");
		});
	});
});
