import {describe, expect, it, afterEach, beforeEach, vi} from "vite-plus/test";
import {operatorAutocomplete, tagAutocompleteRows} from "../src/client/search/autocomplete-values.js";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {SearchAutocomplete, autocompleteClassName} from "../src/client/components/search-autocomplete.js";
import {createSearchBoxController} from "../src/client/search-box-model.js";
import {readFileSync, mkdtempSync, rmSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {TreeSearchResult, TreeSearchRow} from "../src/server/tree-search.js";
import
{
	outlineViewClassName,
	rootSearchClasses,
	searchClasses,
	shouldRenderAddChildButton,
} from "../src/client/search-classes.js";
import {searchFilter} from "../src/client/search-filter.js";
import {cssBlock} from "./helpers/css-block.js";
import {EMPTY_PREFERENCES} from "../src/client/hooks/use-preferences.js";
import type {PreferencesState} from "../src/client/hooks/use-preferences.js";
import {searchForChangesAfterPatch} from "../src/client/search-for-changes-after.js";
import {insertHelperValue, replaceSearchWord} from "../src/client/search/helper-insert.js";
import {NO_HELPER_SELECTION, chipNeighbor, helperKey} from "../src/client/search/helper-keys.js";
import type {ChipGeometry, HelperLayout, HelperSelection} from "../src/client/search/helper-keys.js";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {nodeTreeHost} from "../src/server/node-host.js";
import
{
	bindTreeHost,
	loadTreeRows,
	loadTreeRowsWithBacklinks,
	loadTreeRowText,
	loadTreeSearchRows,
	loadTreeSkeletonRows,
	loadSwitcherSkeleton,
	buildSwitcherSkeleton,
	peekSwitcherSkeleton,
	switcherTextScan,
	queryNeedsBacklinks,
	peekTreeSnapshotBuild,
	peekTreeSnapshotRows,
	scheduleTreeSnapshotRebuild,
	warmTreeSnapshot,
} from "../src/server/tree-snapshot.js";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import {nodeContent, nodeMetadata, aiMetadata, mirrors, referencesRoots} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import {SO_ROWS} from "../../shared/test/helpers/search-so-fixture.js";
import {collectHelperTags} from "../src/server/helper-tags.js";
import {loadHelperTags} from "../src/server/ops/search.js";
import {SearchHelpers} from "../src/client/components/search-helpers.js";
import type {SearchHelpersProps} from "../src/client/components/search-helpers.js";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import
{
	SEARCH_PREFETCH_CONCURRENCY,
	SEARCH_PREFETCH_LIMIT,
	prefetchSearchAncestors,
} from "../src/client/search-prefetch.js";
import {Ops} from "../src/server/ops/index.js";
import {tmpdir} from "node:os";
import {z} from "zod";
import {buildServerContext} from "../src/server/context.js";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {defineOp, ok} from "../src/server/ops/define.js";
import {inProcessStore} from "../src/server/store.js";
import {and, eq} from "drizzle-orm";
import {computeTreeSearch, computeTreeSearchPaged} from "../src/server/tree-search.js";
import {compactSwitcherSkeleton, peekSwitcherText} from "../src/server/switcher-search.js";

describe("search autocomplete values", () =>
{
	const OPTIONS =
	{
		now: new Date(2026, 9, 23, 11, 1),
		dateFormat: "YYYY-MM-DD",
		timeFormat: "HH:mm",
	};

	function pairs(word: string): string[][]
	{
		return operatorAutocomplete(word, OPTIONS).map((row) => [row.label, row.value]);
	}

	describe("operatorAutocomplete", () =>
	{
		it("lists the locally supported is: options in upstream order", () =>
		{
			expect(pairs("is:")).toStrictEqual([
				["complete", "is:complete"],
				["mirror", "is:mirror"],
				["todo", "is:todo"],
				["divider", "is:divider"],
				["h1", "is:h1"],
				["h2", "is:h2"],
				["h3", "is:h3"],
				["paragraph", "is:paragraph"],
				["code-block", "is:code-block"],
				["quote", "is:quote"],
			]);
		});

		it("matches by value or label prefix, case-insensitively", () =>
		{
			expect(pairs("is:c")).toStrictEqual([
				["complete", "is:complete"],
				["code-block", "is:code-block"],
			]);
		});

		it("keeps a fully typed lowercase value (the capitalized value never equals it)", () =>
		{
			expect(pairs("is:complete")).toStrictEqual([["complete", "is:complete"]]);
		});

		it("returns nothing for a capitalized value, a capitalized operator, no colon, a second colon or unknown operators", () =>
		{
			expect(
				{
					capitalizedValue: pairs("is:Complete"),
					capitalizedOperator: pairs("IS:"),
					noColon: pairs("is"),
					secondColon: pairs("is:a:b"),
					link: pairs("link:"),
					changedBy: pairs("changed-by:"),
					negated: pairs("-is:"),
					quoted: pairs('"is:'),
				},
			).toStrictEqual(
				{
					capitalizedValue: [],
					capitalizedOperator: [],
					noColon: [],
					secondColon: [],
					link: [],
					changedBy: [],
					negated: [],
					quoted: [],
				},
			);
		});

		it("sorts has: options by displayOrder", () =>
		{
			expect(pairs("has:")).toStrictEqual([
				["note", "has:note"],
				["children", "has:children"],
				["date", "has:date"],
				["file", "has:file"],
				["image", "has:image"],
				["video", "has:video"],
				["tweet", "has:tweet"],
			]);
		});

		it("lists text: colours first, then colored and highlighted, then styles", () =>
		{
			expect(pairs("text:b")).toStrictEqual([
				["blue", "text:blue"],
				["bold", "text:bold"],
			]);
			expect(pairs("text:").map(([label]) => label)).toStrictEqual([
				"red",
				"orange",
				"yellow",
				"green",
				"teal",
				"sky",
				"blue",
				"purple",
				"pink",
				"gray",
				"colored",
				"highlighted",
				"bold",
				"italic",
				"underline",
				"strikethrough",
				"code",
			]);
		});

		it("gives text: colours a text swatch and highlight: colours a background swatch", () =>
		{
			expect(
				{
					text: operatorAutocomplete("text:red", OPTIONS)[0]?.icon,
					highlight: operatorAutocomplete("highlight:red", OPTIONS)[0]?.icon,
					colored: operatorAutocomplete("text:col", OPTIONS)[0]?.icon,
				},
			).toStrictEqual(
				{
					text:
					{
						swatch: "text",
						color: "red",
					},
					highlight:
					{
						swatch: "background",
						color: "red",
					},
					colored: "fal:paint-brush",
				},
			);
		});

		it("lowercases day-of-week values and capitalizes their labels", () =>
		{
			expect(pairs("day-of-week:f")).toStrictEqual([["Friday", "day-of-week:friday"]]);
		});

		it("lists changed: and created: relative windows", () =>
		{
			expect(
				{
					changed: pairs("changed:"),
					created: pairs("created:7"),
				},
			).toStrictEqual(
				{
					changed: [
						["1 hour", "changed:1h"],
						["1 day", "changed:1d"],
						["1 week", "changed:7d"],
					],
					created: [["1 week", "created:7d"]],
				},
			);
		});

		it("lists date: past, future and today in the account formats", () =>
		{
			expect(pairs("date:")).toStrictEqual([
				["past", "date:past"],
				["future", "date:future"],
				["10-23", "date:10-23"],
				["10-23@11:01", "date:10-23@11:01"],
				["2026-10-23", "date:2026-10-23"],
			]);
		});

		it("makes in:note insert a quoted value with the caret between the quotes", () =>
		{
			expect(operatorAutocomplete("in:", OPTIONS)).toStrictEqual([
				{
					type: "row",
					label: "note",
					value: "in:note",
					insert:
					{
						suffix: ':""',
						trailingSpace: false,
						caretOffset: -1,
					},
				},
			]);
		});
	});

	describe("tagAutocompleteRows", () =>
	{
		it("prepends a Tags header for @ words with tags only", () =>
		{
			expect(
				{
					at: tagAutocompleteRows("@s", ["@sa", "@sb"]),
					atNone: tagAutocompleteRows("@s", []),
					hash: tagAutocompleteRows("#s", ["#sa"]),
					other: tagAutocompleteRows("is:", ["#sa"]),
				},
			).toStrictEqual(
				{
					at: [
						{
							type: "header",
							label: "Tags",
						},
						{
							type: "row",
							label: "@sa",
							value: "@sa",
						},
						{
							type: "row",
							label: "@sb",
							value: "@sb",
						},
					],
					atNone: [],
					hash: [
						{
							type: "row",
							label: "#sa",
							value: "#sa",
						},
					],
					other: [],
				},
			);
		});
	});
});

describe("search autocomplete", () =>
{
	const BASE =
		"menu [&.menu.flyout]:m-0 [&.menu.flyout]:-mt-px [&.menu.flyout]:box-border [&.menu.flyout]:border-solid [&.menu.flyout]:border-t-0 [&.menu.flyout]:rounded-[16px] [&.menu.flyout]:rounded-tl-none [&.menu.flyout]:rounded-tr-none [&.menu.flyout]:shadow-none ";

	describe("SearchAutocomplete", () =>
	{
		it("uses upstream's flyout class with the tint border for a committed query", () =>
		{
			expect(autocompleteClassName(true)).toBe(`${BASE}[&.menu.flyout]:border-[var(--wf-border-tint)]`);
			expect(autocompleteClassName(false)).toBe(`${BASE}[&.menu.flyout]:border-primary-x`);
		});

		it("renders the Tags header with upstream's exact markup", () =>
		{
			const html = renderToStaticMarkup(
				createElement(
					SearchAutocomplete,
					{
						rows: [
							{
								type: "header",
								label: "Tags",
							},
							{
								type: "row",
								label: "@sa",
								value: "@sa",
							},
						],
						committed: true,
						onSelect: () =>
						{
						},
					},
				),
			);

			expect(html).toContain(
				'<div class="py-m px-l text-tertiary text-xs uppercase bg-inherit mobile:bg-secondary menu-section-header mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right "><span>Tags</span></div>',
			);
			expect(html).toContain(`class="wf-header flex flex-col`);
			expect(html).toContain(autocompleteClassName(true).replaceAll("&", "&amp;"));
		});
	});
});

describe("search box model", () =>
{
	function setup(committed = "")
	{
		const state =
		{
			committed,
		};
		const commit = vi.fn<(query: string) => void>();
		const controller = createSearchBoxController(
			{
				commit,
				getCommitted: () => state.committed,
			},
		);
		return {
			state,
			commit,
			controller,
		};
	}

	describe("createSearchBoxController", () =>
	{
		beforeEach(() =>
		{
			vi.useFakeTimers();
		});
		afterEach(() =>
		{
			vi.useRealTimers();
		});

		it("debounces a change by 1000ms", () =>
		{
			const {commit, controller} = setup();
			controller.change("apple");
			vi.advanceTimersByTime(999);
			expect(commit.mock.calls).toStrictEqual([]);
			vi.advanceTimersByTime(1);
			expect(commit.mock.calls).toStrictEqual([["apple"]]);
		});

		it("restarts the debounce on every change and commits only the last value", () =>
		{
			const {commit, controller} = setup();
			controller.change("ap");
			vi.advanceTimersByTime(500);
			controller.change("apple");
			vi.advanceTimersByTime(999);
			expect(commit.mock.calls).toStrictEqual([]);
			vi.advanceTimersByTime(1);
			expect(commit.mock.calls).toStrictEqual([["apple"]]);
		});

		it("commits clearing to empty immediately", () =>
		{
			const {commit, controller} = setup("apple");
			controller.change("");
			expect(commit.mock.calls).toStrictEqual([[""]]);
		});

		it("does nothing when the value equals the committed query, cancelling a pending commit", () =>
		{
			const {commit, controller} = setup("apple");
			controller.change("apples");
			controller.change("apple");
			vi.advanceTimersByTime(2000);
			expect(commit.mock.calls).toStrictEqual([]);
		});

		it("commits on Enter immediately and cancels the pending debounce", () =>
		{
			const {commit, controller} = setup();
			controller.change("ap");
			expect(controller.key("Enter")).toStrictEqual(
				{
					preventDefault: true,
					action: "none",
				},
			);
			expect(commit.mock.calls).toStrictEqual([["ap"]]);
			vi.advanceTimersByTime(1000);
			expect(commit.mock.calls).toStrictEqual([["ap"]]);
		});

		it("re-runs an unchanged query on Enter", () =>
		{
			const {commit, controller} = setup("apple");
			controller.key("Enter", "apple");
			expect(commit.mock.calls).toStrictEqual([["apple"]]);
		});

		it("ignores Enter on an empty input with no committed search", () =>
		{
			const {commit, controller} = setup();
			expect(controller.key("Enter", "")).toStrictEqual(
				{
					preventDefault: true,
					action: "none",
				},
			);
			expect(commit.mock.calls).toStrictEqual([]);
		});

		it("asks to focus the outline on Tab without committing", () =>
		{
			const {commit, controller} = setup();
			expect(controller.key("Tab")).toStrictEqual(
				{
					preventDefault: true,
					action: "focusOutline",
				},
			);
			expect(commit.mock.calls).toStrictEqual([]);
		});

		it("leaves other keys alone", () =>
		{
			const {commit, controller} = setup();
			expect(controller.key("a")).toStrictEqual(
				{
					preventDefault: false,
					action: "none",
				},
			);
			expect(commit.mock.calls).toStrictEqual([]);
		});

		it("dispose cancels a pending commit", () =>
		{
			const {commit, controller} = setup();
			controller.change("apple");
			controller.dispose();
			vi.advanceTimersByTime(2000);
			expect(commit.mock.calls).toStrictEqual([]);
		});
	});
});

describe("search classes", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8").replaceAll(
		/\/\*[\s\S]*?\*\//gu,
		"",
	);

	// Zoom root > Fruit apple > {Green apple pie, Cherry tart > deep apple leaf, Banana}; Notes has a "zebra" note.
	const appleResult: TreeSearchResult =
	{
		matchIds: ["fruit", "pie", "leaf"],
		nameMatchIds: ["fruit", "pie", "leaf"],
		noteMatchIds: [],
		metaMatchIds: [],
		ancestorIds: ["fruit", "cherry"],
		halfExpandedIds: ["fruit"],
		rootHalfExpanded: true,
		completedMatchCount: 0,
		matchCount: 3,
		revealsCompleted: false,
	};

	const apple = searchFilter(appleResult, new Set(), new Map());

	describe("searchClasses", () =>
	{
		it("marks a leaf name match as a terminal full match", () =>
		{
			expect(
				searchClasses(
					{
						id: "pie",
						parentId: "fruit",
					},
					apple,
				),
			).toStrictEqual(
				{
					project: ["matches", "terminalMatch"],
					name: ["fullMatch", "matches"],
					note: [],
				},
			);
		});

		it("marks an open half-expanded matching ancestor as half-open, not terminal", () =>
		{
			expect(
				searchClasses(
					{
						id: "fruit",
						parentId: "root",
					},
					apple,
				),
			).toStrictEqual(
				{
					project: ["matches", "halfExpanded", "half-open"],
					name: ["fullMatch", "matches"],
					note: [],
				},
			);
		});

		it("leaves a non-matching ancestor unclassed", () =>
		{
			expect(
				searchClasses(
					{
						id: "cherry",
						parentId: "fruit",
					},
					apple,
				),
			).toStrictEqual(
				{
					project: [],
					name: [],
					note: [],
				},
			);
		});

		it("drops halfExpanded and half-open on a collapsed half-expanded row", () =>
		{
			const collapsed = searchFilter(appleResult, new Set(), new Map([["fruit", false]]));
			expect(
				searchClasses(
					{
						id: "fruit",
						parentId: "root",
					},
					collapsed,
				).project,
			).toStrictEqual(["matches"]);
		});

		it("drops halfExpanded once the row is fully expanded and marks shown non-matches as terminal matches", () =>
		{
			const full = searchFilter(appleResult, new Set(), new Map([["fruit", true]]));
			expect(
				{
					fruit: searchClasses(
						{
							id: "fruit",
							parentId: "root",
						},
						full,
					).project,
					banana: searchClasses(
						{
							id: "banana",
							parentId: "fruit",
						},
						full,
					),
					cherry: searchClasses(
						{
							id: "cherry",
							parentId: "fruit",
						},
						full,
					),
				},
			).toStrictEqual(
				{
					fruit: ["matches"],
					banana:
					{
						project: ["matches", "terminalMatch"],
						name: [],
						note: [],
					},
					cherry:
					{
						project: ["matches", "terminalMatch"],
						name: [],
						note: [],
					},
				},
			);
		});

		it("marks a row created during the search as a terminal match without fullMatch", () =>
		{
			const created = searchFilter(appleResult, new Set(["new"]), new Map());
			expect(
				searchClasses(
					{
						id: "new",
						parentId: "fruit",
					},
					created,
				),
			).toStrictEqual(
				{
					project: ["matches", "terminalMatch"],
					name: [],
					note: [],
				},
			);
		});

		it("marks an operator-only match as metaMatches", () =>
		{
			const hasNote = searchFilter(
				{
					...appleResult,
					matchIds: ["noted"],
					nameMatchIds: [],
					metaMatchIds: ["noted"],
					ancestorIds: [],
				},
				new Set(),
				new Map(),
			);
			expect(
				searchClasses(
					{
						id: "noted",
						parentId: "root",
					},
					hasNote,
				),
			).toStrictEqual(
				{
					project: ["matches", "terminalMatch", "metaMatches"],
					name: ["fullMatch"],
					note: [],
				},
			);
		});

		it("marks a note match on the note", () =>
		{
			const zebra = searchFilter(
				{
					...appleResult,
					matchIds: ["fruit"],
					nameMatchIds: [],
					noteMatchIds: ["fruit"],
					ancestorIds: [],
					halfExpandedIds: [],
				},
				new Set(),
				new Map(),
			);
			expect(
				searchClasses(
					{
						id: "fruit",
						parentId: "root",
					},
					zebra,
				),
			).toStrictEqual(
				{
					project: ["matches", "terminalMatch"],
					name: ["fullMatch"],
					note: ["matches", "fullMatch"],
				},
			);
		});

		it("gives no classes outside a search", () =>
		{
			expect(
				searchClasses(
					{
						id: "pie",
						parentId: "fruit",
					},
					null,
				),
			).toStrictEqual(
				{
					project: [],
					name: [],
					note: [],
				},
			);
		});
	});

	describe("rootSearchClasses", () =>
	{
		it("marks the zoom root half-expanded when the search says so", () =>
		{
			expect(
				{
					half: rootSearchClasses(apple),
					whole: rootSearchClasses(
						searchFilter(
							{
								...appleResult,
								rootHalfExpanded: false,
							},
							new Set(),
							new Map(),
						),
					),
					none: rootSearchClasses(null),
				},
			).toStrictEqual(
				{
					half: ["half-open", "halfExpanded"],
					whole: [],
					none: [],
				},
			);
		});
	});

	describe("page and add button during a search", () =>
	{
		it("adds searching to the page and suppresses the add-child button", () =>
		{
			expect(
				{
					searchingPage: outlineViewClassName("apple"),
					idlePage: outlineViewClassName(""),
					addWhileSearching: shouldRenderAddChildButton("apple"),
					addIdle: shouldRenderAddChildButton(""),
				},
			).toStrictEqual(
				{
					searchingPage: "outline-view searching",
					idlePage: "outline-view",
					addWhileSearching: false,
					addIdle: true,
				},
			);
		});

		it("opens matched notes to full height", () =>
		{
			expect(
				{
					note: cssBlock(
						styles,
						".page.searching .notes.matches > .content, .outline-view.searching .notes.matches > .content",
					),
				},
			).toStrictEqual(
				{
					note:
					{
						overflow: "visible",
						display: "block",
						"max-height": "none",
						height: "auto",
					},
				},
			);
		});
	});
});

