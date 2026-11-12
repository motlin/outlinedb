import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {connectClient, openHarness, seed} from "./harness.js";
import type {Harness} from "./harness.js";
import {stubPublicApi} from "./fake-upstream.js";

let harness: Harness;

beforeAll(() =>
{
	harness = openHarness("outlinedb-mcp-read-only-test-");
	seed(harness.cache, "work", "Work");
	seed(harness.cache, "plan", "Plan the trip", "work");
});

afterAll(() =>
{
	harness.restoreEnv();
});

async function readOnlyCall(
	name: string,
	args: Record<string, unknown>,
	store = harness.store,
): Promise<
{
	isError: unknown;
	content: unknown;
}>
{
	const client = await connectClient(
		store,
		{
			readOnly: true,
		},
	);
	try
	{
		const result = await client.callTool(
			{
				name,
				arguments: args,
			},
		);
		return {
			isError: result.isError,
			content: result.content,
		};
	}
	finally
	{
		await client.close();
	}
}

describe("read-only tool access", () =>
{
	it("lists only the tools that read the outline", async () =>
	{
		const client = await connectClient(
			harness.store,
			{
				readOnly: true,
			},
		);
		try
		{
			const {tools} = await client.listTools();
			expect(tools.map((tool) => tool.name).toSorted()).toStrictEqual([
				"outlinedb_cache_status",
				"outlinedb_calendar_day",
				"outlinedb_node_changes",
				"outlinedb_node_get",
				"outlinedb_node_list",
				"outlinedb_search",
			]);
		}
		finally
		{
			await client.close();
		}
	});

	it("still reads the outline", async () =>
	{
		stubPublicApi([]);

		const result = await readOnlyCall(
			"outlinedb_search",
			{
				query: "trip",
			},
		);

		expect(result.isError).toBeUndefined();
		expect(
			JSON.parse(
				(
					result.content as
					{
						text: string;
					}[]
				)[0]?.text ?? "",
			),
		).toStrictEqual([
			{
				id: "plan",
				name: "Plan the trip",
				note: null,
				parentPath: "Work",
				completedAt: null,
				url: "https://workflowy.com/#/plan",
			},
		]);
	});

	it("answers a write tool with an error instead of running it", async () =>
	{
		await expect(
			readOnlyCall(
				"outlinedb_node_create",
				{
					parentId: "work",
					name: "Sneaky",
				},
			),
		).resolves.toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: "MCP error -32602: Tool outlinedb_node_create not found",
					},
				],
			},
		);
		expect(harness.cache.getChildren("work").map((node) => node.name)).toStrictEqual(["Plan the trip"]);
	});

	it("refuses to create a missing calendar day even with internal-API credentials", async () =>
	{
		const result = readOnlyCall(
			"outlinedb_calendar_day",
			{
				date: "2026-10-22",
				ensure: true,
			},
			harness.authStore,
		);

		await expect(result).resolves.toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: "Read-only access: calendar.ensure needs the mcp:write scope",
					},
				],
			},
		);
	});
});
