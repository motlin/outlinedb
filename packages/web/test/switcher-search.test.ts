import {describe, expect, it} from "vite-plus/test";
import {
	compactSwitcherSkeleton,
	peekSwitcherText,
	rankSwitcher,
	rankSwitcherCompact,
	rankSwitcherPaged,
	scanFragment,
	warmSwitcher,
} from "../src/server/switcher-search.js";
import type {TreeSearchRow} from "../src/server/tree-search.js";

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

// The jump-menu sandbox fixture (dumps/jump-menu-live-results.txt):
// 🧪 Sync sandbox > Qwzx parent page > [Qwzx alpha leaf, Qwzx beta parent > [deep qwzxchild, other],
// Unrelated row (note-only match), Qwzxdone task (completed) > qwzx under done, base64 note node]
const ROWS: TreeSearchRow[] = [
	row("sandbox", null, 0, "🧪 Sync sandbox"),
	row("parent", "sandbox", 0, "Qwzx parent page"),
	row("alpha", "parent", 0, "Qwzx alpha leaf"),
	row("beta", "parent", 1, "Qwzx beta parent"),
	row("deep", "beta", 0, "deep qwzxchild"),
	row("other", "beta", 1, "other"),
	row("unrelated", "parent", 2, "Unrelated row", {note: "qwzx in note only"}),
	row("done", "parent", 3, "Qwzxdone task", {completedAt: MODIFIED_MS}),
	row("underDone", "done", 0, "qwzx under done"),
	row("base64", "sandbox", 1, "Attachment", {note: "aGVsbG8+QwzpYXI/parZm9vqwzxbar"}),
];

function rank(query: string, options: {limit?: number; offset?: number; starredIds?: string[]} = {}) {
	return rankSwitcher(ROWS, query, options.starredIds ?? [], NOW_SEC, {
		joinedSec: JOINED_SEC,
		limit: options.limit,
		offset: options.offset,
	});
}

describe("rankSwitcher", () => {
	it("ranks the qwzx fixture like upstream, dropping completed subtrees and non-word-start note hits", () => {
		const {results, hasMore} = rank("qwzx");
		expect({names: results.map((result) => result.id), hasMore}).toStrictEqual({
			names: ["parent", "beta", "alpha", "deep", "unrelated"],
			hasMore: false,
		});
	});

	it("answers each result with highlighted label, flags and root-first ancestors without Home", () => {
		const {results} = rank("qwzx");
		expect(results.find((result) => result.id === "deep")).toStrictEqual({
			id: "deep",
			labelHtml: "deep <b><u>qwzx</u></b>child",
			completed: false,
			starred: false,
			ancestors: [
				{id: "sandbox", name: "🧪 Sync sandbox"},
				{id: "parent", name: "Qwzx parent page"},
				{id: "beta", name: "Qwzx beta parent"},
			],
		});
		expect(results.find((result) => result.id === "unrelated")?.labelHtml).toBe("Unrelated row");
	});

	it("pages with offset and limit and reports hasMore", () => {
		expect(rank("qwzx", {limit: 2})).toStrictEqual({
			results: [expect.objectContaining({id: "parent"}), expect.objectContaining({id: "beta"})],
			hasMore: true,
		});
		const page = rank("qwzx", {offset: 4, limit: 2});
		expect({ids: page.results.map((result) => result.id), hasMore: page.hasMore}).toStrictEqual({
			ids: ["unrelated"],
			hasMore: false,
		});
	});

	it("multiplies a starred node's score by 20 and flags it", () => {
		const {results} = rank("qwzx", {starredIds: ["deep"]});
		expect(results.slice(0, 2).map((result) => [result.id, result.starred])).toStrictEqual([
			["deep", true],
			["parent", false],
		]);
	});

	it("requires every query word at a word start (AND, order-free)", () => {
		expect(rank("par qwz").results.map((result) => result.id)).toStrictEqual(["parent", "beta", "base64"]);
	});

	it("keeps a nested a > b result only when its ancestors match the earlier segments in order", () => {
		const ids = (query: string) => rank(query).results.map((result) => result.id);
		expect({
			one: ids("beta > qwzx"),
			two: ids("parent > beta > qwzx"),
			wrongOrder: ids("beta > parent > qwzx"),
			leaf: ids("alpha > qwzx"),
			label: rank("beta > qwzx").results[0]?.labelHtml,
		}).toStrictEqual({
			one: ["deep"],
			two: ["deep"],
			wrongOrder: [],
			leaf: [],
			label: "deep <b><u>qwzx</u></b>child",
		});
	});

	it("answers nothing for a query without words", () => {
		expect(rank("  ..  ")).toStrictEqual({results: [], hasMore: false});
	});

	it("finds accented and word-start matches through the folded prefilter and pages past word-start misses", () => {
		const rows = [
			row("cafe", null, 0, "Café <b>Crème</b>"),
			row("inside", null, 1, "Sucrèmerie"),
			row("tagged", null, 2, "Plain", {note: "crème brûlée #dessert"}),
		];
		const ranked = rankSwitcher(rows, "creme", [], NOW_SEC, {joinedSec: JOINED_SEC, limit: 1});
		expect({ids: ranked.results.map((result) => result.id), hasMore: ranked.hasMore}).toStrictEqual({
			ids: ["cafe"],
			hasMore: true,
		});
		const all = rankSwitcher(rows, "creme", [], NOW_SEC, {joinedSec: JOINED_SEC, limit: 2});
		expect({ids: all.results.map((result) => result.id), hasMore: all.hasMore}).toStrictEqual({
			ids: ["cafe", "tagged"],
			hasMore: false,
		});
	});
});