describe("search for changes after", () =>
{
	const NOW = new Date("2026-10-31T12:00:00.000Z");

	function loaded(searchForChangesAfter: string | null): PreferencesState
	{
		return {
			preferences:
			{
				...EMPTY_PREFERENCES,
				searchForChangesAfter,
			},
			available: true,
			error: null,
		};
	}

	describe("searchForChangesAfterPatch", () =>
	{
		it("sets the start to now when it is missing, in the future, or already past (left alone)", () =>
		{
			expect(
				{
					missing: searchForChangesAfterPatch(loaded(null), NOW),
					future: searchForChangesAfterPatch(loaded("2026-11-01T00:00:00.000Z"), NOW),
					past: searchForChangesAfterPatch(loaded("2020-01-01T00:00:00.000Z"), NOW),
					exactlyNow: searchForChangesAfterPatch(loaded(NOW.toISOString()), NOW),
				},
			).toStrictEqual(
				{
					missing:
					{
						searchForChangesAfter: "2026-10-31T12:00:00.000Z",
					},
					future:
					{
						searchForChangesAfter: "2026-10-31T12:00:00.000Z",
					},
					past: null,
					exactlyNow: null,
				},
			);
		});

		it("writes nothing while preferences load or when the internal API is unavailable", () =>
		{
			expect(
				{
					loading: searchForChangesAfterPatch(undefined, NOW),
					unavailable: searchForChangesAfterPatch(
						{
							preferences: EMPTY_PREFERENCES,
							available: false,
							error: "not configured",
						},
						NOW,
					),
				},
			).toStrictEqual(
				{
					loading: null,
					unavailable: null,
				},
			);
		});
	});
});

describe("search helper insert", () =>
{
	describe("insertHelperValue", () =>
	{
		it("inserts, toggles, and replaces group members like upstream's search helper", () =>
		{
			expect([
				insertHelperValue("", 0, "today"),
				insertHelperValue("today ", 6, "tomorrow"),
				insertHelperValue("tomorrow ", 9, "tomorrow"),
				insertHelperValue("@soPerson ", 10, "changed:"),
				insertHelperValue("next week ", 10, "today"),
				insertHelperValue("apple ", 6, "changed-by:me"),
				insertHelperValue("apple changed-by:me ", 20, "changed-by:others"),
			]).toStrictEqual([
				{
					query: "today ",
					caret: 6,
				},
				{
					query: "tomorrow ",
					caret: 9,
				},
				{
					query: "",
					caret: 0,
				},
				{
					query: "@soPerson changed:",
					caret: 18,
				},
				{
					query: "today ",
					caret: 6,
				},
				{
					query: "apple changed-by:me ",
					caret: 20,
				},
				{
					query: "apple changed-by:others ",
					caret: 24,
				},
			]);
		});

		it("replaces the word under the caret and treats regex characters literally", () =>
		{
			expect([
				insertHelperValue("foo ba", 6, "#tag"),
				insertHelperValue("a+b ", 4, "a+b"),
				insertHelperValue("CHANGED:1H x ", 13, "changed:1h"),
			]).toStrictEqual([
				{
					query: "foo #tag ",
					caret: 9,
				},
				{
					query: "",
					caret: 0,
				},
				{
					query: "x ",
					caret: 2,
				},
			]);
		});
	});

	describe("replaceSearchWord", () =>
	{
		it("replaces the word under the caret with the value and a trailing space, without toggling", () =>
		{
			expect(
				{
					empty: replaceSearchWord("is:", 3, "is:shared"),
					middle: replaceSearchWord("foo is:co bar", 9, "is:complete"),
					afterCaret: replaceSearchWord("is:comp", 4, "is:complete"),
					doubleSpace: replaceSearchWord("a  is:", 6, "is:todo"),
					datePhrase: replaceSearchWord("this week", 9, "is:todo"),
					noToggle: replaceSearchWord("is:complete", 11, "is:complete"),
				},
			).toStrictEqual(
				{
					empty:
					{
						query: "is:shared ",
						caret: 10,
					},
					middle:
					{
						query: "foo is:complete bar",
						caret: 16,
					},
					afterCaret:
					{
						query: "is:complete ",
						caret: 12,
					},
					doubleSpace:
					{
						query: "a  is:todo ",
						caret: 11,
					},
					datePhrase:
					{
						query: "this is:todo ",
						caret: 13,
					},
					noToggle:
					{
						query: "is:complete ",
						caret: 12,
					},
				},
			);
		});

		it("honours trailingSpace and caretOffset for in: values", () =>
		{
			expect(
				replaceSearchWord(
					"is:shared in:",
					13,
					'in:note:""',
					{
						trailingSpace: false,
						caretOffset: -1,
					},
				),
			).toStrictEqual(
				{
					query: 'is:shared in:note:""',
					caret: 19,
				},
			);
		});
	});
});

