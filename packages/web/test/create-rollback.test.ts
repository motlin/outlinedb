// @vitest-environment happy-dom
import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import {insertOptimisticCreate, rollbackCreate} from "../src/client/hooks/use-nodes.js";
import {nodeKeys, removeOptimistic} from "../src/client/node-cache.js";
import type {NodeResponse} from "../src/node-types.js";

function row(id: string): NodeResponse
{
	return {
		id,
		parent_id: null,
		name: id,
		note: null,
		priority: 100,
		data:
		{
			layoutMode: null,
		},
		createdAt: 0,
		modifiedAt: 0,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		isMirror: false,
	};
}

const ids = (rows: NodeResponse[] | undefined): string[] | undefined => rows?.map((r): string => r.id);

describe("removeOptimistic", () =>
{
	it("removes only the named row", () =>
	{
		const list = [row("a"), row("tempA"), row("tempB")];
		expect([
			ids(removeOptimistic(list, "tempB")),
			ids(removeOptimistic(removeOptimistic(list, "tempA"), "tempB")),
			removeOptimistic(undefined, "x"),
		]).toStrictEqual([["a", "tempA"], ["a"], undefined]);
	});
});

describe("parallel create rollback", () =>
{
	it("never drops a pending row or resurrects a failed one", () =>
	{
		const client = new QueryClient();
		client.setQueryData(nodeKeys.children(null), [row("a")]);
		const ctxA = insertOptimisticCreate(
			client,
			{
				name: "A",
				id: "tempA",
			},
		);
		const ctxB = insertOptimisticCreate(
			client,
			{
				name: "B",
				id: "tempB",
			},
		);
		rollbackCreate(client, ctxA);
		const afterA = ids(client.getQueryData<NodeResponse[]>(nodeKeys.children(null)));
		rollbackCreate(client, ctxB);
		const afterB = ids(client.getQueryData<NodeResponse[]>(nodeKeys.children(null)));
		expect(
			{
				afterA,
				afterB,
			},
		).toStrictEqual(
			{
				afterA: ["a", "tempB"],
				afterB: ["a"],
			},
		);
	});
});
