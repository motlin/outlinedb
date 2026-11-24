import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

describe("the nodes events WebSocket on the Durable Object", () =>
{
	let h: Harness;
	beforeAll(async () =>
	{
		h = await startHarness("../src/worker.ts");
	}, 120_000);
	afterAll(async () =>
	{
		await h.dispose();
	});

	it("rejects a non-upgrade request to the events path", async () =>
	{
		const response = await h.mf.dispatchFetch("http://localhost/api/v1/nodes/events");
		await response.arrayBuffer();
		expect(response.status).toBe(426);
	});
});
