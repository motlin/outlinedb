import {afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi} from "vite-plus/test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {storeTreeTxId} from "@workflowy/shared/cache";
import {registerNodeTools} from "../src/tools/node-tools.js";
import {getCacheService, getDatabase} from "../src/services.js";

declare module "vitest" {
	export interface ProvidedContext {
		/** Provided by packages/cli/test/setup/migrated-template.ts, the run-wide global setup. */
		migratedDatabaseTemplate: string;
	}
}

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

const originalEnv = {...process.env};
let tempDir: string;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-mcp-backlinks-test-"));
	const dbPath = path.join(tempDir, "test.sqlite");
	fs.copyFileSync(inject("migratedDatabaseTemplate"), dbPath);
	process.env.WORKFLOWY_DB_PATH = dbPath;
	process.env.WORKFLOWY_SKIP_MIGRATIONS = "true";
	process.env.WORKFLOWY_API_KEY = "test-api-key";
	process.env.WORKFLOWY_USERNAME = "alice@example.com";
	process.env.WORKFLOWY_PASSWORD = "hunter2";
	process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
});

afterAll(() => {
	process.env = originalEnv;
	fs.rmSync(tempDir, {recursive: true, force: true});
});

async function connectClient(): Promise<Client> {
	const server = new McpServer({name: "workflowy", version: "0.1.0"});
	registerNodeTools(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({name: "test", version: "0.0.0"});
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function seed(id: string, name: string, parentId: string | null = null, note: string | null = null): void {
	getCacheService().insertNode(
		{id, name, note, priority: 0, createdAt: 0, modifiedAt: 0, completedAt: null},
		parentId,
	);
}

/**
 * Answers the public API with `node` for every read and write, and the
 * internal login, init and an empty catch-up poll; records each internal-API request.
 */
function stubApis(node: {id: string; name: string; note: string | null}): string[] {
	const internal: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (!url.pathname.startsWith("/api/v1/")) {
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

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
	const client = await connectClient();
	try {
		const result = await client.callTool({name, arguments: args});
		return result.isError === true ? result : undefined;
	} finally {
		await client.close();
	}
}

const SYNCED = ["POST /ajax_login", "GET /get_initialization_data", "POST /push_and_poll"];

describe("MCP node tools backlinks", () => {
	beforeEach(() => {
		fs.rmSync(path.join(tempDir, "workflowy-session"), {force: true});
		storeTreeTxId(getDatabase(), "1234567");
	});

	it("syncs a created node's backlinks when its text links to a node", async () => {
		seed("parent-1", "Parent");
		const internal = stubApis({id: "created-1", name: `see ${LINK}`, note: null});

		const error = await call("workflowy_node_create", {parentId: "parent-1", name: `see ${LINK}`});

		expect({error, internal}).toStrictEqual({error: undefined, internal: SYNCED});
	});

	it("leaves the internal API alone when a created node links nowhere", async () => {
		seed("parent-2", "Parent");
		const internal = stubApis({id: "created-2", name: "plain", note: null});

		const error = await call("workflowy_node_create", {parentId: "parent-2", name: "plain"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: []});
	});

	it("syncs an updated node's backlinks when its old text linked and the new one does not", async () => {
		seed("source-3", `see ${LINK}`);
		const internal = stubApis({id: "source-3", name: "plain", note: null});

		const error = await call("workflowy_node_update", {id: "source-3", name: "plain"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: SYNCED});
	});

	it("leaves the internal API alone when an update adds or removes no link", async () => {
		seed("source-4", "Old");
		const internal = stubApis({id: "source-4", name: "plain", note: null});

		const error = await call("workflowy_node_update", {id: "source-4", name: "plain"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: []});
	});

	it("deletes the backlink items of a deleted subtree's linked sources", async () => {
		seed("delete-5", "root");
		seed("linked-5", "child", "delete-5", LINK);
		const internal = stubApis({id: "delete-5", name: "root", note: null});

		const error = await call("workflowy_node_delete", {id: "delete-5"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: SYNCED});
	});

	it("leaves the internal API alone when nothing in a deleted subtree links anywhere", async () => {
		seed("delete-6", "plain");
		const internal = stubApis({id: "delete-6", name: "plain", note: null});

		const error = await call("workflowy_node_delete", {id: "delete-6"});

		expect({error, internal}).toStrictEqual({error: undefined, internal: []});
	});
});
