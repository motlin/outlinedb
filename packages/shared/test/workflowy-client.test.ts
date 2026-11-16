import {vi, afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";

describe("client errors", () =>
{
	/**
	 * A 403 from Workflowy's abuse protection carries the only text that explains
	 * the block -- the support address, the blocked IP, and the reference code.
	 * Reporting just the status code strands the caller with "403" and no way to
	 * tell an IP block apart from a bad key, an expired token, or a quota.
	 */

	const ABUSE_BODY =
		"Access denied. Please reach out to our support team at help@workflowy.com\n" +
		"and include your IP address (100.8.164.75) and code WFB(3) so we can help resolve this.";

	function clientRespondingWith(status: number, statusText: string, body: string)
	{
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				body,
				{
					status,
					statusText,
					headers:
					{
						"Content-Type": "text/plain",
					},
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		return new WorkflowyApiClient("test-key", undefined, "https://workflowy.test");
	}

	describe("WorkflowyApiClient error reporting", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("includes the response body when a write is refused", async () =>
		{
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.createNode(
					{
						parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
						name: "probe",
					},
				),
			).rejects.toThrow(/help@workflowy\.com/u);
		});

		it("names the blocked IP and support code so the block is actionable", async () =>
		{
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.createNode(
					{
						parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
						name: "probe",
					},
				),
			).rejects.toThrow(/100\.8\.164\.75.*WFB\(3\)/su);
		});

		it("still reports the status code alongside the body", async () =>
		{
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.createNode(
					{
						parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
						name: "probe",
					},
				),
			).rejects.toThrow(/403/u);
		});

		it("falls back to the status line when the body is empty", async () =>
		{
			const client = clientRespondingWith(500, "Internal Server Error", "");

			await expect(
				client.createNode(
					{
						parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
						name: "probe",
					},
				),
			).rejects.toThrow(/Failed to create node: 500 Internal Server Error/u);
		});

		it("reports the body on a refused move, not only on create", async () =>
		{
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.moveNode("10e2d6c2-d165-b390-9484-d4fdbf4c4afa", "a71aed23-b0cc-0000-0000-000000000000"),
			).rejects.toThrow(/help@workflowy\.com/u);
		});

		it("reports the body on a refused update", async () =>
		{
			const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

			await expect(
				client.updateNode(
					"10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
					{
						name: "x",
					},
				),
			).rejects.toThrow(/help@workflowy\.com/u);
		});

		/**
		 * Node's fetch hides the connect failure behind "fetch failed"; the dialed
		 * address only appears in the undici cause. A timeout that curl cannot
		 * reproduce needs that address, its family, and the elapsed time to diagnose.
		 */
		function clientFailingToConnect(causeMessage: string)
		{
			const cause = Object.assign(
				new Error(causeMessage),
				{
					name: "ConnectTimeoutError",
					code: "UND_ERR_CONNECT_TIMEOUT",
				},
			);
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>().mockRejectedValue(
					new TypeError(
						"fetch failed",
						{
							cause,
						},
					),
				),
			);
			return new WorkflowyApiClient("test-key", undefined, "https://workflowy.test");
		}

		it("names the dialed IPv4 address, family and elapsed time when connecting times out", async () =>
		{
			const client = clientFailingToConnect(
				"Connect Timeout Error (attempted address: 75.2.70.75:443, timeout: 10000ms)",
			);

			await expect(
				client.updateNode(
					"10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
					{
						name: "x",
					},
				),
			).rejects.toThrow(
				/^POST https:\/\/workflowy\.test\/api\/v1\/nodes\/10e2d6c2-d165-b390-9484-d4fdbf4c4afa failed after \d+ms: UND_ERR_CONNECT_TIMEOUT Connect Timeout Error \(attempted address: 75\.2\.70\.75:443, timeout: 10000ms\) \[dialed 75\.2\.70\.75:443 \(IPv4\)\]$/u,
			);
		});

		it("labels every attempted address with its family when both families were dialed", async () =>
		{
			const client = clientFailingToConnect(
				"Connect Timeout Error (attempted addresses: 2600:9000:a51c::1:443, 99.83.190.102:443, timeout: 250ms)",
			);

			await expect(
				client.moveNode("10e2d6c2-d165-b390-9484-d4fdbf4c4afa", "a71aed23-b0cc-0000-0000-000000000000"),
			).rejects.toThrow(/\[dialed 2600:9000:a51c::1:443 \(IPv6\), 99\.83\.190\.102:443 \(IPv4\)\]$/u);
		});
	});
});

