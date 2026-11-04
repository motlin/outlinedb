import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {startHarness} from "./harness";
import type {Harness} from "./harness";

const url = "http://localhost/mcp";
const headers = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
	"accept-encoding": "gzip",
	"mcp-protocol-version": "2025-06-18",
};

describe("/mcp in the Worker", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness("./probe-entry.ts", "ProbeStore");
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		await ns.get(ns.idFromName("dev")).fetch("http://localhost/__seed?name=Plan%20the%20remote%20MCP");
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	async function rpc(id: number, method: string, params: Record<string, unknown>) {
		const response = await h.mf.dispatchFetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({jsonrpc: "2.0", id, method, params}),
		});
		return {
			status: response.status,
			type: response.headers.get("content-type"),
			encoding: response.headers.get("content-encoding"),
			body: await response.text(),
		};
	}

	it("answers initialize, tools/list and tools/call workflowy_search with plain JSON over the stateless transport", async () => {
		const init = await rpc(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: {name: "test", version: "0"},
		});
		expect({status: init.status, type: init.type, encoding: init.encoding}).toStrictEqual({
			status: 200,
			type: "application/json",
			encoding: null,
		});
		expect(JSON.parse(init.body)).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {serverInfo: {name: "workflowy"}},
		});

		const list = await rpc(2, "tools/list", {});
		expect(list.status).toBe(200);
		const names: string[] = JSON.parse(list.body).result.tools.map((tool: {name: string}) => tool.name);
		expect(names.toSorted()).toStrictEqual([
			"workflowy_cache_status",
			"workflowy_calendar_day",
			"workflowy_node_changes",
			"workflowy_node_complete",
			"workflowy_node_create",
			"workflowy_node_delete",
			"workflowy_node_get",
			"workflowy_node_list",
			"workflowy_node_mirror",
			"workflowy_node_move",
			"workflowy_node_uncomplete",
			"workflowy_node_update",
			"workflowy_search",
		]);

		const call = await rpc(3, "tools/call", {name: "workflowy_search", arguments: {query: "remote"}});
		expect(call.status).toBe(200);
		const parsed = JSON.parse(call.body);
		expect(parsed.result.isError).toBeUndefined();
		expect(JSON.parse(parsed.result.content[0].text)).toStrictEqual([
			{
				id: "seed-node",
				name: "Plan the remote MCP",
				note: null,
				parentPath: "",
				completedAt: null,
				url: "https://workflowy.com/#/seednode",
			},
		]);
	});

	it("rejects GET and DELETE with 405, since stateless mode has no server-to-client stream", async () => {
		const get = await h.mf.dispatchFetch(url, {headers: {accept: "text/event-stream"}});
		const del = await h.mf.dispatchFetch(url, {method: "DELETE"});
		expect([get.status, del.status]).toStrictEqual([405, 405]);
	});
});

describe("/mcp behind Access", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness("../src/worker.ts", "UserStore", undefined, {
			ACCESS_TEAM_DOMAIN: "team.example.com",
			ACCESS_AUD: "aud",
			ALLOWED_EMAILS: "alice@example.com",
		});
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	it("returns 401 without an Access identity", async () => {
		const response = await h.mf.dispatchFetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {}}),
		});
		expect(response.status).toBe(401);
	});
});
