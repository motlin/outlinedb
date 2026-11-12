import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import
{
	cachedAncestors,
	cachedResolvedId,
	nodeKeys,
	patchCachedNode,
	readChildren,
	readDetail,
	readItemNode,
	readNode,
	removeFoundDates,
	seedResolvedId,
	spliceBlock,
	spliceChildren,
} from "../src/client/node-cache.js";
import type {NodeResponse} from "../src/node-types.js";

describe("nodeKeys", () =>
{
	it("builds stable, namespaced keys", () =>
	{
		expect(nodeKeys.all).toStrictEqual(["nodes"]);
		expect(nodeKeys.children("p")).toStrictEqual(["nodes", "children", "p"]);
		expect(nodeKeys.children(null)).toStrictEqual(["nodes", "children", null]);
		expect(nodeKeys.detail("n")).toStrictEqual(["nodes", "detail", "n"]);
		expect(nodeKeys.ancestors("n")).toStrictEqual(["nodes", "ancestors", "n"]);
	});
});

describe("readChildren / readDetail", () =>
{
	it("reads through the matching key", () =>
	{
		const qc = new QueryClient();
		const kids: NodeResponse[] = [
			{
				id: "a",
				parent_id: "parent",
				name: "a",
				note: null,
				priority: 0,
				data:
				{
					layoutMode: null,
				},
				createdAt: null,
				modifiedAt: null,
				completedAt: null,
			},
		];
		qc.setQueryData(nodeKeys.children("parent"), kids);
		qc.setQueryData(
			nodeKeys.detail("n"),
			{
				id: "n",
			},
		);

		expect(readChildren(qc, "parent")).toBe(kids);
		expect(readDetail(qc, "n")).toStrictEqual(
			{
				id: "n",
			},
		);
	});

	it("returns undefined on a cache miss", () =>
	{
		const qc = new QueryClient();
		expect(readChildren(qc, "absent")).toBeUndefined();
		expect(readDetail(qc, "absent")).toBeUndefined();
	});
});

function row(id: string, priority: number): NodeResponse
{
	return {
		id,
		parent_id: "p",
		name: id,
		note: null,
		priority,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
	};
}

const ids = (rows: NodeResponse[]) => rows.map((r) => r.id);

describe("spliceChildren", () =>
{
	const abc = [row("a", 100), row("b", 200), row("c", 300)];

	it("moves a row within its parent to a slot counted before removal, without duplicating it", () =>
	{
		expect([
			ids(spliceChildren(abc, abc[0], 2)),
			ids(spliceChildren(abc, abc[0], 1)),
			ids(spliceChildren(abc, abc[2], 0)),
			ids(spliceChildren(abc, abc[0], 3)),
		]).toStrictEqual([
			["b", "a", "c"],
			["a", "b", "c"],
			["c", "a", "b"],
			["b", "c", "a"],
		]);
	});

	it("inserts a new row at the index", () =>
	{
		expect(ids(spliceChildren([row("y", 5), row("z", 9)], row("x", 0), 0))).toStrictEqual(["x", "y", "z"]);
	});

	it("clamps an index past the end", () =>
	{
		expect(ids(spliceChildren(abc, row("x", 0), 9))).toStrictEqual(["a", "b", "c", "x"]);
	});

	it("sorts by priority and fits the row into the gap before the first row, keeping the others' priorities", () =>
	{
		const shuffled = [row("c", 30), row("a", 10), row("b", 20)];
		expect(spliceChildren(shuffled, shuffled[0], 0).map((r) => [r.id, r.priority])).toStrictEqual([
			["c", 4],
			["a", 10],
			["b", 20],
		]);
	});
});

