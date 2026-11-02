import {describe, expect, it} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import type {TreeSearchResult} from "../src/server/tree-search.js";
import {searchFilter} from "../src/client/search-filter.js";
import type {RowView} from "../src/client/render-window.js";
import
{
	firstPaintRowBudget,
	initialRowBudget,
	nextRowBudget,
	rowBudgetToShow,
	rowLimit,
	rowLimits,
	rendersInstanceRow,
	viewParentIds,
} from "../src/client/render-window.js";

function node(id: string, parentId: string | null, completed = false): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: completed ? 1 : null,
	};
}

function result(matchIds: string[], ancestorIds: string[]): TreeSearchResult
{
	return {
		matchIds,
		nameMatchIds: matchIds,
		noteMatchIds: [],
		metaMatchIds: [],
		ancestorIds,
		halfExpandedIds: [],
		rootHalfExpanded: false,
		completedMatchCount: 0,
		matchCount: matchIds.length,
		revealsCompleted: false,
	};
}

// Root holds alice then bob then carol; alice holds dave, erin and a completed frank.
const children = new Map<string | null, NodeResponse[]>([
	[null, [node("alice", null), node("bob", null), node("carol", null)]],
	["alice", [node("dave", "alice"), node("erin", "alice"), node("frank", "alice", true)]],
]);

const outlineView: RowView =
{
	expandedIds: new Set(["alice"]),
	showCompleted: false,
	animatingCompletionIds: new Set(),
	search: null,
};

// The search matches bob, dave, erin and the completed frank; alice is their ancestor, carol does not show.
const searchView: RowView =
{
	...outlineView,
	expandedIds: new Set(),
	search: searchFilter(result(["bob", "dave", "erin", "frank"], ["alice"]), new Set(), new Map()),
};

function limitsFor(view: RowView, budget: number)
{
	const computed = rowLimits((id) => children.get(id), null, budget, view);
	return {
		limits: Object.fromEntries(computed.limits),
		remaining: computed.remaining,
	};
}

describe("rowLimits", () =>
{
	it("hands each parent its rows in document order until the budget runs out", () =>
	{
		expect([10, 3, 2, 1].map((budget) => limitsFor(outlineView, budget))).toStrictEqual([
			{
				limits:
				{
					alice: 2,
					null: 3,
				},
				remaining: 5,
			},
			{
				limits:
				{
					alice: 2,
					null: 1,
				},
				remaining: 0,
			},
			{
				limits:
				{
					alice: 1,
					null: 1,
				},
				remaining: 0,
			},
			{
				limits:
				{
					alice: 0,
					null: 1,
				},
				remaining: 0,
			},
		]);
	});

	it("takes rows and expansion from the search during a search", () =>
	{
		expect([10, 3].map((budget) => limitsFor(searchView, budget))).toStrictEqual([
			{
				limits:
				{
					alice: 2,
					null: 2,
				},
				remaining: 6,
			},
			{
				limits:
				{
					alice: 2,
					null: 1,
				},
				remaining: 0,
			},
		]);
	});

	it("gives an expanded parent whose children are not loaded yet the remaining budget", () =>
	{
		const rootOnly = rowLimits((id) => (id === null ? children.get(null) : undefined), null, 10, outlineView);
		const exhausted = rowLimits(() => {}, null, 0, outlineView);
		expect(
			{
				limits: Object.fromEntries(rootOnly.limits),
				alice: rowLimit(rootOnly, "alice"),
				exhausted: rowLimit(exhausted, "alice"),
			},
		).toStrictEqual(
			{
				limits:
				{
					null: 3,
				},
				alice: 7,
				exhausted: 0,
			},
		);
	});

	it("bounds a search with thousands of matches to the budget", () =>
	{
		const many = Array.from(
			{
				length: 5000,
			},
			(_, index) => node(`m${index}`, null),
		);
		const wide: RowView =
		{
			...outlineView,
			search: searchFilter(
				result(
					many.map((item) => item.id),
					[],
				),
				new Set(),
				new Map(),
			),
		};
		const computed = rowLimits(() => many, null, initialRowBudget(900), wide);
		expect(
			{
				root: rowLimit(computed, null),
				remaining: computed.remaining,
			},
		).toStrictEqual(
			{
				root: 62,
				remaining: 0,
			},
		);
	});
});

describe("row budget", () =>
{
	it("starts at a viewport of 24px rows plus one 24-row step, like upstream useMaxToRender, and grows a step at a time", () =>
	{
		expect([initialRowBudget(900), initialRowBudget(0), nextRowBudget(62)]).toStrictEqual([62, 24, 86]);
	});

	it("paints a new view with a viewport of 24px rows, leaving the step of slack below the fold for after the paint", () =>
	{
		expect([firstPaintRowBudget(900), firstPaintRowBudget(0)]).toStrictEqual([38, 24]);
	});
});

