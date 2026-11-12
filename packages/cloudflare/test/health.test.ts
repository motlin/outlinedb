import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

describe("worker /health", () =>
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

	it("answers an unrouted API path with 404 from the Worker, not from the Durable Object", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/decisions/meetings");
		expect(
			{
				status: response.status,
				body: await response.text(),
			},
		).toStrictEqual(
			{
				status: 404,
				body: "Not found",
			},
		);
	});

	it("returns 200 with status ok", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/health");
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toStrictEqual(
			{
				status: "ok",
			},
		);
	});
});

describe("worker access gate", () =>
{
	let harness: Harness;

	beforeAll(async () =>
	{
		harness = await startHarness("../src/worker.ts", "UserStore", undefined, {});
	}, 60_000);

	afterAll(async () =>
	{
		await harness.dispose();
	});

	it("rejects API requests without a token when the dev bypass is unset", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes");
		expect(response.status).toBe(401);
		const health = await harness.mf.dispatchFetch("http://localhost/health");
		expect(health.status).toBe(401);
	});

	it("rejects a garbage token with 403 once Access is configured", async () =>
	{
		const configured = await startHarness(
			"../src/worker.ts",
			"UserStore",
			undefined,
			{
				ACCESS_TEAM_DOMAIN: "team.example.com",
				ACCESS_AUD: "aud",
				ALLOWED_EMAILS: "a@example.com",
			},
		);
		try
		{
			const response = await configured.mf.dispatchFetch(
				"http://localhost/api/v1/nodes",
				{
					headers:
					{
						"Cf-Access-Jwt-Assertion": "not-a-jwt",
					},
				},
			);
			expect(response.status).toBe(403);
		}
		finally
		{
			await configured.dispose();
		}
	}, 60_000);
});