describe("spliceBlock", () =>
{
	it("removes every moved row then inserts the block contiguously in order", () =>
	{
		const children = [row("d", 1), row("c", 2), row("b", 3), row("a", 4)];
		expect([
			ids(spliceBlock(children, [children[1], children[2]], 4)),
			ids(spliceBlock(children, [children[1], children[2]], 3)),
			ids(spliceBlock(children, [children[1], children[2]], 0)),
		]).toStrictEqual([
			["d", "a", "c", "b"],
			["d", "c", "b", "a"],
			["c", "b", "d", "a"],
		]);
	});

	it("appends after the last row's priority and seeds an empty list from 100, keeping every unmoved row", () =>
	{
		const children = [row("a", 100), row("b", 200)];
		const appended = spliceBlock(children, [row("x", 5), row("y", 6)], 2);
		expect(
			{
				appended: appended.map((r) => [r.id, r.priority]),
				kept: appended.slice(0, 2).every((r, i) => r === children[i]),
				seeded: spliceBlock([], [row("x", 5), row("y", 6)], 0).map((r) => [r.id, r.priority]),
			},
		).toStrictEqual(
			{
				appended: [
					["a", 100],
					["b", 200],
					["x", 300],
					["y", 400],
				],
				kept: true,
				seeded: [
					["x", 100],
					["y", 200],
				],
			},
		);
	});

	it("spreads a block evenly over the gap between its neighbours", () =>
	{
		const children = [row("a", 100), row("b", 400)];
		expect(spliceBlock(children, [row("x", 0), row("y", 0)], 1).map((r) => [r.id, r.priority])).toStrictEqual([
			["a", 100],
			["x", 200],
			["y", 300],
			["b", 400],
		]);
	});

	it("renumbers from 0 when the block has no gap, keeping each row whose slot did not change as the same object", () =>
	{
		const children = [row("a", 0), row("b", 1), row("c", 2), row("d", 3)];
		const spliced = spliceBlock(children, [children[2]], 1);
		expect(
			{
				order: spliced.map((r) => [r.id, r.priority]),
				kept: spliced.map((r) => children.includes(r)),
			},
		).toStrictEqual(
			{
				order: [
					["a", 0],
					["c", 1],
					["b", 2],
					["d", 3],
				],
				kept: [true, false, false, true],
			},
		);
	});
});

describe("patchCachedNode", () =>
{
	it("patches the node's detail and its row in every cached children list, leaving other rows alone", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(nodeKeys.children("p"), [row("a", 100), row("b", 200)]);
		qc.setQueryData(nodeKeys.detail("a"), row("a", 100));
		patchCachedNode(qc, "a", (node) => (
		{
			...node,
			name: "alpha",
		}));
		expect(
			{
				children: qc.getQueryData<NodeResponse[]>(nodeKeys.children("p"))?.map((r) => [r.id, r.name]),
				detail: qc.getQueryData<NodeResponse>(nodeKeys.detail("a"))?.name,
			},
		).toStrictEqual(
			{
				children: [
					["a", "alpha"],
					["b", "b"],
				],
				detail: "alpha",
			},
		);
	});

	it("returns snapshots that restore every touched entry", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(nodeKeys.children("p"), [row("a", 100)]);
		const restore = patchCachedNode(qc, "a", (node) => (
		{
			...node,
			name: "alpha",
		}));
		restore();
		expect(qc.getQueryData<NodeResponse[]>(nodeKeys.children("p"))?.map((r) => r.name)).toStrictEqual(["a"]);
	});
});

describe("readItemNode", () =>
{
	it("falls back to the cached row while the edited node's fetch is still pending", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(nodeKeys.children("p"), [row("a", 100), row("b", 200)]);
		expect(readItemNode(qc, "b", undefined)).toStrictEqual(row("b", 200));
	});

	it("prefers the fetched edited node when it is the item", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(nodeKeys.children("p"), [row("a", 100)]);
		const fetched =
		{
			...row("a", 100),
			name: "fetched",
		};
		expect(readItemNode(qc, "a", fetched)).toStrictEqual(fetched);
	});

	it("reads the cache when the edited node is another row", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(nodeKeys.children("p"), [row("a", 100), row("b", 200)]);
		expect(readItemNode(qc, "b", row("a", 100))).toStrictEqual(row("b", 200));
	});

	it("is undefined with no item or an uncached item", () =>
	{
		const qc = new QueryClient();
		expect([readItemNode(qc, undefined, row("a", 100)), readItemNode(qc, "x", undefined)]).toStrictEqual([
			undefined,
			undefined,
		]);
	});
});