describe("rowBudgetToShow", () =>
{
	const budgetFor = (budget: number, targetId: string, view: RowView = outlineView) =>
		rowBudgetToShow((id) => children.get(id), null, budget, view, targetId);

	it("grows the budget a step at a time until a keyboard move's target row renders, and leaves it otherwise", () =>
	{
		// Document order: alice, dave, erin, bob, carol; carol is the fifth row.
		expect([
			budgetFor(2, "carol"),
			budgetFor(5, "carol"),
			budgetFor(2, "dave"),
			budgetFor(2, "frank"),
			budgetFor(2, "nobody"),
			budgetFor(1, "bob", searchView),
		]).toStrictEqual([26, 5, 2, 2, 2, 25]);
	});
});

describe("viewParentIds", () =>
{
	it("lists the root and every expanded rendered row the budget reaches, in document order", () =>
	{
		const view =
		{
			...outlineView,
			expandedIds: new Set(["alice", "bob", "dave"]),
		};
		expect(viewParentIds((id) => children.get(id) ?? [], null, 100, view)).toStrictEqual([
			null,
			"alice",
			"dave",
			"bob",
		]);
	});

	it("stops at the budget and is undefined while a reached parent's children have not loaded", () =>
	{
		const view =
		{
			...outlineView,
			expandedIds: new Set(["alice", "bob"]),
		};
		expect(
			{
				budgeted: viewParentIds((id) => children.get(id) ?? [], null, 2, view),
				unloaded: viewParentIds((id) => children.get(id), null, 100, view),
			},
		).toStrictEqual(
			{
				budgeted: [null, "alice"],
				unloaded: undefined,
			},
		);
	});
});

// Pppp holds Oooo; Oooo holds Kkkk; Kkkk holds Mmmm, a mirror of Oooo; Mmmm shows Oooo's children, so Kkkk again.
function mirrorNode(id: string, parentId: string, originalId: string): NodeResponse
{
	return {
		...node(id, parentId),
		isMirror: true,
		originalNodeId: originalId,
	};
}

const cyclicalChildren = new Map<string | null, NodeResponse[]>([
	["Pppp", [node("Oooo", "Pppp")]],
	["Oooo", [node("Kkkk", "Oooo")]],
	["Kkkk", [mirrorNode("Mmmm", "Kkkk", "Oooo")]],
	["Mmmm", [node("Kkkk", "Oooo")]],
]);

const cyclicalView: RowView =
{
	...outlineView,
	expandedIds: new Set(["Oooo", "Kkkk", "Mmmm"]),
};

describe("a mirror inside its own original", () =>
{
	it("renders the rows inside the mirror collapsed until that instance is expanded, giving each its own limit", () =>
	{
		const computed = rowLimits((id) => cyclicalChildren.get(id), "Pppp", 60, cyclicalView);
		expect(
			{
				limits: Object.fromEntries(computed.limits),
				remaining: computed.remaining,
			},
		).toStrictEqual(
			{
				limits:
				{
					Pppp: 1,
					Oooo: 1,
					Kkkk: 1,
					"Mmmm@Mmmm_Mmmm": 1,
				},
				remaining: 56,
			},
		);
	});

	it("goes one level further for each instance the user expands, and no further", () =>
	{
		const expandedInstances: RowView =
		{
			...cyclicalView,
			expandedIds: new Set([...cyclicalView.expandedIds, "virtual_Kkkk_Mmmm_Mmmm", "virtual_Mmmm_Mmmm_MmmmKkkk"]),
		};

		expect(viewParentIds((id) => cyclicalChildren.get(id), "Pppp", 60, expandedInstances)).toStrictEqual([
			"Pppp",
			"Oooo",
			"Kkkk",
			"Mmmm",
			"Kkkk",
			"Mmmm",
		]);
	});

	it("lists the parents down to the first mirror's children", () =>
	{
		expect(viewParentIds((id) => cyclicalChildren.get(id), "Pppp", 60, cyclicalView)).toStrictEqual([
			"Pppp",
			"Oooo",
			"Kkkk",
			"Mmmm",
		]);
	});

	it("finds no place for a row that is not in the tree without overflowing the stack", () =>
	{
		expect(rowBudgetToShow((id) => cyclicalChildren.get(id), "Pppp", 60, cyclicalView, "missing")).toBe(60);
	});
});

describe("a search over a mirror inside its own original", () =>
{
	const searching: RowView =
	{
		...cyclicalView,
		search: searchFilter(result(["Mmmm"], ["Pppp", "Oooo", "Kkkk"]), new Set(), new Map([["Mmmm", true]])),
	};
	const mirrorRow = mirrorNode("Mmmm", "Kkkk", "Oooo");
	const cyclicalInstance =
	{
		rootId: "Mmmm",
		path: "MmmmKkkkMmmmKkkkMmmmKkkk",
	};

	it("never shows a cyclical instance, and terminates", () =>
	{
		const computed = rowLimits((id) => cyclicalChildren.get(id), "Pppp", 60, searching);
		expect(
			{
				cyclicalShown: rendersInstanceRow(mirrorRow, cyclicalInstance, false, new Set(), searching.search),
				plainShown: rendersInstanceRow(mirrorRow, null, false, new Set(), searching.search),
				finished: computed.remaining >= 0,
			},
		).toStrictEqual(
			{
				cyclicalShown: false,
				plainShown: true,
				finished: true,
			},
		);
	});
});
