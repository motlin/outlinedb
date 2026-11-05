import {describe, expect, it} from "vite-plus/test";
import {computeTreeSearch, computeTreeSearchPaged} from "../src/server/tree-search.js";
import type {TreeSearchRow} from "../src/server/tree-search.js";

const NOW = Date.UTC(2026, 9, 19, 12);

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
	row("fruit", "root", 0, "Fruit apple", {note: "zebra note here"}),
	row("done", "root", 2, "Done apple item", {completedAt: NOW - 1000}),
	row("cherry", "fruit", 2, "Cherry tart"),
	row("banana", "fruit", 1, "Banana split"),
	row("green", "fruit", 0, "Green apple pie"),
	row("potato", "veg", 1, "Potato"),
	row("carrot", "veg", 0, "Carrot zebra"),
	row("outsider", "outside", 1, "apple outside the zoom"),
];

const EMPTY = {
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

describe("computeTreeSearch", () => {
	it("apple matches names in document order with ancestors and half-expanded rows", () => {
		expect(computeTreeSearch(ROWS, "root", "apple", NOW)).toStrictEqual({
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
		});
	});

	it("zebra matches a note and a name", () => {
		expect(computeTreeSearch(ROWS, "root", "zebra", NOW)).toStrictEqual({
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
		});
	});

	it("never matches the root itself", () => {
		expect(computeTreeSearch(ROWS, "root", "sf", NOW)).toStrictEqual(EMPTY);
	});

	it("requires whole words before the last token", () => {
		expect(computeTreeSearch(ROWS, "root", "app pie", NOW)).toStrictEqual(EMPTY);
	});

	it("does not match HTML markup", () => {
		const rows = [row("root", null, 0, "root"), row("red", "root", 0, '<span class="colored c-red">x</span>')];
		expect(computeTreeSearch(rows, "root", "span", NOW)).toStrictEqual(EMPTY);
	});

	it("has:note is an operator-only meta match", () => {
		expect(computeTreeSearch(ROWS, "root", "has:note", NOW)).toStrictEqual({
			...EMPTY,
			matchIds: ["fruit"],
			metaMatchIds: ["fruit"],
			rootHalfExpanded: true,
			matchCount: 1,
		});
	});

	it("has:image and has:file match rows by their live attachment's mime type", () => {
		const rows = [
			row("root", null, 0, "root"),
			row("png", "root", 0, "", {fileType: "image/png"}),
			row("pdf", "root", 1, "", {fileType: "application/pdf"}),
			row("none", "root", 2, "plain"),
		];
		expect([
			computeTreeSearch(rows, "root", "has:image", NOW).matchIds,
			computeTreeSearch(rows, "root", "has:file", NOW).matchIds,
		]).toStrictEqual([["png"], ["pdf"]]);
	});

	it("is:complete reveals completed and counts matches under a completed ancestor", () => {
		const rows = [...ROWS, row("done-kid", "done", 0, "kid", {completedAt: NOW - 500})];
		expect(computeTreeSearch(rows, "root", "is:complete", NOW)).toStrictEqual({
			...EMPTY,
			matchIds: ["done", "done-kid"],
			metaMatchIds: ["done", "done-kid"],
			ancestorIds: ["done"],
			rootHalfExpanded: true,
			completedMatchCount: 2,
			matchCount: 2,
			revealsCompleted: true,
		});
	});

	it("-is:complete excludes children of a completed node", () => {
		const rows = [
			row("root", null, 0, "root"),
			row("done", "root", 0, "done", {completedAt: NOW}),
			row("kid", "done", 0, "kid"),
		];
		expect(computeTreeSearch(rows, "root", "-is:complete", NOW).matchIds).toStrictEqual([]);
	});

	it("searches the whole tree when rootId is null", () => {
		expect(computeTreeSearch(ROWS, null, "outside", NOW)).toStrictEqual(EMPTY);
		const topLevel = [row("a", null, 1, "apple top"), row("b", null, 0, "banana"), row("c", "b", 0, "apple child")];
		expect(computeTreeSearch(topLevel, null, "apple", NOW)).toStrictEqual({
			...EMPTY,
			matchIds: ["c", "a"],
			nameMatchIds: ["c", "a"],
			ancestorIds: ["b"],
			matchCount: 2,
		});
	});

	it("returns the empty result for an empty query", () => {
		expect(computeTreeSearch(ROWS, "root", "   ", NOW)).toStrictEqual(EMPTY);
	});

	it("nested a > b keeps rows under a matching ancestor, including the zoom root and rows above it", () => {
		const nested = [
			row("top", null, 0, "Top"),
			row("parent", "top", 0, "Parent with kids"),
			row("kid", "parent", 0, "kid one"),
			row("stray", "top", 1, "kid stray"),
		];
		expect({
			zoomed: computeTreeSearch(nested, "parent", "parent > kid", NOW).matchIds,
			whole: computeTreeSearch(nested, null, "parent > kid", NOW).matchIds,
			aboveRoot: computeTreeSearch(nested, "parent", "top > kid", NOW).matchIds,
		}).toStrictEqual({zoomed: ["kid"], whole: ["kid"], aboveRoot: ["kid"]});
	});

	it("uses the account date format for strict date: queries", () => {
		const dated = [
			row("d", null, 0, 'Meeting <time startYear="2026" startMonth="10" startDay="23">Fri, Oct 23, 2026</time>'),
		];
		expect({
			withFormat: computeTreeSearch(dated, null, "date:10/23/2026", NOW, {dateFormat: "MM/DD/YYYY"}).matchIds,
			withoutFormat: computeTreeSearch(dated, null, "date:10/23/2026", NOW).matchIds,
		}).toStrictEqual({withFormat: ["d"], withoutFormat: []});
	});

	it("places a bare week phrase by the account's week start day", () => {
		const friday = new Date(2026, 9, 23, 12).getTime();
		const sunday = (day: number) =>
			row(`d${day}`, null, 0, `Day <time startYear="2026" startMonth="10" startDay="${day}">Sun</time>`);
		const dated = [sunday(18), sunday(25)];
		expect({
			sundayStart: computeTreeSearch(dated, null, "this week", friday).matchIds,
			mondayStart: computeTreeSearch(dated, null, "this week", friday, {weekStartDay: 1}).matchIds,
		}).toStrictEqual({sundayStart: ["d18"], mondayStart: ["d25"]});
	});
});

describe("computeTreeSearchPaged", () => {
	const PAGE_SIZE = 3;
	// ROWS as a whole tree: the root and the outsider are top-level.
	const WHOLE = ROWS.map((full) => (full.id === "root" || full.id === "outsider" ? {...full, parentId: null} : full));
	const skeleton = WHOLE.map((full) => ({...full, name: null, note: null}));
	const textById = new Map(WHOLE.map(({id, name, note}) => [id, {name, note}]));

	function paged(query: string, opts: {dateFormat?: string; weekStartDay?: 0 | 1} = {}) {
		const requested: string[][] = [];
		const result = computeTreeSearchPaged(skeleton, query, NOW, opts, {
			pageSize: PAGE_SIZE,
			read: (ids) => {
				requested.push([...ids]);
				return new Map(ids.flatMap((id) => (textById.has(id) ? [[id, textById.get(id)!] as const] : [])));
			},
		});
		return {result, requested};
	}

	it("answers exactly what computeTreeSearch answers over the whole tree with its text", () => {
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

	it("reads the text one page at a time in tree preorder, each row once", () => {
		const {requested} = paged("root > apple");
		expect({largestPage: Math.max(...requested.map((ids) => ids.length)), scan: requested.flat()}).toStrictEqual({
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
		});
	});
});
