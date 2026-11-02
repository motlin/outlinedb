import {describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
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

const {flattenTree} = await import("../src/client/hooks/use-flattened-tree.js");

function node(
	id: string,
	completedAt: number | null,
	children =
	{
		hasChildren: false,
		hasUncompletedChildren: false,
	},
): NodeResponse
{
	return {
		id,
		parent_id: null,
		name: id,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt,
		...children,
	};
}

describe("flattenTree", () =>
{
	it("keeps a completed row while its completion animates and drops other completed rows when hidden", () =>
	{
		expect(
			flattenTree(
				[node("a", null), node("c", 1), node("d", 2)],
				new Set(),
				false,
				0,
				new Map(),
				new Set(["c"]),
			).map((row) => row.node.id),
		).toStrictEqual(["a", "c"]);
	});

	it("keeps every completed row when completed rows are shown", () =>
	{
		expect(
			flattenTree([node("c", 1), node("d", 2)], new Set(), true, 0, new Map(), new Set()).map(
				(row) => row.node.id,
			),
		).toStrictEqual(["c", "d"]);
	});

	it("shows no children on a parent whose children are all completed while completed rows are hidden", () =>
	{
		const parent = node(
			"p",
			null,
			{
				hasChildren: true,
				hasUncompletedChildren: false,
			},
		);
		expect(
			[false, true].map((showCompleted) =>
				flattenTree([parent], new Set(), showCompleted, 0, new Map(), new Set()).map((row) => row.hasChildren),
			),
		).toStrictEqual([[false], [true]]);
	});
});