describe("warmSwitcher", () => {
	it("precomputes each row's stripped and folded text, so the first jump-menu keystroke does no per-row work", () => {
		const rows = [row("warm", null, 0, "<b>Alpha</b> Page", {note: "Beta Note"})];
		expect(peekSwitcherText(rows[0])).toBeUndefined();
		warmSwitcher(rows);
		expect(peekSwitcherText(rows[0])).toStrictEqual({
			plainName: "Alpha Page",
			plainNote: "Beta Note",
			foldedName: "alpha page",
			foldedNote: "beta note",
			asciiName: true,
			asciiNote: true,
			index: {indexName: "alpha page", indexNote: "beta note"},
			fields: ["alpha page", "<b>alpha</b> page", "beta note"],
		});
	});
});

function rankedIds(rows: TreeSearchRow[], query: string, options: {showCompleted?: boolean} = {}): string[] {
	return rankSwitcher(rows, query, [], NOW_SEC, {joinedSec: JOINED_SEC, ...options}).results.map(({id}) => id);
}

describe("rankSwitcher against upstream's worker (inline-search-ranking)", () => {
	it("ranks a weak name hit above a note-only hit with every static boost (ISR1)", () => {
		const old = Date.UTC(2020, 0, 1);
		const rows = [
			row("hub", null, 0, "Hub"),
			row("Nstar", "hub", 0, "Unrelated", {note: "zqrk in note", layoutMode: "h1"}),
			...Array.from({length: 10}, (_, i) => row(`kid${i}`, "Nstar", i, "kid")),
			row("d1", "hub", 1, "d1"),
			row("d2", "d1", 0, "d2"),
			row("d3", "d2", 0, "d3"),
			row("Lweak", "d3", 0, "zqrk ".padEnd(58, "x"), {modifiedAt: old}),
		];
		const ranked = rankSwitcher(rows, "zqrk", ["Nstar"], NOW_SEC, {joinedSec: JOINED_SEC});
		expect(ranked.results.map(({id}) => id)).toStrictEqual(["Lweak", "Nstar"]);
	});

	it("keeps a note's tag from lifting a name hit past a bolder sibling (ISR1)", () => {
		const rows = [
			row("hub", null, 0, "Hub"),
			row("leaf", "hub", 0, "zqrk leaf"),
			row("plain", "hub", 1, "zqrk plain", {note: "has #notetag"}),
			row("deep", "hub", 2, "zqrk deepest"),
		];
		expect(rankedIds(rows, "zqrk")).toStrictEqual(["leaf", "plain", "deep"]);
	});

	it("leaves mirrors out of the ranking (ISR2)", () => {
		const rows = [
			row("hub", null, 0, "Hub"),
			row("leaf", "hub", 0, "zqrk leaf"),
			row("m", "hub", 1, "zqrk leaf", {isMirror: true}),
		];
		expect(rankedIds(rows, "zqrk")).toStrictEqual(["leaf"]);
	});

	it("counts a top-level row at depth 2 (ISR4)", () => {
		const rows = [
			row("top", null, 0, "abc one", {modifiedAt: MODIFIED_MS}),
			row("hub", null, 1, "Hub"),
			row("mid", "hub", 0, "Mid"),
			row("deep", "mid", 0, "abc one", {modifiedAt: MODIFIED_MS}),
		];
		// Both are leaves of equal text: only the depth factor differs, 1/1.2 against 1/1.4.
		const results = rankSwitcher(rows, "abc", [], NOW_SEC, {joinedSec: JOINED_SEC}).results;
		expect(results.map(({id}) => id)).toStrictEqual(["top", "deep"]);
	});

	it("measures lengths on the folded index text (ISR5, ISR11)", () => {
		const hangul = "abc \uD55C\uAD6D\uC5B4";
		const rows = [
			row("hub", null, 0, "Hub"),
			row("K", "hub", 0, hangul),
			row("L", "hub", 1, "abc xyz"),
			row("M", "hub", 2, "abc xyzwvut"),
			row("V", "hub", 3, "\u2714\uFE0F abc xy"),
			row("W", "hub", 4, "abc xyzw"),
			row("H", "hub", 5, "abc   "),
			row("I", "hub", 6, "abc x"),
		];
		expect(rankedIds(rows, "abc")).toStrictEqual(["I", "H", "L", "V", "W", "M", "K"]);
	});

	it("breaks ties in the trie gather order: exact word, digits first, then insertion order (ISR12)", () => {
		const rows = [
			row("hub", null, 0, "Hub"),
			...["abcz x", "abc9 x", "abca x", "abc1 x", "abc_ x"].map((name, i) => row(`n${i}`, "hub", i, name)),
		];
		const byName = new Map(rows.map((r) => [r.id, r.name]));
		expect(rankedIds(rows, "abc").map((id) => byName.get(id))).toStrictEqual([
			"abc_ x",
			"abc1 x",
			"abc9 x",
			"abcz x",
			"abca x",
		]);
	});

	it("breaks identical-name ties by tree preorder, not id (ISR12)", () => {
		const rows = [
			row("p1", null, 0, "P1"),
			row("p2", null, 1, "P2"),
			row("y1", "p2", 0, "abc k"),
			row("z1", "p1", 0, "abc k"),
		];
		expect(rankedIds(rows, "abc")).toStrictEqual(["z1", "y1"]);
	});

	it("orders note-only hits by tree order and after every name hit (ISR12)", () => {
		const rows = [
			row("hub", null, 0, "Hub"),
			row("one", "hub", 0, "other one", {note: "zqrk in note"}),
			row("two", "hub", 1, "other two", {note: "zqrk short"}),
			row("name", "hub", 2, "zqrk name"),
		];
		expect(rankedIds(rows, "zqrk")).toStrictEqual(["name", "one", "two"]);
	});

	it("keeps completed and under-completed rows with show-completed, flagged and scored at factor 1 (ISR8)", () => {
		const shown = rankSwitcher(ROWS, "qwzx", [], NOW_SEC, {joinedSec: JOINED_SEC, showCompleted: true});
		expect(shown.results.map(({id, completed}) => [id, completed])).toStrictEqual([
			["parent", false],
			["beta", false],
			["done", true],
			["alpha", false],
			["deep", false],
			["underDone", true],
			["unrelated", false],
		]);
		expect(rankedIds(ROWS, "qwzx")).not.toContain("done");
	});

	it("answers a quoted phrase in tree order with one phrase highlight, mirrors included (ISR6)", () => {
		const rows = [
			row("hub", null, 0, "Hub"),
			row("lvl1", "hub", 0, "lvl1"),
			row("leaf", "hub", 1, "zqrk leaf"),
			row("m", "lvl1", 0, "zqrk leaf", {isMirror: true}),
			row("other", "hub", 2, "zqrk other"),
		];
		const {results} = rankSwitcher(rows, '"zqrk leaf"', [], NOW_SEC, {joinedSec: JOINED_SEC});
		expect(results.map(({id, labelHtml}) => [id, labelHtml])).toStrictEqual([
			["m", "<b><u>zqrk leaf</u></b>"],
			["leaf", "<b><u>zqrk leaf</u></b>"],
		]);
	});

	it("answers an emoji query with no rows (ISR6)", () => {
		expect(rankedIds([row("a", null, 0, "zqrk note")], "zqrk \u{1F600}")).toStrictEqual([]);
	});

	it("answers a date phrase with the rows whose time pill is that day, in tree order (ISR6)", () => {
		const rows = [
			row("hub", null, 0, "Hub"),
			row("due", "hub", 0, 'due <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>'),
			row("later", "hub", 1, 'due <time startYear="2026" startMonth="10" startDay="9">Fri, Oct 9, 2026</time>'),
			row("text", "hub", 2, "today is literal text"),
		];
		expect(rankedIds(rows, "Oct 1, 2026")).toStrictEqual(["due"]);
	});
});

