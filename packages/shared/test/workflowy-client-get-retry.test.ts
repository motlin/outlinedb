import {vi, afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";

/**
 * Every write-through command reads the node back with `GET /nodes/:id` after
 * the write lands. If that read gave up on the first 429, a create that
 * succeeded upstream would be reported as failed, and a re-run would create a
 * duplicate. Single-node reads must retry 429 like the list reads do.
 */

const NODE_ID = "10e2d6c2-d165-b390-9484-d4fdbf4c4afa";

const NODE = {
	id: NODE_ID,
	name: "probe",
	parent_id: null,
	priority: 0,
	completed: false,
	createdAt: 1_780_876_800,
	modifiedAt: 1_780_876_800,
	completedAt: null,
};

function throttledThenOk(): ReturnType<typeof vi.fn<typeof fetch>> {
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(new Response("slow down", {status: 429, statusText: "Too Many Requests"}))
		.mockResolvedValueOnce(Response.json({node: NODE}, {status: 200, statusText: "OK"}));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function client(): WorkflowyApiClient {
	return new WorkflowyApiClient("test-key", undefined, "https://workflowy.test", {
		maxRetries: 1,
		baseDelayMs: 0,
		maxDelayMs: 0,
	});
}

describe("WorkflowyApiClient single-node reads", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("getNode retries a 429 and returns the node", async () => {
		const fetchMock = throttledThenOk();

		await expect(client().getNode(NODE_ID)).resolves.toStrictEqual(NODE);
		expect(fetchMock.mock.calls.map(([url]) => url)).toStrictEqual([
			`https://workflowy.test/api/v1/nodes/${NODE_ID}`,
			`https://workflowy.test/api/v1/nodes/${NODE_ID}`,
		]);
	});

	it("findNode retries a 429 and returns the node", async () => {
		const fetchMock = throttledThenOk();

		await expect(client().findNode(NODE_ID)).resolves.toStrictEqual(NODE);
		expect(fetchMock.mock.calls.map(([url]) => url)).toStrictEqual([
			`https://workflowy.test/api/v1/nodes/${NODE_ID}`,
			`https://workflowy.test/api/v1/nodes/${NODE_ID}`,
		]);
	});
});
