import {afterAll, afterEach, beforeAll, describe, expect, inject, it, vi} from "vite-plus/test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {storeInternalMetadata} from "@workflowy/shared/cache";
import {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {registerCalendarTools} from "../src/tools/calendar-tools.js";
import {registerNodeTools} from "../src/tools/node-tools.js";
import {getCacheService, getDatabase} from "../src/services.js";

declare module "vitest" {
	export interface ProvidedContext {
		/** Provided by packages/cli/test/setup/migrated-template.ts, the run-wide global setup. */
		migratedDatabaseTemplate: string;
	}
}

const originalEnv = {...process.env};
let tempDir: string;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-mcp-calendar-test-"));
	const dbPath = path.join(tempDir, "test.sqlite");
	fs.copyFileSync(inject("migratedDatabaseTemplate"), dbPath);
	process.env.WORKFLOWY_DB_PATH = dbPath;
	process.env.WORKFLOWY_SKIP_MIGRATIONS = "true";
	process.env.WORKFLOWY_API_KEY = "test-api-key";
	process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "no-session");

	const cache = getCacheService();
	const insert = (id: string, name: string, parentId: string | null, calendar?: unknown) => {
		cache.insertNode({id, name, note: null, priority: 0, createdAt: 0, modifiedAt: 0, completedAt: null}, parentId);
		if (calendar !== undefined) {
			storeInternalMetadata(getDatabase(), new Map([[id, {calendar}]]));
		}
	};
	insert("cal", "📆 Calendar", null, {root: true, levels: {year: true, month: true, day: true}});
	insert("y2026", "2026", "cal", {level: "year", value: "2026", timestamp: 0, dateId: 20_260_000});
	insert("m01", "01", "y2026", {level: "month", value: "1", timestamp: 0, dateId: 20_260_100});
	insert("outer", '<time startYear="2026" startMonth="1" startDay="15">Thu, Jan 15, 2026</time>', "m01");
	insert("d14", '<time startYear="2026" startMonth="1" startDay="14">Wed, Jan 14, 2026</time>', "m01", {
		level: "day",
		value: "14",
		timestamp: 0,
		dateId: 20_260_114,
	});
	insert("kid", "Gym", "d14");
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.WORKFLOWY_USERNAME;
	delete process.env.WORKFLOWY_PASSWORD;
});

afterAll(() => {
	process.env = originalEnv;
	fs.rmSync(tempDir, {recursive: true, force: true});
});

async function callDay(args: Record<string, unknown>) {
	const server = new McpServer({name: "workflowy", version: "0.1.0"});
	registerCalendarTools(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({name: "test", version: "0.0.0"});
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const result = await client.callTool({name: "workflowy_calendar_day", arguments: args});
		return {isError: result.isError, content: result.content};
	} finally {
		await client.close();
	}
}

describe("workflowy_calendar_day", () => {
	it("finds a tagged day without calling ensure", async () => {
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");

		const result = await callDay({date: "2026-01-14", ensure: true});

		expect({result, calls: ensure.mock.calls}).toStrictEqual({
			result: {
				isError: undefined,
				content: [
					{type: "text", text: JSON.stringify({id: "d14", created: false, firstChildId: "kid"}, null, 2)},
				],
			},
			calls: [],
		});
	});

	it("ensures a missing day through the adapter and returns its result", async () => {
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		const ensure = vi
			.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay")
			.mockResolvedValue({dayId: "v5day", firstChildId: "kid2", created: ["v5day", "kid2"]});

		const result = await callDay({date: "2026-10-22", ensure: true});

		expect({result, calls: ensure.mock.calls}).toStrictEqual({
			result: {
				isError: undefined,
				content: [
					{type: "text", text: JSON.stringify({id: "v5day", created: true, firstChildId: "kid2"}, null, 2)},
				],
			},
			calls: [[20_261_022, {stopAt: "day", createChild: true}]],
		});
	});

	it("errors without internal auth and makes no call", async () => {
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");

		const result = await callDay({date: "2026-10-22", ensure: true});

		expect({result, calls: ensure.mock.calls}).toStrictEqual({
			result: {
				isError: true,
				content: [
					{
						type: "text",
						text: "Calendar day ensure needs internal API auth (WORKFLOWY_USERNAME/WORKFLOWY_PASSWORD or a saved session)",
					},
				],
			},
			calls: [],
		});
	});

	it("treats a name-only day as missing without ensure", async () => {
		const result = await callDay({date: "2026-01-15"});

		expect(result).toStrictEqual({
			isError: true,
			content: [{type: "text", text: "No 📆 Calendar day for 2026-01-15 (pass ensure: true)"}],
		});
	});
});

describe("workflowy_node_create under a calendar month", () => {
	const name = '<time startYear="2026" startMonth="1" startDay="21">Wed, Jan 21, 2026</time>';

	function stubPublicApi(): void {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === "/api/v1/nodes/") {
				return Promise.resolve(Response.json({item_id: "new-day"}));
			}
			if (url.searchParams.has("parent_id")) {
				return Promise.resolve(Response.json({nodes: []}));
			}
			const node = {id: "new-day", name, note: null, parent_id: "m01", priority: 0, createdAt: 0, modifiedAt: 0};
			return Promise.resolve(Response.json(init?.method === "POST" ? {status: "ok"} : {node}));
		});
	}

	async function createUnderMonth() {
		const server = new McpServer({name: "workflowy", version: "0.1.0"});
		registerNodeTools(server);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({name: "test", version: "0.0.0"});
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			return await client.callTool({name: "workflowy_node_create", arguments: {parentId: "m01", name}});
		} finally {
			await client.close();
		}
	}

	it("tags the new row as that day through the adapter", async () => {
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		stubPublicApi();
		const setMeta = vi.spyOn(WorkflowyInternalAdapter.prototype, "setNodeMetaValues").mockResolvedValue();

		await createUnderMonth();

		expect(setMeta.mock.calls).toStrictEqual([
			[
				"new-day",
				[
					{
						path: ["calendar"],
						value: {
							level: "day",
							value: "21",
							timestamp: new Date(2026, 0, 21).getTime(),
							dateId: 20_260_121,
						},
					},
				],
			],
		]);
	});

	it("returns a warning without internal auth", async () => {
		stubPublicApi();

		const result = await createUnderMonth();

		expect(JSON.parse((result.content as {text: string}[])[0]!.text)).toMatchObject({
			warning: expect.stringContaining("workflowy.com will not use it as that day"),
		});
	});
});