describe("rankSwitcherPaged", () => {
	const PAGE_SIZE = 3;
	const DATED_ROWS = [
		...ROWS,
		row(
			"due",
			"sandbox",
			2,
			'qwzx due <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>',
		),
		row("mirror", "beta", 2, "qwzx alpha leaf", {isMirror: true}),
	];
	const skeleton = DATED_ROWS.map((full) => ({...full, name: null, note: null}));
	const textById = new Map(DATED_ROWS.map(({id, name, note}) => [id, {name, note}]));

	function paged(query: string, options: {showCompleted?: boolean; limit?: number} = {}) {
		const requested: string[][] = [];
		const response = rankSwitcherPaged(
			skeleton,
			query,
			["beta"],
			NOW_SEC,
			{joinedSec: JOINED_SEC, ...options},
			{
				pageSize: PAGE_SIZE,
				read: (ids) => {
					requested.push([...ids]);
					return new Map(ids.flatMap((id) => (textById.has(id) ? [[id, textById.get(id)!] as const] : [])));
				},
			},
		);
		return {response, requested};
	}

	it("answers exactly what rankSwitcher answers over the rows with their text, for every query kind", () => {
		const queries: [string, {showCompleted?: boolean; limit?: number}][] = [
			["qwzx", {}],
			["qwzx", {limit: 2}],
			["qwzx", {showCompleted: true}],
			["par qwz", {}],
			["parent > beta > qwzx", {}],
			['"qwzx alpha"', {}],
			["Oct 1, 2026", {}],
			["nothingmatches", {}],
		];
		expect(queries.map(([query, options]) => paged(query, options).response)).toStrictEqual(
			queries.map(([query, options]) =>
				rankSwitcher(DATED_ROWS, query, ["beta"], NOW_SEC, {joinedSec: JOINED_SEC, ...options}),
			),
		);
	});

	it("reads the text one page at a time in tree preorder, never every row's text at once", () => {
		const {requested} = paged("parent > beta > qwzx");
		expect({
			largestPage: Math.max(...requested.map((ids) => ids.length)),
			scan: requested.flat().slice(0, skeleton.length),
		}).toStrictEqual({
			largestPage: PAGE_SIZE,
			scan: [
				"sandbox",
				"parent",
				"alpha",
				"beta",
				"deep",
				"other",
				"mirror",
				"unrelated",
				"done",
				"underDone",
				"base64",
				"due",
			],
		});
	});
});

