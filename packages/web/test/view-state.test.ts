import {describe, expect, it} from "vite-plus/test";
import {createViewStateMap, planViewRestore, viewStateKey} from "../src/client/view-state.js";
import type {SavedViewState} from "../src/client/view-state.js";

const A: SavedViewState =
{
	editing: null,
	scrollY: 1,
};
const B: SavedViewState =
{
	editing: null,
	scrollY: 2,
};
const C: SavedViewState =
{
	editing: null,
	scrollY: 3,
};

describe("viewStateKey", () =>
{
	it("joins the short id and query with a question mark", () =>
	{
		expect([
			viewStateKey(
				{
					id: "ab03ee6d2ae0",
					query: null,
				},
			),
			viewStateKey(
				{
					id: null,
					query: "x",
				},
			),
			viewStateKey(
				{
					id: null,
					query: null,
				},
			),
		]).toStrictEqual(["ab03ee6d2ae0?", "?x", "?"]);
	});
});

describe("createViewStateMap", () =>
{
	it("evicts the least recently used key past the cap, and reading makes a key newest", () =>
	{
		const map = createViewStateMap(2);
		map.set("a?", A);
		map.set("b?", B);
		const read = map.get("a?");
		map.set("c?", C);
		expect(
			{
				read,
				b: map.get("b?"),
				c: map.get("c?"),
				size: map.size,
			},
		).toStrictEqual(
			{
				read: A,
				b: undefined,
				c: C,
				size: 2,
			},
		);
	});
});

describe("planViewRestore", () =>
{
	const editing =
	{
		nodeId: "row20",
		field: "name",
		start: 1,
		end: 4,
		reversed: true,
	} as const;
	const view =
	{
		query: null,
		renderedIds: new Set(["row20", "c1"]),
		firstVisibleChildId: "c1",
		zoomedId: "zoom",
	};

	it("refocuses the saved caret when its row is rendered, restores the scroll and clears the selection", () =>
	{
		expect(
			planViewRestore(
				{
					editing,
					scrollY: 500,
				},
				view,
			),
		).toStrictEqual(
			{
				focus: editing,
				scrollY: 500,
				clearSelection: true,
			},
		);
	});

	it("focuses nothing when the saved row is no longer rendered", () =>
	{
		expect(
			planViewRestore(
				{
					editing:
					{
						...editing,
						nodeId: "gone",
					},
					scrollY: 500,
				},
				view,
			),
		).toStrictEqual(
			{
				focus: null,
				scrollY: 500,
				clearSelection: true,
			},
		);
	});

	it("focuses the first visible child at offset 0 when nothing is saved", () =>
	{
		expect(planViewRestore(undefined, view)).toStrictEqual(
			{
				focus:
				{
					nodeId: "c1",
					field: "name",
					start: 0,
					end: 0,
					reversed: false,
				},
				scrollY: 0,
				clearSelection: false,
			},
		);
	});

	it("focuses the zoom title when an unsaved location has no children", () =>
	{
		expect(
			planViewRestore(
				undefined,
				{
					...view,
					firstVisibleChildId: null,
				},
			),
		).toStrictEqual(
			{
				focus:
				{
					nodeId: "zoom",
					field: "name",
					start: 0,
					end: 0,
					reversed: false,
				},
				scrollY: 0,
				clearSelection: false,
			},
		);
	});

	it("focuses nothing at home with no children, or in an unsaved search location", () =>
	{
		expect([
			planViewRestore(
				undefined,
				{
					...view,
					firstVisibleChildId: null,
					zoomedId: null,
				},
			),
			planViewRestore(
				undefined,
				{
					...view,
					query: "x",
				},
			),
		]).toStrictEqual([
			{
				focus: null,
				scrollY: 0,
				clearSelection: false,
			},
			{
				focus: null,
				scrollY: 0,
				clearSelection: false,
			},
		]);
	});
});
