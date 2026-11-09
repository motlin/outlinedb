import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vite-plus/test";
import {callTool, connectClient, openHarness} from "./harness.js";
import type {Harness} from "./harness.js";
import {fakeNode, stubPublicApi} from "./fake-upstream.js";
import type {FakeNode} from "./fake-upstream.js";

let harness: Harness;

const OUTLINE: FakeNode[] = [
	fakeNode("work", "Work", null),
	fakeNode("projects", "Projects", "work"),
	fakeNode("alpha", "Alpha project", "projects"),
	fakeNode("beta", "Beta project", "projects", 1),
];

beforeAll(() => {
	harness = openHarness("outlinedb-mcp-tools-test-");
});

beforeEach(() => {
	for (const node of OUTLINE) {
		harness.cache.insertNode(node, node.parent_id);
	}
});

afterAll(() => {
	harness.restoreEnv();
});

function text(result: {content: unknown}): string {
	return (result.content as {text: string}[])[0]?.text ?? "";
}

/** A tool's JSON with each version timestamp (`systemFrom`, the wall-clock time a row was written) masked. */
function stableJson(result: {content: unknown}): unknown {
	return JSON.parse(text(result), (key, value: unknown) => (key === "systemFrom" ? "<systemFrom>" : value));
}

describe("MCP tools over a store", () => {
	it("advertises every tool with its name, description and input schema", async () => {
		const client = await connectClient(harness.store);
		try {
			const {tools} = await client.listTools();
			expect(tools).toMatchSnapshot();
		} finally {
			await client.close();
		}
	});

	it("parses tool arguments before invoking the handler", async () => {
		await expect(callTool(harness.store, "outlinedb_search", {query: "   "})).resolves.toStrictEqual({
			isError: true,
			content: [{type: "text", text: "Query cannot be empty"}],
		});
	});

	it("gets a node by path in the NodeTreeReader shape", async () => {
		stubPublicApi(OUTLINE);

		const result = await callTool(harness.store, "outlinedb_node_get", {path: "Work,Projects"});

		expect({isError: result.isError, node: stableJson(result)}).toMatchSnapshot();
	});

	it("reports an unknown path as an error", async () => {
		stubPublicApi(OUTLINE);

		await expect(callTool(harness.store, "outlinedb_node_get", {path: "Work,Nowhere"})).resolves.toStrictEqual({
			isError: true,
			content: [{type: "text", text: "Node not found at path: Work > Nowhere"}],
		});
	});

	it("lists a parent's children to the requested depth", async () => {
		stubPublicApi(OUTLINE);

		const result = await callTool(harness.store, "outlinedb_node_list", {parentPath: "Work", depth: 2});

		expect({isError: result.isError, nodes: stableJson(result)}).toMatchSnapshot();
	});

	it("creates a node under a path it creates", async () => {
		const upstream = stubPublicApi(OUTLINE);

		const result = await callTool(harness.store, "outlinedb_node_create", {
			parentPath: "Work,Ideas",
			createPath: true,
			name: "Write the plan",
			note: "soon",
		});

		expect({
			result: {isError: result.isError, value: JSON.parse(text(result))},
			created: [...upstream.values()]
				.filter((node) => node.id.startsWith("created-"))
				.map(({id, name, note, parent_id: parentId}) => ({id, name, note, parentId})),
		}).toStrictEqual({
			result: {
				isError: undefined,
				value: {
					id: "created-2",
					name: "Write the plan",
					createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
					url: "https://workflowy.com/#/created2",
				},
			},
			created: [
				{id: "created-1", name: "Ideas", note: null, parentId: "work"},
				{id: "created-2", name: "Write the plan", note: "soon", parentId: "created-1"},
			],
		});
	});

	it("updates a node's name", async () => {
		stubPublicApi(OUTLINE);

		const result = await callTool(harness.store, "outlinedb_node_update", {id: "alpha", name: "Alpha 2"});

		expect({isError: result.isError, value: JSON.parse(text(result))}).toStrictEqual({
			isError: undefined,
			value: {id: "alpha", name: "Alpha 2", note: null},
		});
	});

	it("completes and uncompletes a node", async () => {
		stubPublicApi(OUTLINE);

		const completed = await callTool(harness.store, "outlinedb_node_complete", {id: "alpha"});
		const uncompleted = await callTool(harness.store, "outlinedb_node_uncomplete", {id: "alpha"});

		expect({completed, uncompleted}).toStrictEqual({
			completed: {
				isError: undefined,
				content: [{type: "text", text: "Successfully completed node: Alpha project (alpha)"}],
			},
			uncompleted: {
				isError: undefined,
				content: [{type: "text", text: "Successfully uncompleted node: Alpha project (alpha)"}],
			},
		});
	});

	it("moves a node to the top of a parent found by path", async () => {
		const upstream = stubPublicApi(OUTLINE);

		const result = await callTool(harness.store, "outlinedb_node_move", {
			nodeId: "beta",
			parentPath: "Work",
			position: "top",
		});

		expect({result, parentId: upstream.get("beta")?.parent_id}).toStrictEqual({
			result: {
				isError: undefined,
				content: [{type: "text", text: "Successfully moved node: Beta project (beta)"}],
			},
			parentId: "work",
		});
	});

	it("deletes a node", async () => {
		const upstream = stubPublicApi(OUTLINE);

		const result = await callTool(harness.store, "outlinedb_node_delete", {id: "beta"});

		expect({result, deleted: !upstream.has("beta")}).toStrictEqual({
			result: {isError: undefined, content: [{type: "text", text: "Successfully deleted node: beta"}]},
			deleted: true,
		});
	});

	it("searches node text", async () => {
		const result = await callTool(harness.store, "outlinedb_search", {query: "Alpha project"});

		expect({isError: result.isError, value: JSON.parse(text(result))}).toStrictEqual({
			isError: undefined,
			value: [
				{
					id: "alpha",
					name: "Alpha project",
					note: null,
					parentPath: "Work > Projects",
					completedAt: null,
					url: "https://workflowy.com/#/alpha",
				},
			],
		});
	});

	it("reports cache counts", async () => {
		const result = await callTool(harness.store, "outlinedb_cache_status", {});

		expect({isError: result.isError, value: JSON.parse(text(result))}).toStrictEqual({
			isError: undefined,
			value: {
				totalNodes: expect.any(Number),
				rootNodes: expect.any(Number),
				completedNodes: expect.any(Number),
				lastSync: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
				lastBackupImport: null,
			},
		});
	});
});
