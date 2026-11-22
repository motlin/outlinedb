import {describe, expect, it} from "vite-plus/test";
import {treeDataNodes} from "../src/cache/tree-data-nodes.js";

describe("treeDataNodes", () =>
{
	it("turns /get_tree_data/ items into export nodes, moving epoch-relative seconds onto Unix seconds", () =>
	{
		expect(
			treeDataNodes(
				[
					{
						id: "a",
						nm: "Alpha",
						no: "a note",
						prnt: null,
						pr: 3,
						ct: 10,
						cp: 20,
						lm: 30,
						metadata:
						{
							layoutMode: "board",
							mirror:
							{
								mirrorRootIds:
								{
									b: true,
								},
							},
						},
					},
					{
						id: "b",
						prnt: "a",
						no: "",
					},
				],
				1_500_000_000,
			),
		).toStrictEqual([
			{
				id: "a",
				name: "Alpha",
				note: "a note",
				parent_id: null,
				priority: 3,
				completed: true,
				data:
				{
					layoutMode: "board",
				},
				createdAt: 1_500_000_010,
				modifiedAt: 1_500_000_030,
				completedAt: 1_500_000_020,
			},
			{
				id: "b",
				name: "",
				note: null,
				parent_id: "a",
				priority: 0,
				completed: false,
				createdAt: 1_500_000_000,
				modifiedAt: null,
				completedAt: null,
			},
		]);
	});
});
