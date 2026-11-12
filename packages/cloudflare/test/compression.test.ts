import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

describe("compressed API responses through the Worker", () =>
{
	let harness: Harness;

	beforeAll(async () =>
	{
		harness = await startHarness("../src/worker.ts");
	}, 60_000);

	afterAll(async () =>
	{
		await harness.dispose();
	});

	it("are compressed exactly once, so a client that decodes gzip reads plain JSON", async () =>
	{
		const response = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/features",
			{
				headers:
				{
					"accept-encoding": "gzip",
				},
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		const body = await response.json();
		expect(body).toMatchObject({});
	});
});
