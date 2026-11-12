import {vi, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {buildTestDb} from "./helpers/round-trip-helpers.js";

const ORIGINAL_ID = "original-node";
const MIRROR_ID = "mirror-node";
const PLAIN_ID = "plain-node";

/** An API that records which node id each completion targets, over an empty cache that knows one mirror. */
function fakes()
{
	const calls: [string, string][] = [];
	const apiClient = new WorkflowyApiClient("test-key");
	vi.spyOn(apiClient, "completeNode").mockImplementation(async (id) =>
	{
		calls.push(["complete", id]);
		return Promise.resolve();
	});
	vi.spyOn(apiClient, "uncompleteNode").mockImplementation(async (id) =>
	{
		calls.push(["uncomplete", id]);
		return Promise.resolve();
	});
	vi.spyOn(apiClient, "getNode").mockImplementation(async (id) =>
		Promise.resolve(
			{
				id,
				name: "fresh",
				priority: 0,
				createdAt: 0,
				modifiedAt: null,
			},
		),
	);
	const cacheService = new CacheService(buildTestDb().database);
	vi.spyOn(cacheService, "getMirrorOriginal").mockImplementation((id) => (id === MIRROR_ID ? ORIGINAL_ID : null));
	return {
		client: new WorkflowyWriteThroughClient(apiClient, cacheService),
		calls,
	};
}

describe("WorkflowyWriteThroughClient completion on mirrors", () =>
{
	it("completes the original when a mirror is completed", async () =>
	{
		const {client, calls} = fakes();

		const node = await client.completeNode(MIRROR_ID);

		expect(
			{
				calls,
				id: node.id,
			},
		).toStrictEqual(
			{
				calls: [["complete", ORIGINAL_ID]],
				id: ORIGINAL_ID,
			},
		);
	});

	it("uncompletes the original when a mirror is uncompleted", async () =>
	{
		const {client, calls} = fakes();

		const node = await client.uncompleteNode(MIRROR_ID);

		expect(
			{
				calls,
				id: node.id,
			},
		).toStrictEqual(
			{
				calls: [["uncomplete", ORIGINAL_ID]],
				id: ORIGINAL_ID,
			},
		);
	});

	it("completes and uncompletes a plain node in place", async () =>
	{
		const {client, calls} = fakes();

		await client.completeNode(PLAIN_ID);
		await client.uncompleteNode(PLAIN_ID);

		expect(calls).toStrictEqual([
			["complete", PLAIN_ID],
			["uncomplete", PLAIN_ID],
		]);
	});
});
