import {vi, afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";

const ORIGIN_ID = "10e2d6c2-d165-b390-9484-d4fdbf4c4afa";
const PARENT_ID = "a71aed23-b0cc-0000-0000-000000000000";
const MIRROR_ID = "b82bfe34-c1dd-0000-0000-000000000000";

function clientWith(fetchMock: typeof fetch)
{
	vi.stubGlobal("fetch", fetchMock);
	return new WorkflowyApiClient(
		"test-key",
		undefined,
		"https://workflowy.test",
		{
			maxRetries: 0,
			baseDelayMs: 0,
			maxDelayMs: 0,
		},
	);
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
