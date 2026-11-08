import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";
import {storeClient} from "../src/store-client";
import type {UserStore} from "../src/user-store";

/** A copy in this realm: objects from Miniflare's RPC carry another realm's prototypes, which strict equality rejects. */
function plain(value: unknown): unknown {
	// oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps the other realm's prototypes
	return JSON.parse(JSON.stringify(value));
}

describe("Workflowy secrets reach only the owner's Durable Object", () => {
	let harness: Harness;
	const calls: {method: string; path: string; auth: string | null}[] = [];

	beforeAll(async () => {
		harness = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			undefined,
			{
				ACCESS_DEV_IDENTITY: "dev",
				WORKFLOWY_ENV_OWNERS: "dev",
				WORKFLOWY_API_KEY: "fake-key-value",
				WORKFLOWY_API_URL: "http://upstream.test",
				WORKFLOWY_USERNAME: "owner@example.com",
				WORKFLOWY_PASSWORD: "fake-password",
				WORKFLOWY_SESSION_COOKIE: "sessionid=owner",
			},
			{
				outboundService: (request: Request): Response => {
					const url = new URL(request.url);
					calls.push({
						method: request.method,
						path: url.pathname,
						auth: request.headers.get("authorization"),
					});
					return Response.json({error: "unexpected"}, {status: 500});
				},
			},
		);
	}, 60_000);
	afterAll(async () => {
		await harness.dispose();
	});

	async function named(name: string): Promise<DurableObjectStub<UserStore>> {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await harness.mf.getDurableObjectNamespace(
			"USER_STORE",
		)) as unknown as DurableObjectNamespace<UserStore>;
		return ns.getByName(name);
	}

	it("knows each object's own name and whether it mirrors workflowy.com", async () => {
		const owner = await (await named("dev")).adminStatus();
		const other = await (await named("user-123")).adminStatus();
		expect({storeName: owner.storeName, mode: owner.mode}).toStrictEqual({storeName: "dev", mode: "mirror"});
		expect({storeName: other.storeName, mode: other.mode}).toStrictEqual({
			storeName: "user-123",
			mode: "standalone",
		});
	});

	it("writes through to the upstream from the owner's object", async () => {
		calls.length = 0;
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes", {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({parent_id: "None", name: "owner write"}),
		});
		await response.arrayBuffer();
		// The fake fails the first read, which is enough to show the owner's key went upstream.
		expect(calls).toStrictEqual([{method: "GET", path: "/api/v1/nodes", auth: "Bearer fake-key-value"}]);
	});

	it("refuses a create from another object without touching the upstream", async () => {
		calls.length = 0;
		const result = await storeClient(await named("user-123")).call("nodes.create", {
			parent_id: "None",
			name: "not mine",
		});
		expect(plain(result)).toStrictEqual({
			ok: false,
			status: 500,
			body: {error: "WORKFLOWY_API_KEY environment variable is required"},
		});
		expect(calls).toStrictEqual([]);
	});

	it("never syncs another object from workflowy.com", async () => {
		calls.length = 0;
		const stub = await named("user-123");
		expect([plain(await stub.syncNow()), plain(await stub.seedTree())]).toStrictEqual([
			{state: "disabled"},
			{state: "disabled"},
		]);
		expect(calls).toStrictEqual([]);
	});

	it("keeps the owner's session cookie out of another object", async () => {
		const response = await (await named("user-123")).fetch("http://localhost/__session");
		await expect(readJson(response)).resolves.toStrictEqual({cookie: null});
	});
});