describe("rankSwitcherCompact", () => {
	const ROWS_WITH_TEXT = [
		...ROWS,
		row("mirror", "beta", 2, "qwzx alpha leaf", {isMirror: true}),
		row("accent", "sandbox", 2, "Qwzx \u00E9t\u00E9 plans", {layoutMode: "h1"}),
		row("tagged", "sandbox", 3, "qw<b>zx</b> bold", {createdAt: Date.UTC(2017, 0, 1)}),
	];
	const skeleton = compactSwitcherSkeleton(ROWS_WITH_TEXT.map((full) => ({...full, name: null, note: null})));
	const textById = new Map(ROWS_WITH_TEXT.map(({id, name, note}) => [id, {name, note}]));

	function compact(query: string, options: {showCompleted?: boolean; limit?: number; excludeId?: string} = {}) {
		const fragments: (string | null)[] = [];
		const response = rankSwitcherCompact(
			skeleton,
			query,
			["beta"],
			NOW_SEC,
			{joinedSec: JOINED_SEC, ...options},
			(fragment) => {
				fragments.push(fragment);
				// Like the SQL prefilter: an ASCII LIKE on the raw text, plus every row holding a tag or non-ASCII text.
				const matching = ROWS_WITH_TEXT.filter(
					({name, note}) =>
						fragment === null ||
						[name, note].some(
							(text) =>
								text !== null &&
								(text.toLowerCase().includes(fragment) ||
									text.includes("<") ||
									!/^\p{ASCII}*$/u.test(text)),
						),
				);
				// Out of tree order, as SQL answers them.
				return matching.flatMap((_, i) => matching.slice(matching.length - 1 - i, matching.length - i));
			},
			{
				pageSize: 2,
				read: (ids) =>
					new Map(ids.flatMap((id) => (textById.has(id) ? [[id, textById.get(id)!] as const] : []))),
			},
		);
		return {response, fragments};
	}

	it("answers exactly what rankSwitcher answers over the rows with their text", () => {
		const queries: [string, {showCompleted?: boolean; limit?: number; excludeId?: string}][] = [
			["qwzx", {}],
			["qwzx", {limit: 2}],
			["qwzx", {showCompleted: true}],
			["qwzx", {excludeId: "alpha"}],
			["par qwz", {}],
			["ete", {}],
			["QWZX bold", {}],
			["nothingmatches", {}],
		];
		expect(queries.map(([query, options]) => compact(query, options).response)).toStrictEqual(
			queries.map(([query, options]) =>
				rankSwitcher(ROWS_WITH_TEXT, query, ["beta"], NOW_SEC, {joinedSec: JOINED_SEC, ...options}),
			),
		);
	});

	it("scans with the folded longest word as the prefilter fragment", () => {
		expect(["par QWZX", "\u00E9t\u00E9", "\u00DF"].map((query) => compact(query).fragments)).toStrictEqual([
			["qwzx"],
			["ete"],
			[null],
		]);
	});

	it("keeps the earliest creation time for the joined-at fallback", () => {
		expect(skeleton.earliestCreatedMs).toBe(Date.UTC(2017, 0, 1));
	});
});

describe("scanFragment", () => {
	it("is the longest word when it is plain ASCII letters, digits, # or @, and null otherwise", () => {
		expect(["te", "#tag", "@pat", "x1", "\u00DF", "\u0131"].map(scanFragment)).toStrictEqual([
			"te",
			"#tag",
			"@pat",
			"x1",
			null,
			null,
		]);
	});
});