describe("client mirror", () =>
{
	const ORIGIN_ID = "10e2d6c2-d165-b390-9484-d4fdbf4c4afa";
	const PARENT_ID = "a71aed23-b0cc-0000-0000-000000000000";
	const MIRROR_ID = "b82bfe34-c1dd-0000-0000-000000000000";

	function clientWith(fetchMock: typeof fetch)
	{
		vi.stubGlobal("fetch", fetchMock);
		return new WorkflowyApiClient("test-key", undefined, "https://workflowy.test");
	}

	describe("WorkflowyApiClient mirrors", () =>
	{
		afterEach(() =>
		{
			vi.unstubAllGlobals();
		});

		it("creates a mirror via POST /nodes/:id/mirror and returns the new mirror and true origin", async () =>
		{
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
				Response.json(
					{
						item_id: MIRROR_ID,
						origin_id: ORIGIN_ID,
					},
					{
						status: 200,
					},
				),
			);
			const client = clientWith(fetchMock);

			const result = await client.createMirror(ORIGIN_ID, PARENT_ID, "bottom");

			expect(result).toStrictEqual(
				{
					mirrorId: MIRROR_ID,
					originId: ORIGIN_ID,
				},
			);
			expect(fetchMock.mock.calls).toStrictEqual([
				[
					`https://workflowy.test/api/v1/nodes/${ORIGIN_ID}/mirror`,
					{
						method: "POST",
						headers:
						{
							Authorization: "Bearer test-key",
							"Content-Type": "application/json",
						},
						body: JSON.stringify(
							{
								parent_id: PARENT_ID,
								position: "bottom",
							},
						),
					},
				],
			]);
		});

		it("deletes a mirror via DELETE /nodes/:id/mirror", async () =>
		{
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
				Response.json(
					{
						status: "ok",
					},
					{
						status: 200,
					},
				),
			);
			const client = clientWith(fetchMock);

			await client.deleteMirror(MIRROR_ID);

			expect(fetchMock.mock.calls).toStrictEqual([
				[
					`https://workflowy.test/api/v1/nodes/${MIRROR_ID}/mirror`,
					{
						method: "DELETE",
						headers:
						{
							Authorization: "Bearer test-key",
							"Content-Type": "application/json",
						},
					},
				],
			]);
		});

		it("reports the server body when creating a mirror fails", async () =>
		{
			const client = clientWith(
				vi.fn<typeof fetch>().mockResolvedValue(
					new Response(
						'{"code":"not_found","message":"Item not found"}',
						{
							status: 404,
							statusText: "Not Found",
						},
					),
				),
			);

			await expect(client.createMirror(ORIGIN_ID, PARENT_ID, "top")).rejects.toThrow(
				'Failed to create mirror: 404 Not Found\n{"code":"not_found","message":"Item not found"}',
			);
		});

		it("reports the server body when deleting a mirror fails", async () =>
		{
			const client = clientWith(
				vi.fn<typeof fetch>().mockResolvedValue(
					new Response(
						'{"code":"not_found","message":"Item not found"}',
						{
							status: 404,
							statusText: "Not Found",
						},
					),
				),
			);

			await expect(client.deleteMirror(MIRROR_ID)).rejects.toThrow(
				'Failed to delete mirror: 404 Not Found\n{"code":"not_found","message":"Item not found"}',
			);
		});
	});
});
