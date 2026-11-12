import {describe, expect, it} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import type {TreeSearchResult} from "../src/server/tree-search.js";
import {searchFilter} from "../src/client/search-filter.js";
import {focusableSiblingIds} from "../src/client/render-window.js";

function node(id: string, priority: number, completed = false): NodeResponse
{
	return {
		id,
		parent_id: "z",
		name: id,
		note: null,
		priority,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: completed ? 1 : null,
	};
}

function result(matchIds: string[]): TreeSearchResult
{
	return {
		matchIds,
		nameMatchIds: matchIds,
		noteMatchIds: [],
		metaMatchIds: [],
		ancestorIds: [],
		halfExpandedIds: [],
		rootHalfExpanded: false,
		completedMatchCount: 0,
		matchCount: matchIds.length,
		revealsCompleted: false,
	};
}

// Siblings deliberately out of priority order.
const siblings = [node("Echo", 3), node("Charlie", 1), node("Filler05", 4), node("Delta", 2, true)];
const none = new Set<string>();

describe("focusableSiblingIds", () =>
{
	it("keeps only the siblings a search shows, in priority order", () =>
	{
		const search = searchFilter(result(["Charlie", "Filler05"]), none, new Map());
		expect(
			focusableSiblingIds(
				siblings,
				{
					showCompleted: false,
					animatingCompletionIds: none,
					search,
				},
			),
		).toStrictEqual(["Charlie", "Filler05"]);
	});

	it("drops a hidden completed sibling when no search is applied", () =>
	{
		expect(
			focusableSiblingIds(
				siblings,
				{
					showCompleted: false,
					animatingCompletionIds: none,
					search: null,
				},
			),
		).toStrictEqual(["Charlie", "Echo", "Filler05"]);
	});

	it("keeps completed siblings when completed rows are shown", () =>
	{
		expect(
			focusableSiblingIds(
				siblings,
				{
					showCompleted: true,
					animatingCompletionIds: none,
					search: null,
				},
			),
		).toStrictEqual(["Charlie", "Delta", "Echo", "Filler05"]);
	});

	it("is empty for an unloaded list", () =>
	{
		expect(
			focusableSiblingIds(
				undefined,
				{
					showCompleted: true,
					animatingCompletionIds: none,
					search: null,
				},
			),
		).toStrictEqual([]);
	});
});
