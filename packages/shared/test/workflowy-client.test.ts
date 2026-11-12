import {vi, afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";

describe("client errors", () => {
	/**
	 * A 403 from Workflowy's abuse protection carries the only text that explains
	 * the block -- the support address, the blocked IP, and the reference code.
	 * Reporting just the status code strands the caller with "403" and no way to
	 * tell an IP block apart from a bad key, an expired token, or a quota.
	 */

	const ABUSE_BODY =
		"Access denied. Please reach out to our support team at help@workflowy.com\n" +
		"and include your IP address (100.8.164.75) and code WFB(3) so we can help resolve this.";

	function clientRespondingWith(status: number, statusText: string, body: string) {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(body, {
				status,
				statusText,
				headers: {"Content-Type": "text/plain"},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		// A single retry attempt with no delay keeps the test fast; the retry path is
		// not what is under test here.
		return new WorkflowyApiClient("test-key", undefined, "https://workflowy.test", {
			maxRetries: 0,
			baseDelayMs: 0,
			maxDelayMs: 0,
		});
	}

	describe("WorkflowyApiClient error reporting", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("includes the response body when a write is refused", async () => {
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.createNode({parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa", name: "probe"}),
			).rejects.toThrow(/help@workflowy\.com/u);
		});

		it("names the blocked IP and support code so the block is actionable", async () => {
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.createNode({parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa", name: "probe"}),
			).rejects.toThrow(/100\.8\.164\.75.*WFB\(3\)/su);
		});

		it("still reports the status code alongside the body", async () => {
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.createNode({parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa", name: "probe"}),
			).rejects.toThrow(/403/u);
		});

		it("falls back to the status line when the body is empty", async () => {
			const client = clientRespondingWith(500, "Internal Server Error", "");

			await expect(
				client.createNode({parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa", name: "probe"}),
			).rejects.toThrow(/Failed to create node: 500 Internal Server Error/u);
		});

		it("reports the body on a refused move, not only on create", async () => {
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.moveNode("10e2d6c2-d165-b390-9484-d4fdbf4c4afa", "a71aed23-b0cc-0000-0000-000000000000"),
			).rejects.toThrow(/help@workflowy\.com/u);
		});

		it("reports the body on a refused update", async () => {
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(client.updateNode("10e2d6c2-d165-b390-9484-d4fdbf4c4afa", {name: "x"})).rejects.toThrow(
				/help@workflowy\.com/u,
			);
		});
	});
});

describe("client get retry", () => {
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
});

describe("client mirror", () => {
	const ORIGIN_ID = "10e2d6c2-d165-b390-9484-d4fdbf4c4afa";
	const PARENT_ID = "a71aed23-b0cc-0000-0000-000000000000";
	const MIRROR_ID = "b82bfe34-c1dd-0000-0000-000000000000";

	function clientWith(fetchMock: typeof fetch) {
		vi.stubGlobal("fetch", fetchMock);
		return new WorkflowyApiClient("test-key", undefined, "https://workflowy.test", {
			maxRetries: 0,
			baseDelayMs: 0,
			maxDelayMs: 0,
		});
	}

	describe("WorkflowyApiClient mirrors", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("creates a mirror via POST /nodes/:id/mirror and returns the new mirror and true origin", async () => {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValue(Response.json({item_id: MIRROR_ID, origin_id: ORIGIN_ID}, {status: 200}));
			const client = clientWith(fetchMock);

			const result = await client.createMirror(ORIGIN_ID, PARENT_ID, "bottom");

			expect(result).toStrictEqual({mirrorId: MIRROR_ID, originId: ORIGIN_ID});
			expect(fetchMock.mock.calls).toStrictEqual([
				[
					`https://workflowy.test/api/v1/nodes/${ORIGIN_ID}/mirror`,
					{
						method: "POST",
						headers: {Authorization: "Bearer test-key", "Content-Type": "application/json"},
						body: JSON.stringify({parent_id: PARENT_ID, position: "bottom"}),
					},
				],
			]);
		});

		it("deletes a mirror via DELETE /nodes/:id/mirror", async () => {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({status: "ok"}, {status: 200}));
			const client = clientWith(fetchMock);

			await client.deleteMirror(MIRROR_ID);

			expect(fetchMock.mock.calls).toStrictEqual([
				[
					`https://workflowy.test/api/v1/nodes/${MIRROR_ID}/mirror`,
					{
						method: "DELETE",
						headers: {Authorization: "Bearer test-key", "Content-Type": "application/json"},
					},
				],
			]);
		});

		it("reports the server body when creating a mirror fails", async () => {
			const client = clientWith(
				vi.fn<typeof fetch>().mockResolvedValue(
					new Response('{"code":"not_found","message":"Item not found"}', {
						status: 404,
						statusText: "Not Found",
					}),
				),
			);

			await expect(client.createMirror(ORIGIN_ID, PARENT_ID, "top")).rejects.toThrow(
				'Failed to create mirror: 404 Not Found\n{"code":"not_found","message":"Item not found"}',
			);
		});

		it("reports the server body when deleting a mirror fails", async () => {
			const client = clientWith(
				vi.fn<typeof fetch>().mockResolvedValue(
					new Response('{"code":"not_found","message":"Item not found"}', {
						status: 404,
						statusText: "Not Found",
					}),
				),
			);

			await expect(client.deleteMirror(MIRROR_ID)).rejects.toThrow(
				'Failed to delete mirror: 404 Not Found\n{"code":"not_found","message":"Item not found"}',
			);
		});
	});
});
