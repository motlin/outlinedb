import {vi, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import type {WorkflowyNode} from "../src/types/workflowy.js";
import {buildTestDb} from "./helpers/round-trip-helpers.js";

function apiNode(id: string, parentId: string | null, priority = 0): WorkflowyNode
{
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		completed: false,
	};
}

/** Upstream: Home > Grand > Parent > (Node, Sibling); plus Cached at Home, the only node the cache starts with. */
const UPSTREAM = [
	apiNode("Cached", null, 0),
	apiNode("Grand", null, 1),
	apiNode("Parent", "Grand"),
	apiNode("Node", "Parent", 0),
	apiNode("Sibling", "Parent", 1),
];

function fakes(cachedIds: string[] = ["Cached"])
{
	const apiClient = new WorkflowyApiClient("test-key");
	const byId = new Map(UPSTREAM.map((node) => [node.id, node]));
	const childrenOf = (parentId: string | null) => UPSTREAM.filter((node) => (node.parent_id ?? null) === parentId);
	const getNode = vi
		.spyOn(apiClient, "getNode")
		.mockImplementation(async (id) => Promise.resolve(byId.get(id) ?? Promise.reject(new Error("404"))));
	vi.spyOn(apiClient, "getChildNodes").mockImplementation(async (id) => Promise.resolve(childrenOf(id)));
	vi.spyOn(apiClient, "getRootNodes").mockImplementation(async () => Promise.resolve(childrenOf(null)));
	const cacheService = new CacheService(buildTestDb().database);
	for (const id of cachedIds)
	{
		const node = byId.get(id)!;
		cacheService.insertNode(node, node.parent_id ?? null);
	}
	return {
		client: new WorkflowyWriteThroughClient(apiClient, cacheService),
		cacheService,
		getNode,
	};
}

function shape(cacheService: CacheService, ids: string[])
{
	return ids.map((id) =>
	{
		const node = cacheService.getNode(id);
		return {
			id,
			name: node?.name,
			parentId: node?.parentId,
		};
	});
}

describe("WorkflowyWriteThroughClient.cacheLiveNode", () =>
{
	it("caches every uncached ancestor under its real parent, leaving no blank row at Home", async () =>
	{
		const {client, cacheService} = fakes();

		await client.cacheLiveNode("Node");

		expect(
			{
				home: cacheService.getChildren(null).map((node) => node.id),
				chain: shape(cacheService, ["Grand", "Parent", "Node", "Sibling"]),
			},
		).toStrictEqual(
			{
				home: ["Cached", "Grand"],
				chain: [
					{
						id: "Grand",
						name: "Grand",
						parentId: null,
					},
					{
						id: "Parent",
						name: "Parent",
						parentId: "Grand",
					},
					{
						id: "Node",
						name: "Node",
						parentId: "Parent",
					},
					{
						id: "Sibling",
						name: "Sibling",
						parentId: "Parent",
					},
				],
			},
		);
	});

	it("stops walking up at the first cached ancestor", async () =>
	{
		const {client, cacheService, getNode} = fakes(["Cached", "Grand"]);

		await client.cacheLiveNode("Node");

		expect(
			{
				fetched: getNode.mock.calls.map(([id]) => id),
				chain: shape(cacheService, ["Parent", "Node"]),
			},
		).toStrictEqual(
			{
				fetched: ["Node", "Parent"],
				chain: [
					{
						id: "Parent",
						name: "Parent",
						parentId: "Grand",
					},
					{
						id: "Node",
						name: "Node",
						parentId: "Parent",
					},
				],
			},
		);
	});

	it("caches a Home node at Home", async () =>
	{
		const {client, cacheService} = fakes();

		await client.cacheLiveNode("Grand");

		expect(shape(cacheService, ["Grand"])).toStrictEqual([
			{
				id: "Grand",
				name: "Grand",
				parentId: null,
			},
		]);
	});
});
