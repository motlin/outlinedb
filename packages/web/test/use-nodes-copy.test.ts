import {QueryClient} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {undoHistory} from "../src/client/undo-history.js";
import type {ViewState} from "../src/client/undo-history.js";

const outlineState =
{
	addErrorNotification: () => "id",
};

vi.mock("../src/client/hooks/use-saving.js", () => (
{
	trackReplay: async <T>(promise: Promise<T>) => promise,
}));
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		(selector?: (state: typeof outlineState) => unknown) => (selector ? selector(outlineState) : outlineState),
		{
			getState: () => outlineState,
		},
	),
}));

const {copyNodesAt} = await import("../src/client/hooks/use-nodes.js");
const {runInUndoBatch} = await import("../src/client/undo-batch.js");

function node(id: string, priority: number): NodeResponse
{
	return {
		id,
		parent_id: "P",
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

const view: ViewState =
{
	zoomedNodeId: null,
	editing: null,
	selectedIds: [],
};
const requests:
{
	url: string;
	body: unknown;
}[] = [];

beforeEach(() =>
{
	undoHistory.clear();
	requests.length = 0;
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
	{
		requests.push(
			{
				url,
				body: JSON.parse(typeof init?.body === "string" ? init.body : "null"),
			},
		);
		return Promise.resolve(
			url.endsWith("/duplicate")
				? Response.json(
						{
							ids: ["d1", "d2"],
						},
						{
							status: 201,
						},
					)
				: Response.json(
						{
							nodes: [node("m1", 0), node("m2", 1)],
						},
						{
							status: 201,
						},
					),
		);
	});
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

describe("copyNodesAt", () =>
{
	it("duplicates through /duplicate and records one undo step that deletes every copy", async () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children("P"), [node("a", 100), node("b", 200)]);

		const ids = await runInUndoBatch(
			() => view,
			async () => copyNodesAt(queryClient, "duplicate", ["a", "b"], "P", 1),
		);

		expect(
			{
				ids,
				requests,
				undo: undoHistory.popUndo()?.ops,
			},
		).toStrictEqual(
			{
				ids: ["d1", "d2"],
				requests: [
					{
						url: "/api/v1/nodes/duplicate",
						body:
						{
							ids: ["a", "b"],
							parent_id: "P",
							index: 1,
						},
					},
				],
				undo: [
					{
						kind: "delete",
						nodeId: "d2",
						parentId: "P",
						index: 2,
					},
					{
						kind: "delete",
						nodeId: "d1",
						parentId: "P",
						index: 1,
					},
				],
			},
		);
		expect(undoHistory.canUndo).toBe(false);
	});

	it("mirrors through /mirror the same way", async () =>
	{
		const queryClient = new QueryClient();

		const ids = await runInUndoBatch(
			() => view,
			async () => copyNodesAt(queryClient, "mirror", ["a"], "P", 0),
		);

		expect(
			{
				ids,
				requests,
				undo: undoHistory.popUndo()?.ops,
			},
		).toStrictEqual(
			{
				ids: ["m1", "m2"],
				requests: [
					{
						url: "/api/v1/nodes/mirror",
						body:
						{
							item_ids: ["a"],
							parent_id: "P",
							index: 0,
						},
					},
				],
				undo: [
					{
						kind: "delete",
						nodeId: "m2",
						parentId: "P",
						index: 1,
					},
					{
						kind: "delete",
						nodeId: "m1",
						parentId: "P",
						index: 0,
					},
				],
			},
		);
	});

	it("records nothing when the write fails", async () =>
	{
		const queryClient = new QueryClient();
		vi.stubGlobal("fetch", async () =>
			Promise.resolve(
				new Response(
					null,
					{
						status: 500,
						statusText: "Boom",
					},
				),
			),
		);

		await expect(
			runInUndoBatch(
				() => view,
				async () => copyNodesAt(queryClient, "duplicate", ["a"], "P", 0),
			),
		).rejects.toThrow("Failed to duplicate nodes");

		expect(undoHistory.canUndo).toBe(false);
	});
});
