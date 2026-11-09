import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {storeTreeTxId} from "@workflowy/shared/cache";
import {callTool, openHarness, seed as seedNode} from "./harness.js";
import type {Harness} from "./harness.js";

const INIT_BODY = {
	projectTreeData: {
		mainProjectTreeInfo: {
			dateJoinedTimestampInSeconds: 1_300_000_000,
			initialMostRecentOperationTransactionId: "1234567",
			ownerId: 42,
		},
		rootProjectMetadata: {},
	},
	settings: {},
	user: {id: 42},
	globals: [["CLIENT_VERSION", 25]],
};

/** The internal init and an empty catch-up poll a backlink sync starts with, or `undefined` for any other path. */
function catchUpResponse(pathname: string): Response | undefined {
	if (pathname === "/get_initialization_data") {
		return Response.json(INIT_BODY, {headers: {wfclientid: "2026-10-18 12:00:00.123456"}});
	}
	if (pathname === "/push_and_poll") {
		return Response.json({
			results: [
				{
					new_most_recent_operation_transaction_id: "1234568",
					server_run_operation_transaction_json: JSON.stringify({ops: [], client_timestamp: 492_324_800}),
					concurrent_remote_operation_transactions: [],
					error_encountered_in_remote_operations: false,
				},
			],
		});
	}
	return undefined;
}

const LINK = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

let harness: Harness;

beforeAll(() => {
	harness = openHarness("workflowy-mcp-backlinks-test-");
});

afterAll(() => {
	harness.restoreEnv();
});

function seed(id: string, name: string, parentId: string | null = null, note: string | null = null): void {
	seedNode(harness.cache, id, name, parentId, note);
}

/**
 * Answers the public API with `node` for every read and write, and the
 * internal login, init and an empty catch-up poll; records each push.
 */
function stubApis(node: {id: string; name: string; note: string | null}): string[] {
	const internal: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/push_and_poll") {
			internal.push(`${init?.method ?? "GET"} ${url.pathname}`);
		}
		if (url.pathname === "/ajax_login") {
			return Promise.resolve(new Response("", {status: 200, headers: {"set-cookie": "sessionid=abc; Path=/"}}));
		}
		const internalResponse = catchUpResponse(url.pathname);
		if (internalResponse !== undefined) {
			return Promise.resolve(internalResponse);
		}
		if (url.pathname === "/api/v1/nodes/") {
			return Promise.resolve(Response.json({item_id: node.id}));
		}
		if (url.searchParams.has("parent_id")) {
			return Promise.resolve(Response.json({nodes: []}));
		}
		if (init?.method === "POST" || init?.method === "DELETE") {
			return Promise.resolve(Response.json({status: "ok"}));
		}
		return Promise.resolve(Response.json({node: {...node, priority: 0, createdAt: 0, modifiedAt: 0}}));
	});
	return internal;
}

/**
 * Like {@link stubApis}, for an internal-API create under `parentId`: answers the parent's children with each node a
 * `bulk_create` push made, named `name`; records each push.
 */
function stubCreate(parentId: string, name: string): string[] {
	const internal: string[] = [];
	const created: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/push_and_poll") {
			internal.push(`${init?.method ?? "GET"} ${url.pathname}`);
			const body = decodeURIComponent(typeof init?.body === "string" ? init.body : "");
			if (body.includes("bulk_create")) {
				created.push(...[...body.matchAll(/\\?"id\\?":\\?"([0-9a-f-]{36})/gu)].map((match) => match[1]!));
			}
		}
		if (url.pathname === "/ajax_login") {
			return Promise.resolve(new Response("", {status: 200, headers: {"set-cookie": "sessionid=abc; Path=/"}}));
		}
		const internalResponse = catchUpResponse(url.pathname);
		if (internalResponse !== undefined) {
			return Promise.resolve(internalResponse);
		}
		const node = (id: string) => ({
			id,
			name,
			note: null,
			parent_id: parentId,
			priority: 0,
			createdAt: 0,
			modifiedAt: 0,
		});
		const read = /^\/api\/v1\/nodes\/([^/]+)$/u.exec(url.pathname)?.[1];
		if (read !== undefined) {
			return Promise.resolve(
				created.includes(read) ? Response.json({node: node(read)}) : new Response("not found", {status: 404}),
			);
		}
		return Promise.resolve(
			Response.json({nodes: url.searchParams.get("parent_id") === parentId ? created.map(node) : []}),
		);
	});
	return internal;
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
	const result = await callTool(harness.authStore, name, args);
	return result.isError === true ? result : undefined;
}

/** One push: the adapter logs in and reads the tree once per context, so only the pushes tell a sync from none. */
const SYNCED = ["POST /push_and_poll"];

describe("MCP node tools backlinks", () => {
	beforeEach(() => {
		storeTreeTxId(harness.db, "1234567");
	});

	it("syncs a created node's backlinks when its text links to a node", async () => {
		seed("parent-1", "Parent");
		const internal = stubCreate("parent-1", `see ${LINK}`);

		const error = await call("outlinedb_node_create", {parentId: "parent-1", name: `see ${LINK}`});

		expect({error, internal}).toStrictEqual({error: undefined, internal: [...SYNCED, ...SYNCED]});
	});

	it("leaves the backlinks alone when a created node links nowhere", async () => {
		seed("parent-2", "Parent");
		const internal = stubCreate("parent-2", "plain");

		const error = await call("outlinedb_node_create", {parentId: "parent-2", name: "plain"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: SYNCED});
	});

	it("syncs an updated node's backlinks when its old text linked and the new one does not", async () => {
		seed("source-3", `see ${LINK}`);
		const internal = stubApis({id: "source-3", name: "plain", note: null});

		const error = await call("outlinedb_node_update", {id: "source-3", name: "plain"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: SYNCED});
	});

	it("leaves the internal API alone when an update adds or removes no link", async () => {
		seed("source-4", "Old");
		const internal = stubApis({id: "source-4", name: "plain", note: null});

		const error = await call("outlinedb_node_update", {id: "source-4", name: "plain"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: []});
	});

	it("deletes the backlink items of a deleted subtree's linked sources", async () => {
		seed("delete-5", "root");
		seed("linked-5", "child", "delete-5", LINK);
		const internal = stubApis({id: "delete-5", name: "root", note: null});

		const error = await call("outlinedb_node_delete", {id: "delete-5"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: SYNCED});
	});

	it("leaves the internal API alone when nothing in a deleted subtree links anywhere", async () => {
		seed("delete-6", "plain");
		const internal = stubApis({id: "delete-6", name: "plain", note: null});

		const error = await call("outlinedb_node_delete", {id: "delete-6"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: []});
	});
});
