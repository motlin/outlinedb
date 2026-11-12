import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

describe("worker /api/openapi.json", () =>
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

	it("serves the OpenAPI document for the migrated routes", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/api/openapi.json");
		const body = (await response.json()) as
		{
			openapi: string;
			paths: Record<
				string,
				Record<
					string,
					{
						operationId: string;
					}
				>
			>;
		};

		expect(
			{
				status: response.status,
				openapi: body.openapi,
				getNode: body.paths["/api/v1/nodes/{id}"]?.get?.operationId,
			},
		).toStrictEqual(
			{
				status: 200,
				openapi: "3.1.0",
				getNode: "nodes.get",
			},
		);
	});

	it("serves the API docs page", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/api/docs");

		expect(
			{
				status: response.status,
				type: response.headers.get("content-type"),
			},
		).toStrictEqual(
			{
				status: 200,
				type: "text/html; charset=UTF-8",
			},
		);
	});
});
