// @vitest-environment happy-dom
import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {renders} from "./helpers/render-counter.js";
import type {NodeResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {FilesListRows} = await import("../src/client/components/left-bar-files-list.js");
const {nodeKeys} = await import("../src/client/node-cache.js");

function node(id: string, priority: number): NodeResponse
{
	return {
		id,
		parent_id: null,
		name: id,
		note: null,
		priority,
		data:
		{
			layoutMode: null,
		},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren: false,
	};
}

const rows = [node("alice", 100), node("bob", 200), node("carol", 300)];
const queryClient = new QueryClient(
	{
		defaultOptions:
		{
			queries:
			{
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
			},
		},
	},
);
let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	queryClient.setQueryData(nodeKeys.children(null), rows);
	root = createRoot(document.createElement("div"));
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(
					FilesListRows,
					{
						parentId: null,
						depth: 0,
						section: "home",
					},
				),
			),
		);
	});
});

afterAll(() =>
{
	act(() =>
	{
		root?.unmount();
	});
});

describe("left bar files list render count", () =>
{
	it("re-renders only the row whose node a save changed", async () =>
	{
		renders.clear();
		await act(async () =>
		{
			queryClient.setQueryData(nodeKeys.children(null), [
				{
					...rows[0],
					name: "Alice!",
				},
				rows[1],
				rows[2],
			]);
			await new Promise((resolve) =>
			{
				setTimeout(resolve, 20);
			});
		});
		expect(renders.get("FilesListBranch") ?? 0).toBe(1);
	});
});
