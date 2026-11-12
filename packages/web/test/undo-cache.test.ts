import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import {nodeKeys, readChildren, readDetail} from "../src/client/node-cache.js";
import {previewUndoOps} from "../src/client/undo-cache.js";
import type {NodeResponse} from "../src/node-types.js";

function row(id: string, parentId: string | null, priority: number, extra: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		id,
		parent_id: parentId,
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
		...extra,
	};
}

function seeded(): QueryClient
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(nodeKeys.children("P"), [row("a", "P", 100), row("b", "P", 200), row("c", "P", 300)]);
	queryClient.setQueryData(nodeKeys.children("Q"), [row("q", "Q", 100)]);
	queryClient.setQueryData(nodeKeys.detail("a"), row("a", "P", 100));
	return queryClient;
}

const ids = (rows: NodeResponse[] | undefined): [string, string | null][] =>
	(rows ?? []).map((node) => [node.id, node.parent_id]);

describe("previewUndoOps", () =>
{
	it("moves a row within its list at the endpoint's before-removal slot", () =>
	{
		const queryClient = seeded();
		previewUndoOps(queryClient, [
			{
				kind: "move",
				nodeId: "a",
				from:
				{
					parentId: "P",
					index: 0,
				},
				to:
				{
					parentId: "P",
					index: 3,
				},
			},
		]);
		expect(ids(readChildren(queryClient, "P"))).toStrictEqual([
			["b", "P"],
			["c", "P"],
			["a", "P"],
		]);
	});

	it("replays a multi-row undo in order across parents and repoints the detail entry", () =>
	{
		const queryClient = seeded();
		previewUndoOps(queryClient, [
			{
				kind: "move",
				nodeId: "b",
				from:
				{
					parentId: "P",
					index: 1,
				},
				to:
				{
					parentId: "Q",
					index: 0,
				},
			},
			{
				kind: "move",
				nodeId: "a",
				from:
				{
					parentId: "P",
					index: 0,
				},
				to:
				{
					parentId: "Q",
					index: 2,
				},
			},
		]);
		expect(
			{
				P: ids(readChildren(queryClient, "P")),
				Q: ids(readChildren(queryClient, "Q")),
				detail: readDetail(queryClient, "a")?.parent_id,
			},
		).toStrictEqual(
			{
				P: [["c", "P"]],
				Q: [
					["b", "Q"],
					["q", "Q"],
					["a", "Q"],
				],
				detail: "Q",
			},
		);
	});

	it("patches an edited field everywhere the row is cached", () =>
	{
		const queryClient = seeded();
		previewUndoOps(queryClient, [
			{
				kind: "edit",
				nodeId: "a",
				field: "name",
				before: "a",
				after: "a #tag",
			},
		]);
		expect([readChildren(queryClient, "P")?.[0]?.name, readDetail(queryClient, "a")?.name]).toStrictEqual([
			"a #tag",
			"a #tag",
		]);
	});

	it("completes and uncompletes rows", () =>
	{
		const queryClient = seeded();
		queryClient.setQueryData(nodeKeys.children("Q"), [
			row(
				"q",
				"Q",
				100,
				{
					completedAt: 5,
				},
			),
		]);
		previewUndoOps(queryClient, [
			{
				kind: "complete",
				nodeId: "b",
			},
			{
				kind: "uncomplete",
				nodeId: "q",
			},
		]);
		expect([
			typeof readChildren(queryClient, "P")?.[1]?.completedAt,
			readChildren(queryClient, "Q")?.[0]?.completedAt,
		]).toStrictEqual(["number", null]);
	});

	it("removes a deleted row and puts it back at its slot when the same id is restored", () =>
	{
		const queryClient = seeded();
		previewUndoOps(queryClient, [
			{
				kind: "delete",
				nodeId: "b",
				parentId: "P",
				index: 1,
			},
		]);
		const afterDelete = ids(readChildren(queryClient, "P"));
		previewUndoOps(queryClient, [
			{
				kind: "undelete",
				nodeId: "b",
				parentId: "P",
				index: 1,
			},
		]);
		expect(
			{
				afterDelete,
				afterRestore: ids(readChildren(queryClient, "P")),
			},
		).toStrictEqual(
			{
				afterDelete: [
					["a", "P"],
					["c", "P"],
				],
				afterRestore: [
					["a", "P"],
					["b", "P"],
					["c", "P"],
				],
			},
		);
	});

	it("leaves the cache alone for a row it has never seen", () =>
	{
		const queryClient = seeded();
		previewUndoOps(queryClient, [
			{
				kind: "move",
				nodeId: "ghost",
				from:
				{
					parentId: "P",
					index: 0,
				},
				to:
				{
					parentId: "Q",
					index: 0,
				},
			},
			{
				kind: "undelete",
				nodeId: "ghost2",
				parentId: "P",
				index: 0,
			},
		]);
		expect(
			{
				P: ids(readChildren(queryClient, "P")),
				Q: ids(readChildren(queryClient, "Q")),
			},
		).toStrictEqual(
			{
				P: [
					["a", "P"],
					["b", "P"],
					["c", "P"],
				],
				Q: [["q", "Q"]],
			},
		);
	});
});
