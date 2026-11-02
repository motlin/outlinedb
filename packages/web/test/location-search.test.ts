import {describe, expect, it} from "vite-plus/test";
import {filterLocations, highlightLabel} from "../src/server/location-search.js";
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
): TreeSearchRow
{
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
	row(
		"done",
		"hub",
		2,
		"Done qzpick",
		{
			completedAt: MODIFIED_MS,
		},
	),
	row("under", "done", 0, "Under qzpick"),
];

function filter(
	query: string,
	options:
	{
		excludeId?: string;
		limit?: number;
		offset?: number;
	} = {},
)
{
	return filterLocations(
		ROWS,
		{
			query,
			...options,
			joinedSec: JOINED_SEC,
			nowSec: NOW_SEC,
		},
	);
}

describe("filterLocations", () =>
{
	it("drops completed nodes, nodes under a completed ancestor and the excluded node", () =>
	{
		const {results, hasMore} = filter(
			"qzpick",
			{
				excludeId: "two",
			},
		);
		expect(
			{
				ids: results.map((result) => result.id),
				hasMore,
			},
		).toStrictEqual(
			{
				ids: ["hub", "one", "deep"],
				hasMore: false,
			},
		);
	});

	it("returns highlighted labels and root-first ancestors", () =>
	{
		const {results} = filter("deep");
		expect(results).toStrictEqual([
			{
				id: "deep",
				labelHtml: "<b><u>Deep</u></b> qzpick",
				ancestors: [
					{
						id: "hub",
						name: "Hub qzpick",
					},
					{
						id: "one",
						name: "One qzpick",
					},
				],
			},
		]);
	});

	it("pages with offset and limit", () =>
	{
		const first = filter(
			"qzpick",
			{
				limit: 2,
			},
		);
		const rest = filter(
			"qzpick",
			{
				limit: 2,
				offset: 2,
			},
		);
		expect(
			{
				firstCount: first.results.length,
				firstHasMore: first.hasMore,
				restCount: rest.results.length,
				restHasMore: rest.hasMore,
			},
		).toStrictEqual(
			{
				firstCount: 2,
				firstHasMore: true,
				restCount: 2,
				restHasMore: false,
			},
		);
	});

	it("returns nothing for an empty query", () =>
	{
		expect(filter("  ")).toStrictEqual(
			{
				results: [],
				hasMore: false,
			},
		);
	});
});

describe("highlightLabel", () =>
{
	it("wraps each word-start hit in <b><u>", () =>
	{
		expect(highlightLabel("qz", "Qzpick Two")).toBe("<b><u>Qz</u></b>pick Two");
	});

	it("wraps every matched word", () =>
	{
		expect(highlightLabel("qzpick two", "Qzpick Two")).toBe("<b><u>Qzpick</u></b> <b><u>Two</u></b>");
	});
});

describe("filterLocations star boost and mirrors", () =>
{
	it("multiplies starred pages by 20 and leaves mirrors out (ISR10, ISR2)", () =>
	{
		const rows = [
			row("parent", null, 0, "abc parent"),
			row("a", "parent", 0, "A"),
			row("b", "a", 0, "B"),
			row("c", "b", 0, "C"),
			row("star", "c", 0, "abc star"),
			row(
				"mirror",
				"parent",
				1,
				"abc parent",
				{
					isMirror: true,
				},
			),
		];
		const ids = (starredIds?: string[]) =>
			filterLocations(
				rows,
				{
					query: "abc",
					starredIds,
					joinedSec: JOINED_SEC,
					nowSec: NOW_SEC,
				},
			).results.map((result) => result.id);
		expect(
			{
				boosted: ids(["star"]),
				plain: ids(),
			},
		).toStrictEqual(
			{
				boosted: ["star", "parent"],
				plain: ["parent", "star"],
			},
		);
	});
});
