// @vitest-environment happy-dom
import {QueryClient} from "@tanstack/react-query";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";

vi.mock("../src/client/hooks/use-saving.js", () => (
{
	trackReplay: async <T>(promise: Promise<T>) => promise,
}));

const {planAddChild} = await import("../src/client/tree-ops.js");
const {createNode, insertOptimisticCreate} = await import("../src/client/hooks/use-nodes.js");

const bodies: unknown[] = [];

function stubFetch(): void
{
	vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) =>
	{
		bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
		return Promise.resolve(
			Response.json(
				{
					node:
					{
						id: "n",
					},
				},
				{
					status: 201,
				},
			),
		);
	});
}

afterEach(() =>
{
	bodies.length = 0;
});

describe("create request body", () =>
{
	it("sends no index and no after_id for the add button's at-end plan", async () =>
	{
		stubFetch();
		const plan = planAddChild(
			{
				childCount: 2,
				zoomedId: "p",
				shapeLayout: null,
			},
		);
		const request =
		{
			parent_id: plan.parent_id,
			name: plan.name,
			index: plan.index,
			at_end: plan.at_end,
		};
		insertOptimisticCreate(new QueryClient(), request);
		await createNode(request);
		expect(bodies).toStrictEqual([
			{
				parent_id: "p",
				name: "",
			},
		]);
	});

	it("still sends index and after_id for an exact-index create", async () =>
	{
		stubFetch();
		const request =
		{
			parent_id: "p",
			name: "",
			index: 0,
		};
		insertOptimisticCreate(new QueryClient(), request);
		await createNode(request);
		expect(bodies).toStrictEqual([
			{
				parent_id: "p",
				name: "",
				index: 0,
				after_id: null,
			},
		]);
	});
});
