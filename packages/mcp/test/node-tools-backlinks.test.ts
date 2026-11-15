import {afterAll, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import {callTool, openHarness, seed as seedNode} from "./harness.js";
import type {Harness} from "./harness.js";

/** A cached link target; links address it by its last 12 hex digits. */
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-0123456789ab";
const LINK = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

let harness: Harness;

beforeAll(() =>
{
	harness = openHarness("outlinedb-mcp-backlinks-test-");
});

afterAll(() =>
{
	harness.restoreEnv();
});

function seed(id: string, name: string, parentId: string | null = null, note: string | null = null): void
{
	seedNode(harness.cache, id, name, parentId, note);
}

/** The node tools write locally in mirror mode: any upstream request fails the test. */
function forbidUpstream()
{
	return vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("unexpected fetch: a mirror-mode node tool called upstream"));
}

async function call(name: string, args: Record<string, unknown>): Promise<string>
{
	const result = await callTool(harness.authStore, name, args);
	const [content] = result.content as
	{
		text: string;
	}[];
	return result.isError === true ? `error: ${content?.text ?? ""}` : (content?.text ?? "");
}

/** Each backlink item under the target's references root, as its original (source) id. */
function backlinkSources(): (string | null)[]
{
	return harness.cache
		.getChildren(TARGET)
		.flatMap((root) => harness.cache.getChildren(root.id))
		.map((item) => harness.cache.getMirrorOriginal(item.id));
}

describe("MCP node tools backlinks", () =>
{
	it("syncs backlinks locally when a node is created, updated and deleted, without calling upstream", async () =>
	{
		const fetch = forbidUpstream();
		seed(TARGET, "Target");
		seed("parent-1", "Parent");

		const created = JSON.parse(
			await call(
				"outlinedb_node_create",
				{
					parentId: "parent-1",
					name: `see ${LINK}`,
				},
			),
		) as
		{
			id: string;
		};
		const afterCreate = backlinkSources();
		await call(
			"outlinedb_node_update",
			{
				id: created.id,
				name: "plain",
			},
		);
		const afterUnlink = backlinkSources();
		await call(
			"outlinedb_node_update",
			{
				id: created.id,
				name: `again ${LINK}`,
			},
		);
		const afterRelink = backlinkSources();
		await call(
			"outlinedb_node_delete",
			{
				id: "parent-1",
			},
		);

		expect(
			{
				afterCreate,
				afterUnlink,
				afterRelink,
				afterDelete: backlinkSources(),
				fetches: fetch.mock.calls.length,
			},
		).toStrictEqual(
			{
				afterCreate: [created.id],
				afterUnlink: [],
				afterRelink: [created.id],
				afterDelete: [],
				fetches: 0,
			},
		);
	});
});
