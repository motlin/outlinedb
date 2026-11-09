import {it, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import List from "../../../src/commands/node/list.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {z} from "zod";

const ListOutputSchema = z.array(z.looseObject({systemFrom: z.string().optional()}));

describe("node:list command", () => {
	let originalEnv: typeof process.env;
	let mockFetch: typeof globalThis.fetch;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = process.env;
		mockFetch = globalThis.fetch;

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;

		testDatabase.db.run("PRAGMA foreign_keys = OFF");
		testDatabase.db.delete(nodeContent).run();
		testDatabase.db.delete(nodeMetadata).run();
		testDatabase.db.run("PRAGMA foreign_keys = ON");
	});

	afterEach(() => {
		process.env = originalEnv;
		globalThis.fetch = mockFetch;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir)) {
			try {
				if (fs.existsSync(testDatabase.path)) {
					fs.unlinkSync(testDatabase.path);
				}
				fs.rmdirSync(tempDir);
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	describe("environment variable validation", () => {
		it("works without WORKFLOWY_API_KEY when cache is available", async () => {
			delete process.env.WORKFLOWY_API_KEY;

			const {stdout} = await captureOutput(async () => {
				await List.run(["--parent-id", "nonexistent-id"]);
			});

			expect(stdout).toBe("No nodes found in cache. Set WORKFLOWY_API_KEY to fetch from API.\n");
		});

		it("works with empty WORKFLOWY_API_KEY string", async () => {
			process.env.WORKFLOWY_API_KEY = "";

			const {stdout} = await captureOutput(async () => {
				await List.run(["--parent-id", "nonexistent-id"]);
			});

			expect(stdout).toBe("No nodes found in cache. Set WORKFLOWY_API_KEY to fetch from API.\n");
		});
	});

	describe("API request handling", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
		});

		it("makes request to correct URL without parent-id flag", async () => {
			let capturedUrl: string | undefined;
			globalThis.fetch = async (url: RequestInfo | URL) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				return Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "First node",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "Second node",
									priority: 1,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);
			};

			await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(capturedUrl).toBe("https://workflowy.com/api/v1/nodes");
		});

		it("resolves --parent-id inbox to the account's Inbox node, without caching an 'inbox' row", async () => {
			const now = "2026-01-01 00:00:00.000";
			const current = {systemFrom: now, systemTo: "9999-12-31 23:59:59"};
			testDatabase.db
				.insert(nodeContent)
				.values({id: "real-inbox-0000-41bd95477fbc", name: "Inbox", note: null, parentId: null, ...current})
				.run();
			testDatabase.db
				.insert(nodeMetadata)
				.values({nodeId: "real-inbox-0000-41bd95477fbc", shortId: "41bd95477fbc", priority: 0, ...current})
				.run();
			const capturedUrls: string[] = [];
			globalThis.fetch = async (url: RequestInfo | URL) => {
				capturedUrls.push(url instanceof Request ? url.url : String(url));
				return Promise.resolve(Response.json({nodes: []}, {status: 200}));
			};

			await captureOutput(async () => {
				await List.run(["--parent-id", "inbox", "--json"]);
			});

			expect({
				capturedUrls,
				ids: testDatabase.db.select({id: nodeContent.id}).from(nodeContent).all(),
			}).toStrictEqual({
				capturedUrls: ["https://workflowy.com/api/v1/nodes?parent_id=real-inbox-0000-41bd95477fbc"],
				ids: [{id: "real-inbox-0000-41bd95477fbc"}],
			});
		});

		it("makes request to correct URL with parent-id flag", async () => {
			let capturedUrl: string | undefined;
			globalThis.fetch = async (url: RequestInfo | URL) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				return Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "child1",
									name: "Child node 1",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "child2",
									name: "Child node 2",
									priority: 1,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);
			};

			await captureOutput(async () => {
				await List.run(["--parent-id", "parent123"]);
			});

			expect(capturedUrl).toBe("https://workflowy.com/api/v1/nodes?parent_id=parent123");
		});

		it("sends correct Authorization header", async () => {
			const capturedHeaders: Record<string, string> = {};
			globalThis.fetch = async (url: RequestInfo | URL, options?: globalThis.RequestInit) => {
				const headers = new Headers(options?.headers);
				for (const [key, value] of headers.entries()) {
					capturedHeaders[key] = value;
				}
				return Promise.resolve(Response.json({nodes: []}, {status: 200}));
			};

			await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(capturedHeaders).toStrictEqual({
				authorization: "Bearer test-api-key",
				"content-type": "application/json",
			});
		});
	});

	describe("successful responses", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
		});

		it("displays nodes correctly when API returns array", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "First node",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "Second node with special chars: áéíóú",
									priority: 1,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (2):\n  First node\n     🔗 https://workflowy.com/#/node1\n  Second node with special chars: áéíóú\n     🔗 https://workflowy.com/#/node2\n",
			);
		});

		it("displays empty list when API returns empty array", async () => {
			globalThis.fetch = async () => Promise.resolve(Response.json({nodes: []}, {status: 200}));

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe("Fetched fresh data from API\nNo nodes found\n");
		});

		it("handles nodes with empty name property", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Valid name",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "",
									priority: 1,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (2):\n  Valid name\n     🔗 https://workflowy.com/#/node1\n  \n     🔗 https://workflowy.com/#/node2\n",
			);
		});

		it("displays emoji indicators for nodes with notes", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Node with note",
									note: "This is a note",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "Node without note",
									note: null,
									priority: 1,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (2):\n  📝 Node with note\n     🔗 https://workflowy.com/#/node1\n  Node without note\n     🔗 https://workflowy.com/#/node2\n",
			);
		});

		it("displays emoji indicators for nodes with non-default layoutMode", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Todo node",
									priority: 0,
									completed: false,
									data: {layoutMode: "todo"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "Headings node",
									priority: 1,
									completed: false,
									data: {layoutMode: "headings"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node3",
									name: "Bullets node",
									priority: 2,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (3):\n  ☑️ Todo node\n     🔗 https://workflowy.com/#/node1\n  📋 Headings node\n     🔗 https://workflowy.com/#/node2\n  Bullets node\n     🔗 https://workflowy.com/#/node3\n",
			);
		});

		it("displays multiple emoji indicators when node has note and non-default layoutMode", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Todo with note",
									note: "Important note",
									priority: 0,
									completed: false,
									data: {layoutMode: "todo"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (1):\n  📝 ☑️ Todo with note\n     🔗 https://workflowy.com/#/node1\n",
			);
		});

		it("displays completion indicator along with note and layoutMode indicators", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Completed todo with note",
									note: "Done!",
									priority: 0,
									completed: true,
									data: {layoutMode: "todo"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: Date.now(),
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (1):\n  ✓ 📝 ☑️ Completed todo with note\n     🔗 https://workflowy.com/#/node1\n",
			);
		});

		it("displays backlinks indicator when node contains links to other nodes in name", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: 'Node with backlink <a href="https://workflowy.com/#/abc123">link</a>',
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "Node without backlink",
									priority: 1,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (2):\n  ↗️ Node with backlink link (https://workflowy.com/#/abc123)\n     🔗 https://workflowy.com/#/node1\n  Node without backlink\n     🔗 https://workflowy.com/#/node2\n",
			);
		});

		it("displays backlinks indicator when node contains links to other nodes in note", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Node with backlink in note",
									note: 'See also <a href="https://workflowy.com/#/xyz789">related node</a>',
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (1):\n  📝 ↗️ Node with backlink in note\n     🔗 https://workflowy.com/#/node1\n",
			);
		});

		it("displays backlinks indicator along with other indicators", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: 'Completed task with backlink <a href="https://workflowy.com/#/ref123">ref</a>',
									note: "Important note",
									priority: 0,
									completed: true,
									data: {layoutMode: "todo"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: Date.now(),
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (1):\n  ✓ 📝 ☑️ ↗️ Completed task with backlink ref (https://workflowy.com/#/ref123)\n     🔗 https://workflowy.com/#/node1\n",
			);
		});
	});

	describe("API error responses", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
		});

		it("falls back to cache when API returns 401 Unauthorized", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(new Response("Unauthorized", {status: 401, statusText: "Unauthorized"}));

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe("No nodes found\n");
		});

		it("falls back to cache when API returns 404 Not Found", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(new Response("Not Found", {status: 404, statusText: "Not Found"}));

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe("No nodes found\n");
		});

		it("falls back to cache when API returns 500 Internal Server Error", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					new Response("Internal Server Error", {status: 500, statusText: "Internal Server Error"}),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe("No nodes found\n");
		});
	});

	describe("network and parsing errors", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
		});

		it("falls back to cache when network request fails", async () => {
			globalThis.fetch = async () => Promise.reject(new Error("Network error: ECONNREFUSED"));

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe("No nodes found\n");
		});

		it("falls back to cache when response JSON is malformed", async () => {
			globalThis.fetch = async () => Promise.resolve(new Response("invalid json{", {status: 200}));

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe("No nodes found\n");
		});

		it("falls back to cache when fetch times out", async () => {
			globalThis.fetch = async () => Promise.reject(new Error("Request timeout"));

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe("No nodes found\n");
		});
	});

	describe("flag parsing", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
			globalThis.fetch = async () => Promise.resolve(Response.json({nodes: []}, {status: 200}));
		});

		it("accepts short flag -p for parent-id", async () => {
			let capturedUrl: string | undefined;
			globalThis.fetch = async (url: RequestInfo | URL) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				return Promise.resolve(Response.json({nodes: []}, {status: 200}));
			};

			await captureOutput(async () => {
				await List.run(["-p", "parent456"]);
			});

			expect(capturedUrl).toBe("https://workflowy.com/api/v1/nodes?parent_id=parent456");
		});

		it("handles parent-id with special characters", async () => {
			let capturedUrl: string | undefined;
			globalThis.fetch = async (url: RequestInfo | URL) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				return Promise.resolve(Response.json({nodes: []}, {status: 200}));
			};

			const specialParentId = "parent-with-dashes_and_underscores.and.dots";

			await captureOutput(async () => {
				await List.run(["--parent-id", specialParentId]);
			});

			expect(capturedUrl).toBe(`https://workflowy.com/api/v1/nodes?parent_id=${specialParentId}`);
		});

		it("handles UUID parent-id format", async () => {
			let capturedUrl: string | undefined;
			globalThis.fetch = async (url: RequestInfo | URL) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				return Promise.resolve(Response.json({nodes: []}, {status: 200}));
			};

			const uuidParentId = "61111c3a-e939-d4dc-1a8c-6bf42551caa3";

			await captureOutput(async () => {
				await List.run(["--parent-id", uuidParentId]);
			});

			expect(capturedUrl).toBe(`https://workflowy.com/api/v1/nodes?parent_id=${uuidParentId}`);
		});
	});

	describe("command metadata", () => {
		it("has correct description", () => {
			expect(List.description).toBe("List Workflowy nodes by parent node ID");
		});

		it("has correct examples", () => {
			expect(List.examples).toStrictEqual([
				"<%= config.bin %> <%= command.id %>",
				"<%= config.bin %> <%= command.id %> --parent-id abc123",
				"<%= config.bin %> <%= command.id %> --parent-id abc123 --force-refresh",
			]);
		});

		it("has correct flag configuration", () => {
			expect({
				parentId: {
					char: List.flags["parent-id"].char,
					description: List.flags["parent-id"].description,
				},
				forceRefresh: {
					char: List.flags["force-refresh"].char,
					default: List.flags["force-refresh"].default,
					description: List.flags["force-refresh"].description,
				},
				json: {
					char: List.flags.json.char,
					default: List.flags.json.default,
					description: List.flags.json.description,
				},
			}).toStrictEqual({
				parentId: {char: "p", description: "Parent node ID (omit for root nodes)"},
				forceRefresh: {
					char: "f",
					default: false,
					description: "Force refresh from API, ignoring cache",
				},
				json: {char: "j", default: false, description: "Output all node details in JSON format"},
			});
		});
	});

	describe("--incomplete flag", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
		});

		it("filters out completed nodes when --incomplete is set", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Incomplete task",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "Completed task",
									priority: 1,
									completed: true,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: Date.now(),
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh", "--incomplete"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (1):\n  Incomplete task\n     🔗 https://workflowy.com/#/node1\n",
			);
		});

		it("shows all nodes when --incomplete is not set", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Incomplete task",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: null,
								},
								{
									id: "node2",
									name: "Completed task",
									priority: 1,
									completed: true,
									data: {layoutMode: "bullets"},
									createdAt: Date.now(),
									modifiedAt: Date.now(),
									completedAt: Date.now(),
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh"]);
			});

			expect(stdout).toBe(
				"Fetched fresh data from API\nNodes (2):\n  Incomplete task\n     🔗 https://workflowy.com/#/node1\n  ✓ Completed task\n     🔗 https://workflowy.com/#/node2\n",
			);
		});
	});

	describe("JSON output", () => {
		beforeEach(() => {
			process.env.WORKFLOWY_API_KEY = "test-api-key";
		});

		it("outputs nodes as JSON when --json flag is set", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "First node",
									note: "Test note",
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: 1_234_567_890,
									modifiedAt: 1_234_567_900,
									completedAt: null,
								},
								{
									id: "node2",
									name: "Second node",
									note: null,
									priority: 1,
									completed: true,
									data: {layoutMode: "todo"},
									createdAt: 1_234_567_800,
									modifiedAt: 1_234_567_850,
									completedAt: 1_234_567_860,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh", "--json"]);
			});

			const lines = stdout.split("\n");
			const jsonStart = lines.indexOf("[");
			const jsonLines = lines.slice(jsonStart);
			const jsonOutput = jsonLines.join("\n");
			const parsed = ListOutputSchema.parse(JSON.parse(jsonOutput));

			// Delete dynamic systemFrom field before deep equality comparison
			for (const node of parsed) {
				delete node.systemFrom;
			}

			expect(parsed).toStrictEqual([
				{
					id: "node1",
					shortId: "node1",
					name: "First node",
					note: "Test note",
					parentId: null,
					priority: 0,
					createdAt: "2009-02-13T23:31:30.000Z",
					modifiedAt: "2009-02-13T23:31:40.000Z",
					completedAt: null,
					layoutMode: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemTo: "9999-12-31 23:59:59",
					inChat: false,
					hasReferencesRoot: false,
				},
				{
					id: "node2",
					shortId: "node2",
					name: "Second node",
					note: null,
					parentId: null,
					priority: 1,
					createdAt: "2009-02-13T23:30:00.000Z",
					modifiedAt: "2009-02-13T23:30:50.000Z",
					completedAt: "2009-02-13T23:31:00.000Z",
					layoutMode: "todo",
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemTo: "9999-12-31 23:59:59",
					inChat: false,
					hasReferencesRoot: false,
				},
			]);
		});

		it("accepts short flag -j for JSON output", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Test node",
									note: null,
									priority: 0,
									completed: false,
									data: {layoutMode: "bullets"},
									createdAt: 1_234_567_890,
									modifiedAt: 1_234_567_900,
									completedAt: null,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh", "-j"]);
			});

			const lines = stdout.split("\n");
			const jsonStart = lines.indexOf("[");
			const jsonLines = lines.slice(jsonStart);
			const jsonOutput = jsonLines.join("\n");
			const parsed = ListOutputSchema.parse(JSON.parse(jsonOutput));

			// Delete dynamic systemFrom field before deep equality comparison
			for (const node of parsed) {
				delete node.systemFrom;
			}

			expect(parsed).toStrictEqual([
				{
					id: "node1",
					shortId: "node1",
					parentId: null,
					name: "Test node",
					note: null,
					priority: 0,
					layoutMode: null,
					createdAt: "2009-02-13T23:31:30.000Z",
					modifiedAt: "2009-02-13T23:31:40.000Z",
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemTo: "9999-12-31 23:59:59",
					inChat: false,
					hasReferencesRoot: false,
				},
			]);
		});

		it("does not include emoji indicators in JSON output", async () => {
			globalThis.fetch = async () =>
				Promise.resolve(
					Response.json(
						{
							nodes: [
								{
									id: "node1",
									name: "Completed todo with note",
									note: "Done!",
									priority: 0,
									completed: true,
									data: {layoutMode: "todo"},
									createdAt: 1_234_567_890,
									modifiedAt: 1_234_567_900,
									completedAt: 1_234_567_910,
								},
							],
						},
						{status: 200},
					),
				);

			const {stdout} = await captureOutput(async () => {
				await List.run(["--force-refresh", "--json"]);
			});

			const lines = stdout.split("\n");
			const jsonStart = lines.indexOf("[");
			const jsonLines = lines.slice(jsonStart);
			const jsonOutput = jsonLines.join("\n");
			const parsed = ListOutputSchema.parse(JSON.parse(jsonOutput));

			// Delete dynamic systemFrom field before deep equality comparison
			for (const node of parsed) {
				delete node.systemFrom;
			}

			expect(parsed).toStrictEqual([
				{
					id: "node1",
					shortId: "node1",
					parentId: null,
					name: "Completed todo with note",
					note: "Done!",
					priority: 0,
					layoutMode: "todo",
					createdAt: "2009-02-13T23:31:30.000Z",
					modifiedAt: "2009-02-13T23:31:40.000Z",
					completedAt: "2009-02-13T23:31:50.000Z",
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemTo: "9999-12-31 23:59:59",
					inChat: false,
					hasReferencesRoot: false,
				},
			]);
		});
	});
});
