import {vi, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {buildTestDb} from "./helpers/round-trip-helpers.js";

const NODE_ID = "uncached-node";
const PARENT_ID = "api-parent";

/** An API whose node lives under a parent at Home, over an empty cache. */
function fakes() {
	const apiClient = new WorkflowyApiClient("test-key");
	vi.spyOn(apiClient, "updateNode").mockResolvedValue();
	vi.spyOn(apiClient, "completeNode").mockResolvedValue();
	vi.spyOn(apiClient, "uncompleteNode").mockResolvedValue();
	vi.spyOn(apiClient, "getNode").mockImplementation(async (id) =>
		Promise.resolve(
			id === NODE_ID
				? {id, name: "fresh", parent_id: PARENT_ID, priority: 0, createdAt: 0, modifiedAt: null}
				: {id, name: "parent", priority: 0, createdAt: 0, modifiedAt: null},
		),
	);
	const cacheService = new CacheService(buildTestDb().database);
	return {client: new WorkflowyWriteThroughClient(apiClient, cacheService), cacheService};
}

describe("WorkflowyWriteThroughClient caching a node it had not cached", () => {
	it("files an updated node under the parent the API reports", async () => {
		const {client, cacheService} = fakes();

		await client.updateNode(NODE_ID, {name: "fresh"});

		expect(cacheService.getNode(NODE_ID)?.parentId).toBe(PARENT_ID);
	});

	it("files a completed node under the parent the API reports", async () => {
		const {client, cacheService} = fakes();

		await client.completeNode(NODE_ID);

		expect(cacheService.getNode(NODE_ID)?.parentId).toBe(PARENT_ID);
	});

	it("files an uncompleted node under the parent the API reports", async () => {
		const {client, cacheService} = fakes();

		await client.uncompleteNode(NODE_ID);

		expect(cacheService.getNode(NODE_ID)?.parentId).toBe(PARENT_ID);
	});
});