describe("search helper keys", () =>
{
	// The DATES tab's 13 chip wrappers measured on the local app (identical upstream): [label, left, top, width, height].
	const WRAPPERS: [string, number, number, number, number][] = [
		["date:", 611, 69.64, 43.98, 28],
		["date-before:", 654.98, 69.64, 88.21, 28],
		["date-after:", 743.19, 69.64, 77.73, 28],
		["day-of-week:", 611, 97.64, 92.8, 28],
		["today", 703.8, 97.64, 47.09, 28],
		["tomorrow", 750.88, 97.64, 70.63, 28],
		["yesterday", 821.52, 97.64, 71.67, 28],
		["this week", 611, 125.64, 69.75, 28],
		["next week", 680.75, 125.64, 73.55, 28],
		["last week", 754.3, 125.64, 69.3, 28],
		["this month", 611, 153.64, 76.73, 28],
		["next month", 687.73, 153.64, 80.52, 28],
		["last month", 768.25, 153.64, 76.27, 28],
	];
	const TOPS = [4, 4, 4, 32, 32, 32, 32, 60, 60, 60, 88, 88, 88];
	const CONTAINER_BOTTOM = 181.64;

	const CHIPS: ChipGeometry[] = WRAPPERS.map(([, left, top, width, height], index) =>
	{
		const wrapper =
		{
			left,
			top,
			width,
			height,
		};
		return {
			wrapper,
			item:
			{
				left: left + 1,
				top: top + 4,
				width: width - 2,
				height: height - 8,
			},
			offsetTop: TOPS[index] ?? 0,
		};
	});

	const labelOf = (index: number | null): string => (index === null ? "null" : (WRAPPERS[index]?.[0] ?? "?"));

	const UPSTREAM_UP_DOWN: Record<string, [string, string]> =
	{
		"date:": ["null", "day-of-week:"],
		"date-before:": ["null", "day-of-week:"],
		"date-after:": ["null", "tomorrow"],
		"day-of-week:": ["date:", "this week"],
		today: ["date-before:", "next week"],
		tomorrow: ["date-after:", "last week"],
		yesterday: ["null", "last week"],
		"this week": ["day-of-week:", "this month"],
		"next week": ["day-of-week:", "next month"],
		"last week": ["tomorrow", "last month"],
		"this month": ["this week", "null"],
		"next month": ["next week", "null"],
		"last month": ["last week", "null"],
	};

	describe("chipNeighbor", () =>
	{
		it("matches upstream's geometric Up and Down for every DATES chip", () =>
		{
			const actual = Object.fromEntries(
				WRAPPERS.map(([label], index) => [
					label,
					[
						labelOf(chipNeighbor(CHIPS, CONTAINER_BOTTOM, index, "up")),
						labelOf(chipNeighbor(CHIPS, CONTAINER_BOTTOM, index, "down")),
					],
				]),
			);

			expect(actual).toStrictEqual(UPSTREAM_UP_DOWN);
		});
	});

	const layout: HelperLayout =
	{
		tabCount: 7,
		hasChips: (tab) => tab > 0,
		chipCount: 13,
		neighbor: (chip, dir) =>
		{
			const label = WRAPPERS[chip]?.[0] ?? "";
			const target = UPSTREAM_UP_DOWN[label]?.[dir === "up" ? 0 : 1];
			const index = WRAPPERS.findIndex(([name]) => name === target);
			return index === -1 ? null : index;
		},
	};

	function key(sel: HelperSelection, code: string, ctrl = false)
	{
		return helperKey(
			sel,
			{
				code,
				ctrl,
			},
			layout,
		);
	}

	describe("helperKey", () =>
	{
		it("arms tab-row mode with ArrowUp, then ArrowRight picks the first tab and ArrowUp disarms", () =>
		{
			const armed = key(NO_HELPER_SELECTION, "ArrowUp");
			const right = key(armed.sel, "ArrowRight");
			const up = key(right.sel, "ArrowUp");

			expect(
				{
					armed,
					right: right.sel,
					up: up.sel,
				},
			).toStrictEqual(
				{
					armed:
					{
						sel:
						{
							tab: -1,
							chip: -1,
							rowMode: true,
						},
						preventDefault: true,
						stopPropagation: false,
						select: null,
					},
					right:
					{
						tab: 0,
						chip: -1,
						rowMode: true,
					},
					up: NO_HELPER_SELECTION,
				},
			);
		});

		it("steps tabs with Ctrl+N and Ctrl+P only from nothing or tab-row mode", () =>
		{
			expect(
				{
					fromNothing: key(NO_HELPER_SELECTION, "KeyN", true),
					backOff: key(
						{
							tab: 0,
							chip: -1,
							rowMode: true,
						},
						"KeyP",
						true,
					).sel,
					hovered: key(
						{
							tab: 3,
							chip: -1,
							rowMode: false,
						},
						"KeyN",
						true,
					),
				},
			).toStrictEqual(
				{
					fromNothing:
					{
						sel:
						{
							tab: 0,
							chip: -1,
							rowMode: false,
						},
						preventDefault: true,
						stopPropagation: false,
						select: null,
					},
					backOff:
					{
						tab: -1,
						chip: -1,
						rowMode: true,
					},
					hovered:
					{
						sel:
						{
							tab: 3,
							chip: -1,
							rowMode: false,
						},
						preventDefault: false,
						stopPropagation: false,
						select: null,
					},
				},
			);
		});

		it("enters the chips from a hovered tab with Left (last chip) and Right (first chip)", () =>
		{
			const hovered: HelperSelection =
			{
				tab: 3,
				chip: -1,
				rowMode: false,
			};

			expect(
				{
					left: key(hovered, "ArrowLeft").sel,
					right: key(hovered, "ArrowRight").sel,
				},
			).toStrictEqual(
				{
					left:
					{
						tab: 3,
						chip: 12,
						rowMode: false,
					},
					right:
					{
						tab: 3,
						chip: 0,
						rowMode: false,
					},
				},
			);
		});

		it("arms tab-row mode with ArrowUp on a hovered tab", () =>
		{
			expect(
				key(
					{
						tab: 3,
						chip: -1,
						rowMode: false,
					},
					"ArrowUp",
				).sel,
			).toStrictEqual(
				{
					tab: 3,
					chip: -1,
					rowMode: true,
				},
			);
		});

		it("swallows Space and Tab on a chip tab, and selects the highlighted chip", () =>
		{
			expect(
				{
					space: key(
						{
							tab: 1,
							chip: -1,
							rowMode: false,
						},
						"Space",
					),
					tab: key(
						{
							tab: 1,
							chip: -1,
							rowMode: false,
						},
						"Tab",
					),
					enter: key(
						{
							tab: 1,
							chip: 2,
							rowMode: false,
						},
						"Enter",
					),
				},
			).toStrictEqual(
				{
					space:
					{
						sel:
						{
							tab: 1,
							chip: -1,
							rowMode: false,
						},
						preventDefault: true,
						stopPropagation: false,
						select: null,
					},
					tab:
					{
						sel:
						{
							tab: 1,
							chip: -1,
							rowMode: false,
						},
						preventDefault: true,
						stopPropagation: true,
						select: null,
					},
					enter:
					{
						sel:
						{
							tab: 1,
							chip: 2,
							rowMode: false,
						},
						preventDefault: true,
						stopPropagation: false,
						select: 2,
					},
				},
			);
		});

		it("leaves the tab row for the chips on ArrowDown", () =>
		{
			expect(
				key(
					{
						tab: 3,
						chip: -1,
						rowMode: true,
					},
					"ArrowDown",
				).sel,
			).toStrictEqual(
				{
					tab: 3,
					chip: 0,
					rowMode: false,
				},
			);
		});

		it("lets ArrowLeft on the first tab move the caret", () =>
		{
			expect(
				key(
					{
						tab: 0,
						chip: -1,
						rowMode: true,
					},
					"ArrowLeft",
				),
			).toStrictEqual(
				{
					sel:
					{
						tab: 0,
						chip: -1,
						rowMode: true,
					},
					preventDefault: false,
					stopPropagation: false,
					select: null,
				},
			);
		});

		it("moves between chips by geometry and returns to the tab row from the first chip row", () =>
		{
			const downFromBefore = key(
				{
					tab: 3,
					chip: 1,
					rowMode: false,
				},
				"ArrowDown",
			).sel;
			const upFromYesterday = key(
				{
					tab: 3,
					chip: 6,
					rowMode: false,
				},
				"ArrowUp",
			);

			expect(
				{
					down: downFromBefore.chip,
					up: upFromYesterday.sel,
					stop: upFromYesterday.stopPropagation,
				},
			).toStrictEqual(
				{
					down: 3,
					up:
					{
						tab: 3,
						chip: -1,
						rowMode: true,
					},
					stop: true,
				},
			);
		});

		it("keeps the tab at -1 while the autocomplete hides the helper flyout, but still arms tab-row mode", () =>
		{
			const hidden =
			{
				...layout,
				hidden: true,
			};

			expect(
				helperKey(
					NO_HELPER_SELECTION,
					{
						code: "ArrowDown",
						ctrl: false,
					},
					hidden,
				).sel,
			).toStrictEqual(
				{
					tab: -1,
					chip: -1,
					rowMode: true,
				},
			);
		});

		it("ignores other keys", () =>
		{
			expect(
				key(
					{
						tab: 2,
						chip: -1,
						rowMode: false,
					},
					"KeyA",
				),
			).toStrictEqual(
				{
					sel:
					{
						tab: 2,
						chip: -1,
						rowMode: false,
					},
					preventDefault: false,
					stopPropagation: false,
					select: null,
				},
			);
		});
	});
});

