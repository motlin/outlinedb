import {vi, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";
import type {UpdateNodeRequest} from "../src/api/workflowy-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {buildTestDb} from "./helpers/round-trip-helpers.js";

const ORIGINAL_ID = "original-node";
const MIRROR_ID = "mirror-node";
const PLAIN_ID = "plain-node";

/** An API that records which node id each update targets, over an empty cache that knows one mirror. */
function fakes()
{
	const updates: [string, UpdateNodeRequest][] = [];
	const apiClient = new WorkflowyApiClient("test-key");
	vi.spyOn(apiClient, "updateNode").mockImplementation(async (id, request) =>
	{
		updates.push([id, request]);
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
		updates,
	};
}

describe("WorkflowyWriteThroughClient.updateNode on mirrors", () =>
{
	it("writes new text on a mirror to its original so the mirror never gets its own name", async () =>
	{
		const {client, updates} = fakes();

		await client.updateNode(
			MIRROR_ID,
			{
				name: "🪞 Game night",
			},
		);

		expect(updates).toStrictEqual([
			[
				ORIGINAL_ID,
				{
					name: "🪞 Game night",
				},
			],
		]);
	});

	it("writes a clear on a mirror to its original too, since the mirror has no text of its own", async () =>
	{
		const {client, updates} = fakes();

		await client.updateNode(
			MIRROR_ID,
			{
				name: "",
			},
		);

		expect(updates).toStrictEqual([
			[
				ORIGINAL_ID,
				{
					name: "",
				},
			],
		]);
	});

	it("updates a non-mirror node in place", async () =>
	{
		const {client, updates} = fakes();

		await client.updateNode(
			PLAIN_ID,
			{
				note: "details",
			},
		);

		expect(updates).toStrictEqual([
			[
				PLAIN_ID,
				{
					note: "details",
				},
			],
		]);
	});

	it("resolves the update target the same way for callers that pre-check the current text", () =>
	{
		const {client} = fakes();

		expect([client.resolveUpdateTarget(MIRROR_ID), client.resolveUpdateTarget(PLAIN_ID)]).toStrictEqual([
			ORIGINAL_ID,
			PLAIN_ID,
		]);
	});
});