describe("Found Dates rows", () =>
{
	const found = (id: string): NodeResponse => (
	{
		...row(id, 1),
		isMirror: true,
		originalNodeId: id,
	});

	it("readNode falls back to a cached Found Dates row, read as its original", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(
			nodeKeys.foundDates("day"),
			{
				items: [
					{
						node: found("due"),
						crumbs: [],
					},
				],
			},
		);

		expect(
			{
				due: readNode(qc, "due"),
				absent: readNode(qc, "absent"),
			},
		).toStrictEqual(
			{
				due:
				{
					...row("due", 1),
					isMirror: false,
					originalNodeId: null,
				},
				absent: undefined,
			},
		);
	});

	it("readNode prefers the node's own row to its Found Dates row", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(nodeKeys.children("p"), [row("due", 1)]);
		qc.setQueryData(
			nodeKeys.foundDates("day"),
			{
				items: [
					{
						node: found("due"),
						crumbs: [],
					},
				],
			},
		);

		expect(readNode(qc, "due")).toStrictEqual(row("due", 1));
	});

	it("removeFoundDates drops the rows from every cached Found Dates list", () =>
	{
		const qc = new QueryClient();
		qc.setQueryData(
			nodeKeys.foundDates("d1"),
			{
				items: [
					{
						node: found("a"),
						crumbs: [],
					},
					{
						node: found("b"),
						crumbs: [],
					},
				],
			},
		);
		qc.setQueryData(
			nodeKeys.foundDates("d2"),
			{
				items: [
					{
						node: found("a"),
						crumbs: [],
					},
				],
			},
		);

		removeFoundDates(qc, ["a"]);

		expect(
			{
				d1: qc.getQueryData(nodeKeys.foundDates("d1")),
				d2: qc.getQueryData(nodeKeys.foundDates("d2")),
			},
		).toStrictEqual(
			{
				d1:
				{
					items: [
						{
							node: found("b"),
							crumbs: [],
						},
					],
				},
				d2:
				{
					items: [],
				},
			},
		);
	});
});

describe("seedResolvedId", () =>
{
	it("caches the node's short URL id as resolved, so the hash route zooms without a lookup request", () =>
	{
		const queryClient = new QueryClient();
		seedResolvedId(queryClient, "4823cefa-5fc0-478c-88ac-35035d443bf1");
		expect(queryClient.getQueryData(nodeKeys.resolvedId("35035d443bf1"))).toBe(
			"4823cefa-5fc0-478c-88ac-35035d443bf1",
		);
	});
});

const ALICE = "4823cefa-5fc0-478c-88ac-35035d443bf1";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-aaaaaaaaaaaa";
const CAROL = "1b2c3d4e-5f60-4718-9a0b-bbbbbbbbbbbb";

function treeRow(id: string, parentId: string | null, fields: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		...row(id, 100),
		parent_id: parentId,
		...fields,
	};
}

function asAncestor(node: NodeResponse): NodeResponse
{
	return {
		...node,
		hasChildren: true,
		hasUncompletedChildren: true,
		isMirror: false,
		originalNodeId: null,
	};
}

describe("cachedResolvedId", () =>
{
	it("resolves a short URL id from any cached row, detail or ancestor chain, and misses an unknown one", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children(null), [treeRow(ALICE, null)]);
		queryClient.setQueryData(nodeKeys.detail(BOB), treeRow(BOB, ALICE));
		queryClient.setQueryData(nodeKeys.ancestors("x"), [treeRow(CAROL, null)]);
		expect([
			cachedResolvedId(queryClient, "35035d443bf1"),
			cachedResolvedId(queryClient, "aaaaaaaaaaaa"),
			cachedResolvedId(queryClient, "bbbbbbbbbbbb"),
			cachedResolvedId(queryClient, ALICE),
			cachedResolvedId(queryClient, "cccccccccccc"),
		]).toStrictEqual([ALICE, BOB, CAROL, ALICE, undefined]);
	});
});

describe("cachedAncestors", () =>
{
	const alice = treeRow(ALICE, null);
	const bob = treeRow(
		BOB,
		ALICE,
		{
			isMirror: true,
			originalNodeId: "orig",
			hasChildren: false,
		},
	);
	const carol = treeRow(CAROL, BOB);

	it("extends the parent's cached chain with the node's cached row, as the ancestors route returns it", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.ancestors(ALICE), [asAncestor(alice)]);
		queryClient.setQueryData(nodeKeys.children(ALICE), [bob]);
		expect(cachedAncestors(queryClient, BOB)).toStrictEqual([asAncestor(alice), asAncestor(bob)]);
	});

	it("cuts an ancestor's chain out of any cached chain that passes through it", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.ancestors(CAROL), [asAncestor(alice), asAncestor(bob), asAncestor(carol)]);
		expect(cachedAncestors(queryClient, BOB)).toStrictEqual([asAncestor(alice), asAncestor(bob)]);
	});

	it("builds a top-level node's chain from its row alone", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children(null), [alice]);
		expect(cachedAncestors(queryClient, ALICE)).toStrictEqual([asAncestor(alice)]);
	});

	it("misses when the node or its parent's chain is not cached", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children(ALICE), [bob]);
		expect([cachedAncestors(queryClient, BOB), cachedAncestors(queryClient, CAROL)]).toStrictEqual([
			undefined,
			undefined,
		]);
	});
});