describe("search helpers route", () =>
{
	const SO_TEXT = SO_ROWS.map((item) => (
	{
		name: item.nameHtml,
		note: item.noteHtml,
	}));

	function row(name: string, note: string | null = null)
	{
		return {
			name,
			note,
		};
	}

	describe("collectHelperTags", () =>
	{
		it("lists the #tags and @tags of the SO fixture", () =>
		{
			expect(collectHelperTags(SO_TEXT)).toStrictEqual(
				{
					hashTags: ["#soTag"],
					atTags: ["@soPerson"],
				},
			);
		});

		it("orders by count descending, then case-insensitive alphabetical", () =>
		{
			expect(collectHelperTags([...SO_TEXT, row("Again #soTag"), row("Last #zeta")])).toStrictEqual(
				{
					hashTags: ["#soTag", "#zeta"],
					atTags: ["@soPerson"],
				},
			);
			expect(collectHelperTags([row("#beta #Alpha @b @A")])).toStrictEqual(
				{
					hashTags: ["#Alpha", "#beta"],
					atTags: ["@A", "@b"],
				},
			);
		});

		it("keeps the casing of the first occurrence and counts case-insensitively", () =>
		{
			expect(
				collectHelperTags([row("#Zeta"), row("#zeta"), row("#zeta"), row("#alpha"), row("#alpha")]),
			).toStrictEqual(
				{
					hashTags: ["#Zeta", "#alpha"],
					atTags: [],
				},
			);
		});

		it("reads tags from notes and plain text, ignoring markup, URLs and null text", () =>
		{
			expect(
				collectHelperTags([
					row("<b>#bold</b> text", "note @noter"),
					row("see https://example.com/#anchor", null),
					row("", null),
				]),
			).toStrictEqual(
				{
					hashTags: ["#bold"],
					atTags: ["@noter"],
				},
			);
		});

		it("limits each list to 1000 tags", () =>
		{
			const rows = Array.from(
				{
					length: 1001,
				},
				(_, index) => row(`#t${String(index).padStart(4, "0")}`),
			);
			const {hashTags} = collectHelperTags(rows);
			expect(
				{
					length: hashTags.length,
					last: hashTags.at(-1),
				},
			).toStrictEqual(
				{
					length: 1000,
					last: "#t0999",
				},
			);
		});
	});

	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const SEEDED_AT = "2026-01-01 00:00:00.000";

	/*
	 * root #rootTag
	 *   a #inside
	 *     a1 @deep
	 *   deleted #gone (no longer live)
	 * other #outside
	 */
	const TREE: [id: string, parentId: string | null, name: string][] = [
		["root", null, "Root #rootTag"],
		["a", "root", "Alpha #inside"],
		["a1", "a", "Alpha child @deep"],
		["other", null, "Other #outside"],
	];

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	function setup()
	{
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		bindTreeHost(db, nodeTreeHost(sqlite));
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		for (const [id, parentId, name] of TREE)
		{
			db.insert(nodeContent)
				.values(
					{
						id,
						name,
						note: null,
						parentId,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		db.insert(nodeContent)
			.values(
				{
					id: "deleted",
					name: "Gone #gone",
					note: null,
					parentId: "root",
					systemFrom: SEEDED_AT,
					systemTo: SEEDED_AT,
				},
			)
			.run();
		return db;
	}

	describe("loadHelperTags", () =>
	{
		it("lists the tags of live descendants of the root, excluding the root", () =>
		{
			expect(loadHelperTags(setup(), "root")).toStrictEqual(
				{
					hashTags: ["#inside"],
					atTags: ["@deep"],
				},
			);
		});

		it("lists the whole tree when rootId is empty", () =>
		{
			expect(loadHelperTags(setup(), "")).toStrictEqual(
				{
					hashTags: ["#inside", "#outside", "#rootTag"],
					atTags: ["@deep"],
				},
			);
		});
	});
});

describe("search helpers", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

	const TAB_CLASS = 'class="py-2xs px-ml rounded-[16px] !text-on-surface !bg-transparent"';
	const SELECTED_TAB_CLASS = 'class="py-2xs px-ml rounded-[16px] !bg-secondary"';

	function render(overrides: Partial<SearchHelpersProps> = {}): string
	{
		const props: SearchHelpersProps =
		{
			query: "",
			focused: true,
			autocompletePopulated: false,
			tags:
			{
				hashTags: ["#soTag"],
				atTags: ["@soPerson"],
			},
			selection:
			{
				tab: -1,
				chip: -1,
			},
			onHoverTab: () =>
			{
			},
			onInsert: () =>
			{
			},
			...overrides,
		};
		return renderToStaticMarkup(createElement(SearchHelpers, props));
	}

	function count(html: string, needle: string): number
	{
		return html.split(needle).length - 1;
	}

	function icons(html: string): string[]
	{
		return [...html.matchAll(/data-icon="([^"]+)"/gu)].map((match) => match[1]);
	}

	function chipTexts(html: string): string[]
	{
		return [...html.matchAll(/desktop:text-xs">([^<]*)</gu)].map((match) => match[1]);
	}

	function stripTags(html: string): string
	{
		return html.replaceAll(/<[^>]+>/gu, "");
	}

	describe("SearchHelpers", () =>
	{
		it("renders seven unselected tabs in upstream icon order and no chips", () =>
		{
			const html = render();
			expect(
				{
					tabs: count(html, TAB_CLASS),
					icons: icons(html),
					menuItems: count(html, "menuItem"),
				},
			).toStrictEqual(
				{
					tabs: 7,
					icons: ["globe", "hashtag", "at", "calendar-days", "clock-rotate-left", "users", "ellipsis"],
					menuItems: 0,
				},
			);
		});

		it("renders the exact upstream flyout wrapper and tab markup", () =>
		{
			const html = render();
			expect(html).toContain(
				` class="wf-header flex flex-col
      border border-solid border-primary font-normal text-xs
      rounded-md bg-primary shadow-md
      overflow-x-hidden
      [transition:200ms_opacity]
      print:hidden absolute flyout menu !-mt-px !px-[5%] !pt-0 !pb-[2px] !bg-primary
        !border-primary"`,
			);
			expect(html).toContain(
				`<div class="relative py-s shrink-0 flex justify-around overflow-hidden"><div ${TAB_CLASS}><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="globe" class="svg-inline--fa fa-globe fa-sm " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
			);
		});

		it("renders the flyout through DomKit Flyout: transform origin and rounded no-top style", () =>
		{
			const html = render();
			const style = /<div class=""><div style="([^"]*)"/u.exec(html)?.[1];
			expect(style).toContain("transform:scale(1, 1) translateX(-50%);transform-origin:0 0");
			expect(style).toContain("min-width:100%;max-width:100%");
			expect(style).toContain("max-height:280px;overflow-y:auto");
		});

		it("tints the flyout border once the query is non-empty", () =>
		{
			const html = render(
				{
					query: "x",
				},
			);
			expect(
				{
					tint: count(html, "!bg-primary\n        !border-[var(--wf-border-tint)]"),
					primary: count(html, '!border-primary"'),
				},
			).toStrictEqual(
				{
					tint: 1,
					primary: 0,
				},
			);
		});

		it("omits the #TAGS tab when there are no hash tags", () =>
		{
			const html = render(
				{
					tags:
					{
						hashTags: [],
						atTags: ["@soPerson"],
					},
				},
			);
			expect(
				{
					tabs: count(html, TAB_CLASS),
					icons: icons(html),
				},
			).toStrictEqual(
				{
					tabs: 6,
					icons: ["globe", "at", "calendar-days", "clock-rotate-left", "users", "ellipsis"],
				},
			);
		});

		it("keeps the @TAGS tab with upstream's constant mentioned: chip when there are no at tags", () =>
		{
			const html = render(
				{
					tags:
					{
						hashTags: ["#soTag"],
						atTags: [],
					},
					selection:
					{
						tab: 2,
						chip: -1,
					},
				},
			);
			expect(
				{
					icons: icons(html),
					chips: chipTexts(html),
				},
			).toStrictEqual(
				{
					icons: ["globe", "hashtag", "at", "calendar-days", "clock-rotate-left", "users", "ellipsis"],
					chips: ["mentioned:"],
				},
			);
		});

		it("shows the dates chips in order and selects the fourth tab", () =>
		{
			const html = render(
				{
					selection:
					{
						tab: 3,
						chip: -1,
					},
				},
			);
			const tabClasses = [...html.matchAll(/<div (class="py-2xs px-ml[^"]*")>/gu)].map((match) => match[1]);
			expect(
				{
					chips: chipTexts(html),
					tabClasses,
				},
			).toStrictEqual(
				{
					chips: [
						"date:",
						"date-before:",
						"date-after:",
						"day-of-week:",
						"today",
						"tomorrow",
						"yesterday",
						"this week",
						"next week",
						"last week",
						"this month",
						"next month",
						"last month",
					],
					tabClasses: [TAB_CLASS, TAB_CLASS, TAB_CLASS, SELECTED_TAB_CLASS, TAB_CLASS, TAB_CLASS, TAB_CLASS],
				},
			);
		});

		it("renders the exact upstream keyboard-mode chip markup and highlights the active chip", () =>
		{
			const html = render(
				{
					selection:
					{
						tab: 3,
						chip: 1,
					},
				},
			);
			const chip = (text: string, state: string) =>
				`<div class="min-w-0 py-xs px-px"><a class="pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary${state}" style="height:20px"><span class="relative flex justify-between items-center"><span class="grow flex items-center gap-m whitespace-nowrap text-ellipsis overflow-hidden desktop:text-xs">${text}</span></span></a></div>`;
			expect(html).toContain(
				`<div><div class="shrink-0 h-auto flex overflow-hidden [&amp;:not(:last-child)]:mb-ml"><div class="relative min-w-0 flex flex-row flex-wrap items-center">${chip("date:", " mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem !py-0 !px-s !flex text-xs rounded-[16px] [&amp;_span]:whitespace-nowrap [&amp;_span]:text-ellipsis [&amp;_span]:overflow-hidden !text-on-surface !bg-transparent")}${chip("date-before:", " bg-secondary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem !py-0 !px-s !flex text-xs rounded-[16px] [&amp;_span]:whitespace-nowrap [&amp;_span]:text-ellipsis [&amp;_span]:overflow-hidden !text-on-surface !bg-secondary active")}`,
			);
		});

		it("switches chips to the hover classes once the mouse has been used", () =>
		{
			const chipClasses = (canHover: boolean) =>
				[
					...render(
						{
							selection:
							{
								tab: 3,
								chip: 1,
							},
							canHover,
						},
					).matchAll(/<a class="([^"]*)"/gu),
				]
					.slice(0, 2)
					.map((match) => match[1]);
			const [inactive, active] = chipClasses(false);
			expect(chipClasses(true)).toStrictEqual([
				`${inactive.replace("text-primary mobile:", "text-primary hover:bg-secondary mobile:")} canHover`,
				`${active.replace("bg-secondary mobile:", "bg-secondary hover:bg-secondary mobile:")} canHover`,
			]);
		});

		it("labels the changed-by chips me and others", () =>
		{
			expect(
				chipTexts(
					render(
						{
							selection:
							{
								tab: 5,
								chip: -1,
							},
						},
					),
				),
			).toStrictEqual(["me", "others"]);
		});

		it("lists the tag values under their tabs", () =>
		{
			expect(
				{
					hash: chipTexts(
						render(
							{
								selection:
								{
									tab: 1,
									chip: -1,
								},
							},
						),
					),
					at: chipTexts(
						render(
							{
								selection:
								{
									tab: 2,
									chip: -1,
								},
							},
						),
					),
					operators: chipTexts(
						render(
							{
								selection:
								{
									tab: 6,
									chip: -1,
								},
							},
						),
					),
				},
			).toStrictEqual(
				{
					hash: ["#soTag"],
					at: ["mentioned:", "@soPerson"],
					operators: ["is:", "has:", "in:", "text:", "link:", "highlight:"],
				},
			);
		});

		it("shows the jump-to hint on the globe tab", () =>
		{
			const html = render(
				{
					selection:
					{
						tab: 0,
						chip: -1,
					},
				},
			);
			const hint =
				html.match(
					/<div class="pt-\[5px\] pb-\[3px\] text-\[12px\] leading-\[16px\] text-center">.*?<\/div>/u,
				)?.[0] ?? "";
			expect(stripTags(hint)).toBe("For the jump to-menu, hit enter now,  or meta+k from anywhere.");
		});

		it("hides the wrapper while the autocomplete is populated or the input is blurred", () =>
		{
			expect(
				{
					populated: render(
						{
							autocompletePopulated: true,
						},
					).startsWith('<div class="hidden">'),
					blurred: render(
						{
							focused: false,
						},
					).startsWith('<div class="hidden">'),
				},
			).toStrictEqual(
				{
					populated: true,
					blurred: true,
				},
			);
		});
	});

	describe("search helper flyout CSS", () =>
	{
		it("matches upstream's computed line-height, icon box and selected-tab underline", () =>
		{
			expect(
				{
					lineHeight: cssBlock(styles, ".searchBox .flyout")["line-height"],
					icon: cssBlock(styles, ".searchBox .flyout .fa-sm"),
					underline: cssBlock(styles, String.raw`.searchBox .flyout .justify-around.after\:absolute::after`),
				},
			).toStrictEqual(
				{
					lineHeight: "1",
					icon:
					{
						height: "1em",
						width: "auto",
					},
					underline:
					{
						content: '""',
						position: "absolute",
						"z-index": "1",
						top: "100%",
						right: "0",
						bottom: "0",
						left: "0",
						height: "1px",
						"margin-top": "-1px",
						"background-color": "transparent",
					},
				},
			);
		});
	});
});

describe("search locations abort", () =>
{
	describe("POST /api/search/locations", () =>
	{
		it("answers 499 without reading the tree for a request the client already aborted", async () =>
		{
			const ctx =
			{
				get db(): never
				{
					throw new Error("the tree must not be read");
				},
				config:
				{
					features:
					{
						treeSnapshot: true,
					},
				},
			} as unknown as ServerContext;
			const controller = new AbortController();
			controller.abort();
			const response = await httpAppFor(ctx).fetch(
				new Request(
					"http://x/api/search/locations",
					{
						method: "POST",
						body: JSON.stringify(
							{
								query: "a",
							},
						),
						signal: controller.signal,
					},
				),
			);
			expect(
				{
					status: response.status,
					body: await response.text(),
				},
			).toStrictEqual(
				{
					status: 499,
					body: "",
				},
			);
		});
	});
});

describe("search prefetch", () =>
{
	function ids(count: number): string[]
	{
		return Array.from(
			{
				length: count,
			},
			(_, index) => `ancestor-${index}`,
		);
	}

	/** A fetch that records every call and how many were in flight at once, resolving each on the next tick. */
	function recordingFetch()
	{
		const calls: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const fetchChildren = async (id: string | null): Promise<NodeResponse[]> =>
		{
			calls.push(String(id));
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) =>
			{
				setTimeout(resolve, 0);
			});
			inFlight -= 1;
			return [];
		};
		return {
			calls,
			fetchChildren,
			maxInFlight: () => maxInFlight,
		};
	}

	describe("prefetchSearchAncestors", () =>
	{
		it("fetches only the first ancestors in document order, a few at a time", async () =>
		{
			const queryClient = new QueryClient();
			const recorder = recordingFetch();

			await prefetchSearchAncestors(queryClient, ids(6000), recorder.fetchChildren, new AbortController().signal);

			expect(
				{
					calls: recorder.calls,
					maxInFlight: recorder.maxInFlight(),
					concurrency: SEARCH_PREFETCH_CONCURRENCY,
				},
			).toStrictEqual(
				{
					calls: ids(SEARCH_PREFETCH_LIMIT),
					maxInFlight: SEARCH_PREFETCH_CONCURRENCY,
					concurrency: 6,
				},
			);
			expect(queryClient.getQueryData(nodeKeys.children("ancestor-0"))).toStrictEqual([]);
		});

		it("skips ancestors whose children are already cached", async () =>
		{
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.children("ancestor-1"), []);
			const recorder = recordingFetch();

			await prefetchSearchAncestors(queryClient, ids(3), recorder.fetchChildren, new AbortController().signal);

			expect(recorder.calls).toStrictEqual(["ancestor-0", "ancestor-2"]);
		});

		it("starts no new fetches once aborted", async () =>
		{
			const queryClient = new QueryClient();
			const recorder = recordingFetch();
			const controller = new AbortController();

			const done = prefetchSearchAncestors(queryClient, ids(50), recorder.fetchChildren, controller.signal);
			controller.abort();
			await done;

			expect(recorder.calls).toStrictEqual(ids(SEARCH_PREFETCH_CONCURRENCY));
		});

		it("does not retry a failed prefetch", async () =>
		{
			const queryClient = new QueryClient();
			const calls: string[] = [];
			const failing = async (id: string | null): Promise<NodeResponse[]> =>
			{
				calls.push(String(id));
				return Promise.reject(new Error("net::ERR_INSUFFICIENT_RESOURCES"));
			};

			await prefetchSearchAncestors(queryClient, ids(2), failing, new AbortController().signal);

			expect(calls).toStrictEqual(["ancestor-0", "ancestor-1"]);
		});
	});
});

describe("search text op", () =>
{
	// From the registry, which the web setup wraps to check each op output against its schema.
	const searchText = Ops["search.text"];

	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const SEEDED_AT = "2026-01-01 00:00:00.000";

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	function seededContext(): ServerContext
	{
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		const live =
		{
			systemFrom: SEEDED_AT,
			systemTo: FAR_FUTURE_DATE,
		};
		db.insert(nodeContent)
			.values([
				{
					id: "parent",
					name: "Parent",
					note: null,
					parentId: null,
					...live,
				},
				{
					id: "done",
					name: "Needle done",
					note: null,
					parentId: "parent",
					...live,
				},
				{
					id: "open",
					name: "Needle open",
					note: "a note",
					parentId: "parent",
					...live,
				},
			])
			.run();
		db.insert(nodeMetadata)
			.values([
				{
					nodeId: "done",
					priority: 0,
					completedAt: new Date(1_600_000_100_000),
					...live,
				},
				{
					nodeId: "open",
					priority: 1,
					completedAt: null,
					...live,
				},
			])
			.run();
		return {
			db,
		} as unknown as ServerContext;
	}

	describe("search.text", () =>
	{
		it("returns completedAt in epoch seconds, or null when incomplete", async () =>
		{
			const ctx = seededContext();

			const result = await Promise.resolve(
				searchText.run(
					ctx,
					{
						query: "Needle",
						limit: 10,
						offset: 0,
					},
				),
			);

			expect(result).toStrictEqual(
				{
					ok: true,
					value:
					{
						results: [
							{
								id: "done",
								name: "Needle done",
								note: null,
								parentPath: "Parent",
								completedAt: 1_600_000_100,
							},
							{
								id: "open",
								name: "Needle open",
								note: "a note",
								parentPath: "Parent",
								completedAt: null,
							},
						],
						totalCount: 2,
					},
				},
			);
		});

		it("returns completedAt when the query joins metadata", async () =>
		{
			const ctx = seededContext();

			const result = await Promise.resolve(
				searchText.run(
					ctx,
					{
						query: "Needle is:complete",
						limit: 10,
						offset: 0,
					},
				),
			);

			expect(result).toStrictEqual(
				{
					ok: true,
					value:
					{
						results: [
							{
								id: "done",
								name: "Needle done",
								note: null,
								parentPath: "Parent",
								completedAt: 1_600_000_100,
							},
						],
						totalCount: 1,
					},
				},
			);
		});
	});
});

describe("search tree route", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const SEEDED_AT = "2026-01-01 00:00:00.000";
	const CREATED = new Date("2026-02-01T00:00:00Z");
	const MODIFIED = new Date("2026-03-01T00:00:00Z");
	const COMPLETED = new Date("2026-04-01T00:00:00Z");

	/*
	 * root
	 *   a         (todo layout, timestamps)
	 *     a1
	 *   mirror    (mirror of other; its own stale text is ignored)
	 *   refs      (references root, excluded with its children)
	 *     bl
	 *   deleted   (no longer live)
	 * other       (outside root)
	 */
	const TREE: [id: string, parentId: string | null, name: string][] = [
		["root", null, "Root"],
		["a", "root", "Alpha"],
		["a1", "a", "Alpha child"],
		["mirror", "root", "stale"],
		["refs", "root", ""],
		["bl", "refs", ""],
		["other", null, "Other"],
	];

	const open: DatabaseConstructor.Database[] = [];
	const tempDirs: string[] = [];
	afterEach(() =>
	{
		vi.useRealTimers();
		for (const sqlite of open.splice(0))
		{
			if (sqlite.open)
			{
				sqlite.close();
			}
		}
		for (const dir of tempDirs.splice(0))
		{
			rmSync(
				dir,
				{
					recursive: true,
					force: true,
				},
			);
		}
	});

	function tempPath(): string
	{
		const dir = mkdtempSync(join(tmpdir(), "tree-snapshot-"));
		tempDirs.push(dir);
		return join(dir, "cache.sqlite");
	}

	function connect(path: string)
	{
		const sqlite = new DatabaseConstructor(path);
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		bindTreeHost(db, nodeTreeHost(sqlite));
		return db;
	}

	function setup(path = ":memory:")
	{
		const sqlite = new DatabaseConstructor(path);
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		bindTreeHost(db, nodeTreeHost(sqlite));
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		TREE.forEach(([id, parentId, name], priority) =>
		{
			db.insert(nodeContent)
				.values(
					{
						id,
						name,
						note: id === "other" ? "other note" : null,
						parentId,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			db.insert(nodeMetadata)
				.values(
					{
						nodeId: id,
						priority,
						createdAt: id === "a" ? CREATED : null,
						modifiedAt: id === "a" ? MODIFIED : null,
						completedAt: id === "a" ? COMPLETED : null,
						layoutMode: id === "a" ? "todo" : null,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		});
		db.insert(nodeContent)
			.values(
				{
					id: "deleted",
					name: "Gone",
					note: null,
					parentId: "root",
					systemFrom: SEEDED_AT,
					systemTo: SEEDED_AT,
				},
			)
			.run();
		db.insert(referencesRoots)
			.values(
				{
					nodeId: "refs",
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		db.insert(mirrors)
			.values(
				{
					mirrorId: "mirror",
					originalId: "other",
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		return db;
	}

	const NO_META =
	{
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		layoutMode: null,
	};

	describe("loadTreeSkeletonRows and loadTreeRowText", () =>
	{
		it("loads the whole-tree search rows without text, and the live text (a mirror's from its original) by id", () =>
		{
			const db = setup();
			expect(
				{
					skeleton: loadTreeSkeletonRows(db),
					text: loadTreeRowText(db, ["mirror", "a", "deleted", "missing"]),
				},
			).toStrictEqual(
				{
					skeleton: loadTreeSearchRows(db, null).map((row) => (
					{
						...row,
						name: null,
						note: null,
					})),
					text: new Map([
						[
							"a",
							{
								name: "Alpha",
								note: null,
							},
						],
						[
							"mirror",
							{
								name: "Other",
								note: "other note",
							},
						],
					]),
				},
			);
		});
	});

	describe("jump-menu search with the tree snapshot off", () =>
	{
		it("answers the switcher and the location picker exactly as the snapshot does", async () =>
		{
			const db = setup();
			const post = async (treeSnapshot: boolean, path: string, body: object) =>
			{
				const ctx =
				{
					db,
					config:
					{
						features:
						{
							treeSnapshot,
						},
					},
				} as unknown as ServerContext;
				const response = await httpAppFor(ctx).fetch(
					new Request(
						`http://x/api/search/${path}`,
						{
							method: "POST",
							body: JSON.stringify(body),
						},
					),
				);
				return (await response.json()) as
					|
					  {
							results: unknown[];
					  }
					|
					  {
							matchIds: unknown[];
					  };
			};
			const requests: [path: string, body: object][] = [
				[
					"switcher",
					{
						query: "other",
					},
				],
				[
					"switcher",
					{
						query: "root > child",
						showCompleted: true,
					},
				],
				[
					"switcher",
					{
						query: "alpha",
						showCompleted: true,
					},
				],
				[
					"locations",
					{
						query: "alpha",
						excludeId: "a1",
						showCompleted: true,
					},
				],
				[
					"tree",
					{
						query: "alpha",
						rootId: null,
					},
				],
				[
					"tree",
					{
						query: "root > child",
						rootId: null,
					},
				],
				[
					"tree",
					{
						query: "is:backlink",
						rootId: null,
					},
				],
			];
			const answers = async (treeSnapshot: boolean) =>
				Promise.all(requests.map(async ([path, body]) => post(treeSnapshot, path, body)));
			const paged = await answers(false);
			expect(paged).toStrictEqual(await answers(true));
			const sizes = paged.map((answer) => ("matchIds" in answer ? answer.matchIds : answer.results).length);
			expect(sizes).toStrictEqual([1, 1, 2, 1, 2, 1, 1]);
		});

		it("answers accented, tagged and paged switcher queries exactly as the snapshot does", async () =>
		{
			const db = setup();
			db.update(nodeContent)
				.set(
					{
						name: "Al<b>pha</b> \u00E9t\u00E9",
					},
				)
				.where(eq(nodeContent.id, "a"))
				.run();
			db.update(nodeContent)
				.set(
					{
						name: "Alpha child ete",
					},
				)
				.where(eq(nodeContent.id, "a1"))
				.run();
			const post = async (treeSnapshot: boolean, query: string, extra: object = {}) =>
			{
				const ctx =
				{
					db,
					config:
					{
						features:
						{
							treeSnapshot,
						},
					},
				} as unknown as ServerContext;
				const response = await httpAppFor(ctx).fetch(
					new Request(
						"http://x/api/search/switcher",
						{
							method: "POST",
							body: JSON.stringify(
								{
									query,
									showCompleted: true,
									...extra,
								},
							),
						},
					),
				);
				return (await response.json()) as
				{
					results:
					{
						id: string;
					}[];
				};
			};
			const requests: [string, object][] = [
				["alpha", {}],
				["ete", {}],
				["\u00E9t\u00E9", {}],
				[
					"alpha",
					{
						limit: 1,
					},
				],
				[
					"alpha",
					{
						offset: 1,
					},
				],
				["oth", {}],
			];
			const answers = async (treeSnapshot: boolean) =>
				Promise.all(requests.map(async ([query, extra]) => post(treeSnapshot, query, extra)));
			const paged = await answers(false);
			expect(paged).toStrictEqual(await answers(true));
			expect(paged.map(({results}) => results.map(({id}) => id))).toStrictEqual([
				["a", "a1"],
				["a", "a1"],
				["a", "a1"],
				["a"],
				["a1"],
				["other"],
			]);
		});

		it("keeps the compact switcher skeleton between queries until the database changes", () =>
		{
			const db = setup();
			const first = loadSwitcherSkeleton(db);
			const again = loadSwitcherSkeleton(db);
			db.update(nodeContent)
				.set(
					{
						name: "Renamed",
					},
				)
				.where(eq(nodeContent.id, "a1"))
				.run();
			const afterWrite = loadSwitcherSkeleton(db);
			expect(
				{
					same: again === first,
					rebuilt: afterWrite !== first,
					ids: afterWrite.ids,
				},
			).toStrictEqual(
				{
					same: true,
					rebuilt: true,
					ids: ["root", "a", "a1", "mirror", "other"],
				},
			);
		});

		it("builds the switcher skeleton from flat rows exactly as from the recursive tree rows", () =>
		{
			const db = setup();
			const add = (
				id: string,
				parentId: string | null,
				priority: number,
				extra:
				{
					completed?: boolean;
				} = {},
			) =>
			{
				db.insert(nodeContent)
					.values(
						{
							id,
							name: id,
							note: null,
							parentId,
							systemFrom: SEEDED_AT,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
				db.insert(nodeMetadata)
					.values(
						{
							nodeId: id,
							priority,
							modifiedAt: MODIFIED,
							completedAt: extra.completed === true ? COMPLETED : null,
							systemFrom: SEEDED_AT,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
			};
			// A backlink item's child hangs at the top; nothing below an `ai.inChat` item is reached; equal priorities keep
			// depth-then-id order; a row under a missing parent is unreachable.
			add("blChild", "bl", 0);
			add("chat", "root", 7);
			add("chatChild", "chat", 0);
			add("tieB", "other", 1);
			add("tieA", "other", 1);
			add(
				"doneParent",
				"other",
				2,
				{
					completed: true,
				},
			);
			add("underDone", "doneParent", 0);
			add("orphan", "missing", 0);
			db.insert(aiMetadata)
				.values(
					{
						nodeId: "chat",
						inChat: 1,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			// Sizes come from each row's own text; a mirror's is left unsized.
			db.update(nodeContent)
				.set(
					{
						name: "R<i>oo</i>t #x",
					},
				)
				.where(eq(nodeContent.id, "root"))
				.run();
			db.update(nodeContent)
				.set(
					{
						note: "caf\u00E9",
					},
				)
				.where(eq(nodeContent.id, "a1"))
				.run();
			db.update(nodeContent)
				.set(
					{
						name: "@who &amp; co",
					},
				)
				.where(eq(nodeContent.id, "other"))
				.run();
			expect(buildSwitcherSkeleton(db)).toStrictEqual(compactSwitcherSkeleton(loadTreeSearchRows(db, null)));
		});

		it("finds live rows whose raw text holds the LIKE fragment, and reads their own text by id", () =>
		{
			const db = setup();
			db.update(nodeContent)
				.set(
					{
						name: "R<i>oo</i>t",
					},
				)
				.where(eq(nodeContent.id, "root"))
				.run();
			db.update(nodeContent)
				.set(
					{
						note: "ALPine caf\u00E9",
					},
				)
				.where(eq(nodeContent.id, "other"))
				.run();
			const scan = switcherTextScan(db, 2);
			const byId = <
				T extends
				{
					id: string;
				},
			>(
				rows: Iterable<T>,
			): T[] =>
				// oxlint-disable-next-line unicorn/no-array-sort -- a fresh copy; the test lib has no toSorted
				[...rows].sort((a, b) => a.id.localeCompare(b.id));
			expect(
				{
					holding: new Set(scan.holding("alp")),
					text: byId(scan.read(["mirror", "a", "deleted"])),
				},
			).toStrictEqual(
				{
					holding: new Set(["a", "a1", "other"]),
					text: byId([
						{
							id: "a",
							name: "Alpha",
							note: null,
						},
						{
							id: "mirror",
							name: "stale",
							note: null,
						},
					]),
				},
			);
		});

		it("answers the whole-tree helper tags exactly as the snapshot does", async () =>
		{
			const db = setup();
			db.update(nodeContent)
				.set(
					{
						name: "Alpha #Tag @Pat",
					},
				)
				.where(eq(nodeContent.id, "a"))
				.run();
			db.update(nodeContent)
				.set(
					{
						name: "Alpha child #tag @Pat",
					},
				)
				.where(eq(nodeContent.id, "a1"))
				.run();
			const helpers = async (treeSnapshot: boolean) =>
			{
				const ctx =
				{
					db,
					config:
					{
						features:
						{
							treeSnapshot,
						},
					},
				} as unknown as ServerContext;
				const response = await httpAppFor(ctx).fetch(new Request("http://x/api/search/helpers?rootId="));
				return (await response.json()) as unknown;
			};
			const paged = await helpers(false);
			expect(paged).toStrictEqual(await helpers(true));
			expect(paged).toStrictEqual(
				{
					hashTags: ["#Tag"],
					atTags: ["@Pat"],
				},
			);
		});
	});

	describe("loadTreeSearchRows", () =>
	{
		it("loads the live subtree with metadata, mirror text and no references content", () =>
		{
			expect(new Set(loadTreeSearchRows(setup(), "root"))).toStrictEqual(
				new Set([
					{
						id: "a",
						parentId: "root",
						priority: 1,
						name: "Alpha",
						note: null,
						createdAt: CREATED.getTime(),
						modifiedAt: MODIFIED.getTime(),
						completedAt: COMPLETED.getTime(),
						layoutMode: "todo",
						isMirror: false,
						isBacklink: false,
						fileType: null,
					},
					{
						id: "a1",
						parentId: "a",
						priority: 2,
						name: "Alpha child",
						note: null,
						...NO_META,
						isMirror: false,
						isBacklink: false,
						fileType: null,
					},
					{
						id: "mirror",
						parentId: "root",
						priority: 3,
						name: "Other",
						note: "other note",
						...NO_META,
						isMirror: true,
						isBacklink: false,
						fileType: null,
					},
					{
						id: "root",
						parentId: null,
						priority: 0,
						name: "Root",
						note: null,
						...NO_META,
						isMirror: false,
						isBacklink: false,
						fileType: null,
					},
				]),
			);
		});

		it("reads a mirror's completion from its original and ignores the mirror's own completedAt", () =>
		{
			const db = setup();
			const completionOf = () =>
				loadTreeSearchRows(db, "root").find((row) => row.id === "mirror")?.completedAt ?? null;
			const initial = completionOf();
			rewriteMetadata(
				db,
				"mirror",
				{
					completedAt: COMPLETED,
				},
			);
			const staleOwn = completionOf();
			rewriteMetadata(
				db,
				"other",
				{
					completedAt: COMPLETED,
				},
			);
			const originalDone = completionOf();

			expect(
				{
					initial,
					staleOwn,
					originalDone,
				},
			).toStrictEqual(
				{
					initial: null,
					staleOwn: null,
					originalDone: COMPLETED.getTime(),
				},
			);
		});

		it("loads every live row when rootId is null", () =>
		{
			const ids = loadTreeSearchRows(setup(), null).map((row) => row.id);
			expect(new Set(ids)).toStrictEqual(new Set(["a", "a1", "mirror", "other", "root"]));
		});
	});

	function insertNode(db: ReturnType<typeof setup>, id: string, parentId: string | null, name: string)
	{
		db.insert(nodeContent)
			.values(
				{
					id,
					name,
					note: null,
					parentId,
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	}

	function idSet(
		rows:
		{
			id: string;
		}[],
	): Set<string>
	{
		return new Set(rows.map((row) => row.id));
	}

	let systemMs = Date.parse("2026-05-01T00:00:00Z");

	/** A system time later than every one written before it, as the cache's system clock issues them. */
	function nextSystemTime(): string
	{
		systemMs += 1;
		return formatTemporalTimestamp(new Date(systemMs));
	}

	type Db = ReturnType<typeof setup>;

	/** Version a node's content as the cache does: close the live row and open a changed copy. */
	function rewriteContent(
		db: Db,
		id: string,
		changes:
		{
			name?: string;
			note?: string | null;
			parentId?: string | null;
		},
	)
	{
		const at = nextSystemTime();
		const live = and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE));
		const current = db.select().from(nodeContent).where(live).get();
		if (current === undefined)
		{
			throw new Error(`no live content for ${id}`);
		}
		db.update(nodeContent)
			.set(
				{
					systemTo: at,
				},
			)
			.where(live)
			.run();
		db.insert(nodeContent)
			.values(
				{
					...current,
					...changes,
					systemFrom: at,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	}

	function rewriteMetadata(
		db: Db,
		id: string,
		changes:
		{
			priority?: number;
			completedAt?: Date | null;
		},
	)
	{
		const at = nextSystemTime();
		const live = and(eq(nodeMetadata.nodeId, id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE));
		const current = db.select().from(nodeMetadata).where(live).get();
		if (current === undefined)
		{
			throw new Error(`no live metadata for ${id}`);
		}
		db.update(nodeMetadata)
			.set(
				{
					systemTo: at,
				},
			)
			.where(live)
			.run();
		db.insert(nodeMetadata)
			.values(
				{
					...current,
					...changes,
					systemFrom: at,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	}

	function createNode(db: Db, id: string, parentId: string | null, name: string)
	{
		db.insert(nodeContent)
			.values(
				{
					id,
					name,
					note: null,
					parentId,
					systemFrom: nextSystemTime(),
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	}

	function endContent(db: Db, id: string)
	{
		db.update(nodeContent)
			.set(
				{
					systemTo: nextSystemTime(),
				},
			)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.run();
	}

	describe("AI chat nodes", () =>
	{
		/** An `ai.inChat` mailbox under root with a message under it, as upstream's AI chat creates. */
		function setupWithChat()
		{
			const db = setup();
			insertNode(db, "chat", "root", "AI Messages");
			insertNode(db, "message", "chat", "Hello");
			db.insert(aiMetadata)
				.values(
					{
						nodeId: "chat",
						inChat: 1,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			return db;
		}

		it("leaves ai.inChat nodes and everything below them out of the search rows, like upstream's inline_search ignore", () =>
		{
			const db = setupWithChat();
			const expected = new Set(["a", "a1", "mirror", "other", "root"]);

			expect(
				{
					sql: idSet(loadTreeSearchRows(db, null)),
					snapshot: idSet(loadTreeRows(db, null)),
					subtree: idSet(loadTreeRows(db, "root")),
				},
			).toStrictEqual(
				{
					sql: expected,
					snapshot: expected,
					subtree: new Set(["a", "a1", "mirror", "root"]),
				},
			);
		});
	});

	describe("loadTreeRows", () =>
	{
		it("answers the same rows as loadTreeSearchRows for the whole tree and for a subtree", () =>
		{
			const db = setup();
			expect(loadTreeRows(db, null)).toStrictEqual(loadTreeSearchRows(db, null));
			expect(new Set(loadTreeRows(db, "root"))).toStrictEqual(new Set(loadTreeSearchRows(db, "root")));
			expect(idSet(loadTreeRows(db, "a"))).toStrictEqual(new Set(["a", "a1"]));
			expect(idSet(loadTreeRows(db, "refs"))).toStrictEqual(idSet(loadTreeSearchRows(db, "refs")));
			expect(loadTreeRows(db, "missing")).toStrictEqual([]);
		});

		it("warms the jump-menu text of every row when it warms the snapshot", () =>
		{
			const db = setup();
			warmTreeSnapshot(db);
			const rows = peekTreeSnapshotRows(db) ?? [];
			expect(rows.filter((row) => peekSwitcherText(row)?.fields === undefined)).toStrictEqual([]);
		});

		it("reuses one snapshot while the database is unchanged", () =>
		{
			const db = setup();
			const first = loadTreeRows(db, null);
			expect(loadTreeRows(db, null)).toBe(first);
			expect(loadTreeRows(db, "root")[0]).toBe(first.find((row) => row.id === "root"));
		});

		it("reloads after a write on the same connection", () =>
		{
			const db = setup();
			const first = loadTreeRows(db, null);
			insertNode(db, "new", "root", "New");
			const second = loadTreeRows(db, null);
			expect(second).not.toBe(first);
			expect(idSet(second)).toStrictEqual(new Set(["a", "a1", "mirror", "new", "other", "root"]));
		});

		it("keeps unchanged row objects across a reload so their derived search text stays cached", () =>
		{
			const db = setup();
			const first = loadTreeRows(db, null);
			rewriteContent(
				db,
				"a",
				{
					name: "Alpha renamed",
				},
			);
			const second = loadTreeRows(db, null);
			const byId = (rows: typeof first, id: string) => rows.find((row) => row.id === id);
			expect(byId(second, "a1")).toBe(byId(first, "a1"));
			expect(byId(second, "a")).not.toBe(byId(first, "a"));
			expect(byId(second, "a")?.name).toBe("Alpha renamed");
		});

		it("serves the previous snapshot after another connection writes and rebuilds it 500ms later off the request path", () =>
		{
			vi.useFakeTimers();
			const path = tempPath();
			const db = setup(path);
			const first = loadTreeRows(db, null);
			insertNode(connect(path), "new", "root", "New");
			expect(loadTreeRows(db, null)).toBe(first);
			vi.advanceTimersByTime(499);
			expect(loadTreeRows(db, null)).toBe(first);
			vi.advanceTimersByTime(1);
			expect(idSet(loadTreeRows(db, null))).toStrictEqual(new Set(["a", "a1", "mirror", "new", "other", "root"]));
		});

		it("debounces scheduled rebuilds to 500ms after the last write", () =>
		{
			vi.useFakeTimers();
			const path = tempPath();
			const db = setup(path);
			const first = loadTreeRows(db, null);
			const other = connect(path);
			insertNode(other, "new", "root", "New");
			scheduleTreeSnapshotRebuild(db);
			vi.advanceTimersByTime(300);
			insertNode(other, "newer", "root", "Newer");
			scheduleTreeSnapshotRebuild(db);
			vi.advanceTimersByTime(300);
			expect(loadTreeRows(db, null)).toBe(first);
			vi.advanceTimersByTime(200);
			expect(idSet(loadTreeRows(db, null))).toStrictEqual(
				new Set(["a", "a1", "mirror", "new", "newer", "other", "root"]),
			);
		});

		it("warms the snapshot before the first request", () =>
		{
			vi.useFakeTimers();
			const path = tempPath();
			const db = setup(path);
			warmTreeSnapshot(db);
			insertNode(connect(path), "new", "root", "New");
			expect(idSet(loadTreeRows(db, null))).toStrictEqual(new Set(["a", "a1", "mirror", "other", "root"]));
		});

		it("schedules a rebuild after an op that wrote, not after one that only read", async () =>
		{
			vi.useFakeTimers();
			const path = tempPath();
			const db = setup(path);
			const other = connect(path);
			const store = inProcessStore(
				buildServerContext(
					{
						db,
						config:
						{
							mode: "standalone",
							accountEmail: "",
							sqlQueryLogging: false,
							calendarEnsureEnabled: false,
							calendarLayoutEnabled: false,
							features:
							{
								embeddings: false,
								treeSnapshot: true,
							},
						},
						ladderEvents: new LadderEventBus(),
					},
				),
				{
					read: defineOp(
						{
							input: z.object({}),
							output: z.number(),
							run: () => ok(loadTreeRows(db, null).length),
						},
					),
					write: defineOp(
						{
							input: z.object({}),
							output: z.null(),
							run: () =>
							{
								insertNode(db, "mine", "root", "Mine");
								return ok(null);
							},
						},
					),
				},
				{
					keepSnapshotWarm: true,
				},
			);
			const first = loadTreeRows(db, null);
			insertNode(other, "theirs", "root", "Theirs");
			await store.call("read" as never, {} as never);
			vi.advanceTimersByTime(400);
			await store.call("write" as never, {} as never);
			vi.advanceTimersByTime(400);
			expect(peekTreeSnapshotRows(db)).toBe(first);
			vi.advanceTimersByTime(100);
			expect(idSet(peekTreeSnapshotRows(db) ?? [])).toStrictEqual(
				new Set(["a", "a1", "mine", "mirror", "other", "root", "theirs"]),
			);
		});

		it("rebuilds a held switcher skeleton in the background after an op that wrote, never a skeleton not yet held", async () =>
		{
			vi.useFakeTimers();
			const db = setup();
			const store = inProcessStore(
				buildServerContext(
					{
						db,
						config:
						{
							mode: "standalone",
							accountEmail: "",
							sqlQueryLogging: false,
							calendarEnsureEnabled: false,
							calendarLayoutEnabled: false,
							features:
							{
								embeddings: false,
								treeSnapshot: false,
							},
						},
						ladderEvents: new LadderEventBus(),
					},
				),
				{
					write: defineOp(
						{
							input: z.object(
								{
									id: z.string(),
								},
							),
							output: z.null(),
							run: (_ctx, {id}) =>
							{
								insertNode(db, id, "root", id);
								return ok(null);
							},
						},
					),
				},
				{
					keepSwitcherSkeletonWarm: true,
				},
			);
			await store.call(
				"write" as never,
				{
					id: "cold",
				} as never,
			);
			vi.advanceTimersByTime(500);
			const unheld = peekSwitcherSkeleton(db);
			const first = loadSwitcherSkeleton(db);
			await store.call(
				"write" as never,
				{
					id: "warm",
				} as never,
			);
			vi.advanceTimersByTime(400);
			const pending = peekSwitcherSkeleton(db);
			vi.advanceTimersByTime(100);
			const rebuilt = peekSwitcherSkeleton(db);
			expect(
				{
					unheld,
					pendingIsFirst: pending === first,
					rebuiltIds: rebuilt?.ids,
					servedFromCache: loadSwitcherSkeleton(db) === rebuilt,
				},
			).toStrictEqual(
				{
					unheld: undefined,
					pendingIsFirst: true,
					rebuiltIds: ["root", "cold", "warm", "a", "a1", "mirror", "other"],
					servedFromCache: true,
				},
			);
		});

		it("skips a scheduled rebuild once the database is closed", () =>
		{
			vi.useFakeTimers();
			const db = setup();
			loadTreeRows(db, null);
			insertNode(db, "new", "root", "New");
			scheduleTreeSnapshotRebuild(db);
			db.$client.close();
			expect(() => vi.advanceTimersByTime(500)).not.toThrow();
		});
	});

	describe("incremental snapshot patches", () =>
	{
		it("patches every kind of write into the same rows, in the same order, as a full rebuild", () =>
		{
			const db = setup();
			loadTreeRows(db, null);
			expect(peekTreeSnapshotBuild(db)).toBe("full");
			const writes: [step: string, write: () => unknown][] = [
				[
					"rename",
					() =>
					{
						rewriteContent(
							db,
							"a",
							{
								name: "Alpha #renamed",
							},
						);
					},
				],
				[
					"edit note",
					() =>
					{
						rewriteContent(
							db,
							"a1",
							{
								note: "a note",
							},
						);
					},
				],
				[
					"complete",
					() =>
					{
						rewriteMetadata(
							db,
							"a1",
							{
								completedAt: COMPLETED,
							},
						);
					},
				],
				[
					"reorder",
					() =>
					{
						rewriteMetadata(
							db,
							"a",
							{
								priority: 9,
							},
						);
					},
				],
				[
					"create",
					() =>
					{
						createNode(db, "b", "a1", "Beta");
					},
				],
				[
					"create under the new node",
					() =>
					{
						createNode(db, "b1", "b", "Beta child");
					},
				],
				[
					"create top-level",
					() =>
					{
						createNode(db, "top", null, "Top");
					},
				],
				[
					"move a subtree",
					() =>
					{
						rewriteContent(
							db,
							"a",
							{
								parentId: "other",
							},
						);
					},
				],
				[
					"move under a new node",
					() =>
					{
						rewriteContent(
							db,
							"a1",
							{
								parentId: "top",
							},
						);
					},
				],
				[
					"rename a mirror's original",
					() =>
					{
						rewriteContent(
							db,
							"other",
							{
								name: "Other renamed",
							},
						);
					},
				],
				[
					"unmirror",
					() =>
						db
							.update(mirrors)
							.set(
								{
									systemTo: nextSystemTime(),
								},
							)
							.where(eq(mirrors.mirrorId, "mirror"))
							.run(),
				],
				[
					"mirror again",
					() =>
						db
							.insert(mirrors)
							.values(
								{
									mirrorId: "mirror",
									originalId: "top",
									systemFrom: nextSystemTime(),
									systemTo: FAR_FUTURE_DATE,
								},
							)
							.run(),
				],
				[
					"make a references root",
					() =>
						db
							.insert(referencesRoots)
							.values(
								{
									nodeId: "top",
									systemFrom: nextSystemTime(),
									systemTo: FAR_FUTURE_DATE,
								},
							)
							.run(),
				],
				[
					"end a references root",
					() =>
						db
							.update(referencesRoots)
							.set(
								{
									systemTo: nextSystemTime(),
								},
							)
							.where(eq(referencesRoots.nodeId, "refs"))
							.run(),
				],
				[
					"delete a parent, cutting off its children",
					() =>
					{
						endContent(db, "top");
					},
				],
				[
					"restore the parent",
					() =>
					{
						createNode(db, "top", "root", "Top again");
					},
				],
				[
					"delete a leaf",
					() =>
					{
						endContent(db, "b1");
					},
				],
				[
					"put a node in an AI chat, past the change lookback of its last content write",
					() =>
					{
						systemMs += 60_000;
						db.insert(aiMetadata)
							.values(
								{
									nodeId: "top",
									inChat: 1,
									systemFrom: nextSystemTime(),
									systemTo: FAR_FUTURE_DATE,
								},
							)
							.run();
					},
				],
				[
					"move a subtree under the AI chat node",
					() =>
					{
						rewriteContent(
							db,
							"other",
							{
								parentId: "top",
							},
						);
					},
				],
				[
					"create under the AI chat node",
					() =>
					{
						createNode(db, "chat-child", "top", "Chat child");
					},
				],
				[
					"take the node out of the AI chat",
					() =>
					{
						systemMs += 60_000;
						db.update(aiMetadata)
							.set(
								{
									systemTo: nextSystemTime(),
								},
							)
							.where(eq(aiMetadata.nodeId, "top"))
							.run();
					},
				],
			];
			for (const [step, write] of writes)
			{
				write();
				expect(
					{
						step,
						rows: loadTreeRows(db, null),
					},
				).toStrictEqual(
					{
						step,
						rows: loadTreeSearchRows(db, null),
					},
				);
				expect(
					{
						step,
						build: peekTreeSnapshotBuild(db),
					},
				).toStrictEqual(
					{
						step,
						build: "patch",
					},
				);
				for (const rootId of ["root", "a", "top", "other"])
				{
					expect(
						{
							step,
							rootId,
							rows: idSet(loadTreeRows(db, rootId)),
						},
					).toStrictEqual(
						{
							step,
							rootId,
							rows: idSet(loadTreeSearchRows(db, rootId)),
						},
					);
				}
			}
		});

		it("keeps the rows array when a write changes nothing the snapshot holds", () =>
		{
			const db = setup();
			const first = loadTreeRows(db, null);
			rewriteMetadata(db, "a", {});
			expect(loadTreeRows(db, null)).toBe(first);
			expect(peekTreeSnapshotBuild(db)).toBe("patch");
		});

		it("falls back to a full rebuild when a write burst changes too many rows", () =>
		{
			const db = setup();
			loadTreeRows(db, null);
			db.$client.transaction(() =>
			{
				for (let index = 0; index < 1001; index++)
				{
					createNode(db, `bulk-${index}`, "root", `Bulk ${index}`);
				}
			})();
			expect(loadTreeRows(db, null)).toStrictEqual(loadTreeSearchRows(db, null));
			expect(peekTreeSnapshotBuild(db)).toBe("full");
		});
	});

	describe("backlink search", () =>
	{
		/** root > refs (references root) > bl, a backlink item mirroring "a" ("Alpha"). */
		function setupWithBacklink()
		{
			const db = setup();
			db.insert(mirrors)
				.values(
					{
						mirrorId: "bl",
						originalId: "a",
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			return db;
		}

		it("is:backlink matches the backlink item as a meta match and reveals the references root as an ancestor", () =>
		{
			const db = setupWithBacklink();

			const result = computeTreeSearch(loadTreeRowsWithBacklinks(db, "root"), "root", "is:backlink", 0);

			expect(
				{
					matchIds: result.matchIds,
					metaMatchIds: result.metaMatchIds,
					ancestorIds: result.ancestorIds,
				},
			).toStrictEqual(
				{
					matchIds: ["bl"],
					metaMatchIds: ["bl"],
					ancestorIds: ["refs"],
				},
			);
		});

		it('in:backlink:"Alp" matches the backlink item by its source text, not the source itself', () =>
		{
			const db = setupWithBacklink();

			const result = computeTreeSearch(loadTreeRowsWithBacklinks(db, "root"), "root", 'in:backlink:"Alp"', 0);

			expect(
				{
					matchIds: result.matchIds,
					nameMatchIds: result.nameMatchIds,
				},
			).toStrictEqual(
				{
					matchIds: ["bl"],
					nameMatchIds: ["bl"],
				},
			);
		});

		it("a plain query never returns the backlink item", () =>
		{
			const db = setupWithBacklink();

			const result = computeTreeSearch(loadTreeRows(db, "root"), "root", "Alpha", 0);

			expect(result.matchIds).toStrictEqual(["a", "a1"]);
		});

		it("only queries naming a backlink operator load backlink rows", () =>
		{
			expect([
				queryNeedsBacklinks("Alpha"),
				queryNeedsBacklinks("x is:backlink"),
				queryNeedsBacklinks('in:backlink:"a"'),
			]).toStrictEqual([false, true, true]);
		});
	});
});

describe("search tree", () =>
{
	const NOW = Date.UTC(2026, 9, 19, 12);

	function row(
		id: string,
		parentId: string | null,
		priority: number,
		name: string,
		overrides: Partial<TreeSearchRow> = {},
	): TreeSearchRow
	{
		return {
			id,
			parentId,
			priority,
			name,
			note: null,
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
			layoutMode: null,
			isMirror: false,
			isBacklink: false,
			fileType: null,
			...overrides,
		};
	}

	// SF root > [Fruit apple (note) > [Green apple pie, Banana split, Cherry tart > deep apple leaf],
	// Vegetables > [Carrot zebra, Potato], Done apple item (completed), Plain item #fruitTag]
	// Rows are deliberately out of document order to prove the result is ordered by parent then priority.
	const ROWS: TreeSearchRow[] = [
		row("plain", "root", 3, "Plain item #fruitTag"),
		row("veg", "root", 1, "Vegetables"),
		row("root", "outside", 0, "SF root"),
		row("deep", "cherry", 0, "deep apple leaf"),
		row(
			"fruit",
			"root",
			0,
			"Fruit apple",
			{
				note: "zebra note here",
			},
		),
		row(
			"done",
			"root",
			2,
			"Done apple item",
			{
				completedAt: NOW - 1000,
			},
		),
		row("cherry", "fruit", 2, "Cherry tart"),
		row("banana", "fruit", 1, "Banana split"),
		row("green", "fruit", 0, "Green apple pie"),
		row("potato", "veg", 1, "Potato"),
		row("carrot", "veg", 0, "Carrot zebra"),
		row("outsider", "outside", 1, "apple outside the zoom"),
	];

	const EMPTY =
	{
		matchIds: [],
		nameMatchIds: [],
		noteMatchIds: [],
		metaMatchIds: [],
		ancestorIds: [],
		halfExpandedIds: [],
		rootHalfExpanded: false,
		completedMatchCount: 0,
		matchCount: 0,
		revealsCompleted: false,
	};

	describe("computeTreeSearch", () =>
	{
		it("apple matches names in document order with ancestors and half-expanded rows", () =>
		{
			expect(computeTreeSearch(ROWS, "root", "apple", NOW)).toStrictEqual(
				{
					matchIds: ["fruit", "green", "deep", "done"],
					nameMatchIds: ["fruit", "green", "deep", "done"],
					noteMatchIds: [],
					metaMatchIds: [],
					ancestorIds: ["fruit", "cherry"],
					halfExpandedIds: ["fruit"],
					rootHalfExpanded: true,
					completedMatchCount: 1,
					matchCount: 4,
					revealsCompleted: false,
				},
			);
		});

		it("zebra matches a note and a name", () =>
		{
			expect(computeTreeSearch(ROWS, "root", "zebra", NOW)).toStrictEqual(
				{
					matchIds: ["fruit", "carrot"],
					nameMatchIds: ["carrot"],
					noteMatchIds: ["fruit"],
					metaMatchIds: [],
					ancestorIds: ["veg"],
					halfExpandedIds: ["veg"],
					rootHalfExpanded: true,
					completedMatchCount: 0,
					matchCount: 2,
					revealsCompleted: false,
				},
			);
		});

		it("never matches the root itself", () =>
		{
			expect(computeTreeSearch(ROWS, "root", "sf", NOW)).toStrictEqual(EMPTY);
		});

		it("requires whole words before the last token", () =>
		{
			expect(computeTreeSearch(ROWS, "root", "app pie", NOW)).toStrictEqual(EMPTY);
		});

		it("does not match HTML markup", () =>
		{
			const rows = [row("root", null, 0, "root"), row("red", "root", 0, '<span class="colored c-red">x</span>')];
			expect(computeTreeSearch(rows, "root", "span", NOW)).toStrictEqual(EMPTY);
		});

		it("has:note is an operator-only meta match", () =>
		{
			expect(computeTreeSearch(ROWS, "root", "has:note", NOW)).toStrictEqual(
				{
					...EMPTY,
					matchIds: ["fruit"],
					metaMatchIds: ["fruit"],
					rootHalfExpanded: true,
					matchCount: 1,
				},
			);
		});

		it("has:image and has:file match rows by their live attachment's mime type", () =>
		{
			const rows = [
				row("root", null, 0, "root"),
				row(
					"png",
					"root",
					0,
					"",
					{
						fileType: "image/png",
					},
				),
				row(
					"pdf",
					"root",
					1,
					"",
					{
						fileType: "application/pdf",
					},
				),
				row("none", "root", 2, "plain"),
			];
			expect([
				computeTreeSearch(rows, "root", "has:image", NOW).matchIds,
				computeTreeSearch(rows, "root", "has:file", NOW).matchIds,
			]).toStrictEqual([["png"], ["pdf"]]);
		});

		it("is:complete reveals completed and counts matches under a completed ancestor", () =>
		{
			const rows = [
				...ROWS,
				row(
					"done-kid",
					"done",
					0,
					"kid",
					{
						completedAt: NOW - 500,
					},
				),
			];
			expect(computeTreeSearch(rows, "root", "is:complete", NOW)).toStrictEqual(
				{
					...EMPTY,
					matchIds: ["done", "done-kid"],
					metaMatchIds: ["done", "done-kid"],
					ancestorIds: ["done"],
					rootHalfExpanded: true,
					completedMatchCount: 2,
					matchCount: 2,
					revealsCompleted: true,
				},
			);
		});

		it("-is:complete excludes children of a completed node", () =>
		{
			const rows = [
				row("root", null, 0, "root"),
				row(
					"done",
					"root",
					0,
					"done",
					{
						completedAt: NOW,
					},
				),
				row("kid", "done", 0, "kid"),
			];
			expect(computeTreeSearch(rows, "root", "-is:complete", NOW).matchIds).toStrictEqual([]);
		});

		it("searches the whole tree when rootId is null", () =>
		{
			expect(computeTreeSearch(ROWS, null, "outside", NOW)).toStrictEqual(EMPTY);
			const topLevel = [
				row("a", null, 1, "apple top"),
				row("b", null, 0, "banana"),
				row("c", "b", 0, "apple child"),
			];
			expect(computeTreeSearch(topLevel, null, "apple", NOW)).toStrictEqual(
				{
					...EMPTY,
					matchIds: ["c", "a"],
					nameMatchIds: ["c", "a"],
					ancestorIds: ["b"],
					matchCount: 2,
				},
			);
		});

		it("returns the empty result for an empty query", () =>
		{
			expect(computeTreeSearch(ROWS, "root", "   ", NOW)).toStrictEqual(EMPTY);
		});

		it("nested a > b keeps rows under a matching ancestor, including the zoom root and rows above it", () =>
		{
			const nested = [
				row("top", null, 0, "Top"),
				row("parent", "top", 0, "Parent with kids"),
				row("kid", "parent", 0, "kid one"),
				row("stray", "top", 1, "kid stray"),
			];
			expect(
				{
					zoomed: computeTreeSearch(nested, "parent", "parent > kid", NOW).matchIds,
					whole: computeTreeSearch(nested, null, "parent > kid", NOW).matchIds,
					aboveRoot: computeTreeSearch(nested, "parent", "top > kid", NOW).matchIds,
				},
			).toStrictEqual(
				{
					zoomed: ["kid"],
					whole: ["kid"],
					aboveRoot: ["kid"],
				},
			);
		});

		it("uses the account date format for strict date: queries", () =>
		{
			const dated = [
				row(
					"d",
					null,
					0,
					'Meeting <time startYear="2026" startMonth="10" startDay="23">Fri, Oct 23, 2026</time>',
				),
			];
			expect(
				{
					withFormat: computeTreeSearch(
						dated,
						null,
						"date:10/23/2026",
						NOW,
						{
							dateFormat: "MM/DD/YYYY",
						},
					).matchIds,
					withoutFormat: computeTreeSearch(dated, null, "date:10/23/2026", NOW).matchIds,
				},
			).toStrictEqual(
				{
					withFormat: ["d"],
					withoutFormat: [],
				},
			);
		});

		it("places a bare week phrase by the account's week start day", () =>
		{
			const friday = new Date(2026, 9, 23, 12).getTime();
			const sunday = (day: number) =>
				row(`d${day}`, null, 0, `Day <time startYear="2026" startMonth="10" startDay="${day}">Sun</time>`);
			const dated = [sunday(18), sunday(25)];
			expect(
				{
					sundayStart: computeTreeSearch(dated, null, "this week", friday).matchIds,
					mondayStart: computeTreeSearch(
						dated,
						null,
						"this week",
						friday,
						{
							weekStartDay: 1,
						},
					).matchIds,
				},
			).toStrictEqual(
				{
					sundayStart: ["d18"],
					mondayStart: ["d25"],
				},
			);
		});
	});

	describe("computeTreeSearchPaged", () =>
	{
		const PAGE_SIZE = 3;
		// ROWS as a whole tree: the root and the outsider are top-level.
		const WHOLE = ROWS.map((full) =>
			full.id === "root" || full.id === "outsider"
				?
					{
						...full,
						parentId: null,
					}
				: full,
		);
		const skeleton = WHOLE.map((full) => (
		{
			...full,
			name: null,
			note: null,
		}));
		const textById = new Map(
			WHOLE.map(({id, name, note}) => [
				id,
				{
					name,
					note,
				},
			]),
		);

		function paged(
			query: string,
			opts:
			{
				dateFormat?: string;
				weekStartDay?: 0 | 1;
			} = {},
		)
		{
			const requested: string[][] = [];
			const result = computeTreeSearchPaged(
				skeleton,
				query,
				NOW,
				opts,
				{
					pageSize: PAGE_SIZE,
					read: (ids) =>
					{
						requested.push([...ids]);
						return new Map(
							ids.flatMap((id) => (textById.has(id) ? [[id, textById.get(id)!] as const] : [])),
						);
					},
				},
			);
			return {
				result,
				requested,
			};
		}

		it("answers exactly what computeTreeSearch answers over the whole tree with its text", () =>
		{
			const queries = [
				"apple",
				"zebra",
				"has:note",
				"is:complete apple",
				"-is:complete apple",
				"root > apple",
				"fruit > cherry > leaf",
				"#fruitTag",
				"   ",
			];
			expect(queries.map((query) => paged(query).result)).toStrictEqual(
				queries.map((query) => computeTreeSearch(WHOLE, null, query, NOW)),
			);
		});

		it("reads the text one page at a time in tree preorder, each row once", () =>
		{
			const {requested} = paged("root > apple");
			expect(
				{
					largestPage: Math.max(...requested.map((ids) => ids.length)),
					scan: requested.flat(),
				},
			).toStrictEqual(
				{
					largestPage: PAGE_SIZE,
					scan: [
						"root",
						"fruit",
						"green",
						"banana",
						"cherry",
						"deep",
						"veg",
						"carrot",
						"potato",
						"done",
						"plain",
						"outsider",
					],
				},
			);
		});
	});
});
