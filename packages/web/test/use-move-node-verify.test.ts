import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {QueryKey} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import type * as CacheVerify from "../src/client/cache-verify.js";
import {nodeKeys} from "../src/client/node-cache.js";

const outlineState =
{
	zoomedNodeId: null,
	editingId: null,
	editingCaretOffset: null,
	editingNoteId: null,
	itemSelection:
	{
		entries: [],
		pivotId: null,
		retractableIds: [],
		counter: 0,
	},
	addErrorNotification: () => "id",
};
const verified:
{
	label: string;
	keys: readonly QueryKey[];
}[] = [];

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
vi.mock("../src/client/cache-verify.js", async (importOriginal) => (
{
	...(await importOriginal<typeof CacheVerify>()),
	verifyAgainstServer: (_queryClient: QueryClient, label: string, keys: readonly QueryKey[]) =>
	{
		verified.push(
			{
				label,
				keys,
			},
		);
	},
}));

const {useMoveNode} = await import("../src/client/hooks/use-nodes.js");

function node(
	partial: Partial<NodeResponse> &
	{
		id: string;
	},
): NodeResponse
{
	return {
		parent_id: "p",
		name: null,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...partial,
	};
}

function captureMove(queryClient: QueryClient): ReturnType<typeof useMoveNode>
{
	const captured: ReturnType<typeof useMoveNode>[] = [];
	function Probe()
	{
		captured.push(useMoveNode());
		return null;
	}
	renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: queryClient,
			},
			createElement(Probe),
		),
	);
	const move = captured.at(0);
	if (move === undefined)
	{
		throw new Error("hook not captured");
	}
	return move;
}

beforeEach(() =>
{
	verified.length = 0;
	vi.stubGlobal("fetch", async (url: string) =>
		Promise.resolve(
			url.endsWith("/move")
				? Response.json(
						{
							nodes: [
								node(
									{
										id: "b",
									},
								),
								node(
									{
										id: "a",
										parent_id: "q",
									},
								),
							],
						},
					)
				: Response.json(
						{
							nodes: [],
						},
					),
		),
	);
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

describe("useMoveNode", () =>
{
	it("verifies the old parent's children list after a cross-parent move", async () =>
	{
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					mutations:
					{
						retry: false,
					},
				},
			},
		);
		queryClient.setQueryData(nodeKeys.children("p"), [
			node(
				{
					id: "a",
				},
			),
			node(
				{
					id: "b",
				},
			),
		]);
		queryClient.setQueryData(nodeKeys.children("q"), []);

		captureMove(queryClient).mutate(
			{
				nodeId: "a",
				parent_id: "q",
			},
		);
		await vi.waitFor(() =>
		{
			expect(queryClient.isMutating()).toBe(0);
		});

		expect(verified).toStrictEqual([
			{
				label: "move",
				keys: [
					nodeKeys.children("p"),
					nodeKeys.children("q"),
					nodeKeys.detail("a"),
					nodeKeys.detail("p"),
					nodeKeys.detail("q"),
				],
			},
		]);
	});
});
