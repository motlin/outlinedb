import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {mirrors, nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import Delete from "../../../src/commands/node/delete.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createApiNode, createTestNode} from "../../helpers/node-fixtures.js";
import {requestBody, requestJson} from "../../helpers/request-body.js";
import {z} from "zod";

const moveBodySchema = z.looseObject({parent_id: z.string(), position: z.enum(["top", "bottom"])});

describe("node delete command", () => {
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-delete-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";

		fetchStub = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = originalEnv;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	describe("environment variable validation", () => {
		it("requires WORKFLOWY_API_KEY", async () => {
			delete process.env.WORKFLOWY_API_KEY;

			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "node-id", name: "Test", parentId: null})]));

			await expect(Delete.run(["--id", "node-id"])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("flag validation", () => {
		it("requires either --id or --path", async () => {
			await expect(Delete.run([])).rejects.toThrow("Either --id or --path is required");
		});
	});

	describe("dry run mode", () => {
		it("shows API call without executing", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "node-id", name: "Test Node", parentId: null})]),
			);

			const {stdout} = await captureOutput(async () => {
				await Delete.run(["--id", "node-id", "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would execute API calls:\n  DELETE https://workflowy.com/api/v1/nodes/node-id\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n\nNode: Test Node\n\nWARNING: This will permanently delete the node and all its children!\n",
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("shows full path in dry run output", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "tasks-id", name: "Tasks", parentId: "work-id"}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Delete.run(["--id", "tasks-id", "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would execute API calls:\n  DELETE https://workflowy.com/api/v1/nodes/tasks-id\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n\nNode: Work > Tasks\n\nWARNING: This will permanently delete the node and all its children!\n",
			);
		});
	});

	describe("deleting by ID", () => {
		it("sends DELETE request to correct URL", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "delete-id", name: "To Delete", parentId: null})]),
			);

			let capturedUrl: string | undefined;
			let capturedMethod: string | undefined;
			fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				capturedMethod = init?.method;
				return Promise.resolve(Response.json({}, {status: 200}));
			});

			await captureOutput(async () => {
				try {
					await Delete.run(["--id", "delete-id"]);
				} catch {
					// Ignore errors from cache update
				}
			});

			expect(capturedUrl).toBe("https://workflowy.com/api/v1/nodes/delete-id");
			expect(capturedMethod).toBe("DELETE");
		});
	});

	describe("backlinks", () => {
		const LINK = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

		beforeEach(() => {
			process.env.WORKFLOWY_USERNAME = "alice@example.com";
			process.env.WORKFLOWY_PASSWORD = "hunter2";
			process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		});

		it("deletes the backlink items of the subtree's linked sources after the node is deleted", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "delete-id", name: `see ${LINK}`, parentId: null}),
					createTestNode({id: "plain-id", name: "plain", parentId: "delete-id"}),
					createTestNode({id: "linked-id", name: "child", note: LINK, parentId: "delete-id"}),
				]),
			);
			const order: string[] = [];
			fetchStub.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
				order.push(init?.method ?? "GET");
				return Promise.resolve(Response.json({}, {status: 200}));
			});
			const deleteBacklinks = vi
				.spyOn(WorkflowyInternalAdapter.prototype, "deleteBacklinksOf")
				.mockImplementation(async () => {
					order.push("backlinks");
					return Promise.resolve([]);
				});

			await captureOutput(async () => {
				await Delete.run(["--id", "delete-id"]);
			});

			expect({order, calls: deleteBacklinks.mock.calls}).toStrictEqual({
				order: ["DELETE", "backlinks"],
				calls: [[{ids: ["delete-id", "linked-id"], mirrors: []}]],
			});
		});

		it("leaves the internal API alone when nothing in the subtree links anywhere", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "delete-id", name: "plain", parentId: null})]),
			);
			fetchStub.mockImplementation(async () => Promise.resolve(Response.json({}, {status: 200})));
			const deleteBacklinks = vi.spyOn(WorkflowyInternalAdapter.prototype, "deleteBacklinksOf");

			await captureOutput(async () => {
				await Delete.run(["--id", "delete-id"]);
			});

			expect(deleteBacklinks.mock.calls).toStrictEqual([]);
		});
	});

	describe("deleting by path", () => {
		it("resolves path to correct node ID", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "tasks-id", name: "Tasks", parentId: "work-id"}),
					createTestNode({id: "target-id", name: "Old Task", parentId: "tasks-id"}),
				]),
			);

			let capturedUrl: string | undefined;
			fetchStub.mockImplementation(async (url: RequestInfo | URL, _init?: RequestInit) => {
				capturedUrl = url instanceof Request ? url.url : String(url);
				return Promise.resolve(Response.json({}, {status: 200}));
			});

			await captureOutput(async () => {
				try {
					await Delete.run(["--path", "Work,Tasks,Old Task"]);
				} catch {
					// Ignore errors from cache update
				}
			});

			expect(capturedUrl).toBe("https://workflowy.com/api/v1/nodes/target-id");
		});

		it("errors when path not found", async () => {
			// Cache is empty, API returns empty children for root (path not found)
			fetchStub.mockResolvedValue(Response.json({nodes: []}, {status: 200}));

			await expect(Delete.run(["--path", "Missing,Path"])).rejects.toThrow(
				"Node not found at path: Missing > Path",
			);
		});
	});

	describe("output", () => {
		it("displays full path when deleting", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "target-id", name: "Target", parentId: "work-id"}),
				]),
			);

			fetchStub.mockResolvedValue(Response.json({}, {status: 200}));

			const {stdout} = await captureOutput(async () => {
				try {
					await Delete.run(["--id", "target-id"]);
				} catch {
					// Ignore errors from cache update
				}
			});

			expect(stdout).toBe(
				"Deleting node: Work > Target\n\nWARNING: This will permanently delete the node and all its children!\n\nSuccessfully deleted node\n",
			);
		});
	});

	describe("mirrors", () => {
		beforeEach(() => {
			seedTestData(testDatabase, {
				...nodeFixtures([
					createTestNode({id: "projects-id", name: "Projects", parentId: null, priority: 0}),
					createTestNode({id: "mirror-in-id", name: "", parentId: "projects-id", priority: 0}),
					createTestNode({id: "task-a-id", name: "Task A", parentId: "projects-id", priority: 1}),
					createTestNode({id: "task-b-id", name: "Task B", parentId: "projects-id", priority: 2}),
					createTestNode({id: "mirror-nested-id", name: "", parentId: "task-b-id", priority: 0}),
					createTestNode({id: "agendas-id", name: "Agendas", parentId: null, priority: 1}),
					createTestNode({id: "mirror-out-id", name: "", parentId: "agendas-id", priority: 0}),
					createTestNode({id: "other-id", name: "Other", parentId: null, priority: 2}),
					createTestNode({
						id: "other-original-id",
						name: "Other Original",
						parentId: "other-id",
						priority: 0,
					}),
				]),
				mirrors: [
					{
						originalId: "other-original-id",
						mirrorId: "mirror-in-id",
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
					{
						originalId: "task-a-id",
						mirrorId: "mirror-nested-id",
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
					{
						originalId: "task-a-id",
						mirrorId: "mirror-out-id",
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				],
			});
		});

		/**
		 * Record each call. A children list answers with the seeded children; any
		 * other GET answers with Task A as moved under Agendas.
		 */
		function recordCalls(): string[] {
			const calls: string[] = [];
			const children: Record<string, string[]> = {
				"agendas-id": ["mirror-out-id"],
				"task-b-id": ["mirror-nested-id"],
			};
			const names: Record<string, string> = {"task-a-id": "Task A"};
			fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				const href = url instanceof Request ? url.url : url.toString();
				const call = `${method} ${href}`;
				calls.push(init?.body === undefined ? call : `${call} ${requestBody(init)}`);
				const {pathname, searchParams} = new URL(href);
				const parentId = searchParams.get("parent_id");
				if (parentId !== null) {
					const nodes = (children[parentId] ?? []).map((id, priority) =>
						createApiNode({id, name: names[id] ?? id, parent_id: parentId, priority}),
					);
					return Promise.resolve(Response.json({nodes}, {status: 200}));
				}
				// Keep the child lists current, since writes re-read their parent's children.
				const segments = pathname.split("/");
				const id = segments[4];
				const action = segments[5];
				if (method !== "GET") {
					for (const [listParentId, ids] of Object.entries(children)) {
						children[listParentId] = ids.filter((childId) => childId !== id);
					}
				}
				if (method === "POST" && action === "move") {
					const {parent_id: target, position} = moveBodySchema.parse(requestJson(init));
					const ids = children[target] ?? [];
					children[target] = position === "top" ? [id!, ...ids] : [...ids, id!];
				}
				if (method === "GET") {
					const node = createApiNode({id: "task-a-id", name: "Task A", parent_id: "agendas-id", priority: 0});
					return Promise.resolve(Response.json({node}, {status: 200}));
				}
				return Promise.resolve(Response.json({status: "ok"}, {status: 200}));
			});
			return calls;
		}

		function cacheState() {
			return {
				nodes: testDatabase.db
					.select({id: nodeContent.id, parentId: nodeContent.parentId})
					.from(nodeContent)
					.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
					.orderBy(nodeContent.id)
					.all(),
				mirrors: testDatabase.db
					.select({originalId: mirrors.originalId, mirrorId: mirrors.mirrorId})
					.from(mirrors)
					.where(eq(mirrors.systemTo, FAR_FUTURE_DATE))
					.orderBy(mirrors.mirrorId)
					.all(),
			};
		}

		it("dry run lists every call in order and says which originals are kept by moving them into a mirror slot", async () => {
			const calls = recordCalls();

			const {stdout} = await captureOutput(async () => {
				await Delete.run(["--id", "projects-id", "--dry-run"]);
			});

			expect({stdout, calls}).toStrictEqual({
				stdout: [
					"Would execute API calls:",
					"  DELETE https://workflowy.com/api/v1/nodes/mirror-in-id/mirror",
					"  DELETE https://workflowy.com/api/v1/nodes/mirror-nested-id/mirror",
					"  DELETE https://workflowy.com/api/v1/nodes/mirror-out-id/mirror",
					'  POST https://workflowy.com/api/v1/nodes/task-a-id/move {"parent_id":"agendas-id","position":"top"}',
					"  DELETE https://workflowy.com/api/v1/nodes/projects-id",
					"  Headers:",
					"    Authorization: Bearer <WORKFLOWY_API_KEY>",
					"",
					"Node: Projects",
					"",
					"Mirrors removed first through the mirror endpoint, so their originals drop the reference:",
					"  Projects > Other Original",
					"  Projects > Task B > Task A",
					"",
					"Keeping Projects > Task A by moving it to Agendas > Task A (as the web app does)",
					"",
					"WARNING: This will permanently delete the node and all its children, except the nodes kept above!",
					"",
				].join("\n"),
				calls: ["GET https://workflowy.com/api/v1/nodes?parent_id=agendas-id"],
			});
		});

		it("dry run on an original with mirrors elsewhere shows it moving into the mirror with the lowest id, with nothing deleted", async () => {
			const calls = recordCalls();

			const {stdout} = await captureOutput(async () => {
				await Delete.run(["--id", "task-a-id", "--dry-run"]);
			});

			expect({stdout, calls}).toStrictEqual({
				stdout: [
					"Would execute API calls:",
					"  DELETE https://workflowy.com/api/v1/nodes/mirror-nested-id/mirror",
					'  POST https://workflowy.com/api/v1/nodes/task-a-id/move {"parent_id":"task-b-id","position":"top"}',
					"  Headers:",
					"    Authorization: Bearer <WORKFLOWY_API_KEY>",
					"",
					"Node: Projects > Task A",
					"",
					"Keeping Projects > Task A by moving it to Projects > Task B > Task A (as the web app does)",
					"",
					"NOTE: Nothing is deleted: the node has a mirror elsewhere, so it moves into that mirror's place.",
					"",
				].join("\n"),
				calls: ["GET https://workflowy.com/api/v1/nodes?parent_id=task-b-id"],
			});
		});

		it("dry run on a mirror shows only the mirror endpoint call", async () => {
			const calls = recordCalls();

			const {stdout} = await captureOutput(async () => {
				await Delete.run(["--id", "mirror-out-id", "--dry-run"]);
			});

			expect({stdout, calls}).toStrictEqual({
				stdout: [
					"Would execute API calls:",
					"  DELETE https://workflowy.com/api/v1/nodes/mirror-out-id/mirror",
					"  Headers:",
					"    Authorization: Bearer <WORKFLOWY_API_KEY>",
					"",
					"Node: Agendas > Task A",
					"",
					"WARNING: This removes only this mirror; its original and the original's children are kept.",
					"",
				].join("\n"),
				calls: [],
			});
		});

		it("moves an original with a mirror elsewhere into the mirror slot before deleting the node, reports it, and updates the cache", async () => {
			const calls = recordCalls();

			const {stdout} = await captureOutput(async () => {
				await Delete.run(["--id", "projects-id"]);
			});

			expect({stdout, calls, cache: cacheState()}).toStrictEqual({
				stdout: [
					"Deleting node: Projects",
					"",
					"Mirrors removed first through the mirror endpoint, so their originals drop the reference:",
					"  Projects > Other Original",
					"  Projects > Task B > Task A",
					"",
					"Keeping Projects > Task A by moving it to Agendas > Task A (as the web app does)",
					"",
					"WARNING: This will permanently delete the node and all its children, except the nodes kept above!",
					"",
					"Successfully deleted node",
					"Kept Projects > Task A, now at Agendas > Task A",
					"",
				].join("\n"),
				calls: [
					"GET https://workflowy.com/api/v1/nodes?parent_id=agendas-id",
					"DELETE https://workflowy.com/api/v1/nodes/mirror-in-id/mirror",
					"DELETE https://workflowy.com/api/v1/nodes/mirror-nested-id/mirror",
					"DELETE https://workflowy.com/api/v1/nodes/mirror-out-id/mirror",
					'POST https://workflowy.com/api/v1/nodes/task-a-id/move {"parent_id":"agendas-id","position":"top"}',
					"GET https://workflowy.com/api/v1/nodes/task-a-id",
					"GET https://workflowy.com/api/v1/nodes?parent_id=agendas-id",
					"DELETE https://workflowy.com/api/v1/nodes/projects-id",
				],
				cache: {
					nodes: [
						{id: "agendas-id", parentId: null},
						{id: "other-id", parentId: null},
						{id: "other-original-id", parentId: "other-id"},
						{id: "task-a-id", parentId: "agendas-id"},
					],
					mirrors: [],
				},
			});
		});

		it("removes a mirror through the mirror endpoint", async () => {
			const calls = recordCalls();

			const {stdout} = await captureOutput(async () => {
				await Delete.run(["--id", "mirror-out-id"]);
			});

			expect({stdout, calls, cache: cacheState()}).toStrictEqual({
				stdout: [
					"Removing mirror: Agendas > Task A",
					"",
					"WARNING: This removes only this mirror; its original and the original's children are kept.",
					"",
					"Successfully removed mirror",
					"",
				].join("\n"),
				calls: ["DELETE https://workflowy.com/api/v1/nodes/mirror-out-id/mirror"],
				cache: {
					nodes: [
						{id: "agendas-id", parentId: null},
						{id: "mirror-in-id", parentId: "projects-id"},
						{id: "mirror-nested-id", parentId: "task-b-id"},
						{id: "other-id", parentId: null},
						{id: "other-original-id", parentId: "other-id"},
						{id: "projects-id", parentId: null},
						{id: "task-a-id", parentId: "projects-id"},
						{id: "task-b-id", parentId: "projects-id"},
					],
					mirrors: [
						{originalId: "other-original-id", mirrorId: "mirror-in-id"},
						{originalId: "task-a-id", mirrorId: "mirror-nested-id"},
					],
				},
			});
		});
	});

	describe("command metadata", () => {
		it("has correct description", () => {
			expect(Delete.description).toBe("Delete a Workflowy node");
		});

		it("has examples", () => {
			expect(Delete.examples).toStrictEqual([
				"# Delete node by ID",
				"<%= config.bin %> <%= command.id %> --id abc123",
				"",
				"# Delete node by path",
				'<%= config.bin %> <%= command.id %> --path "Work,Tasks,Completed Task"',
				"",
				"# Preview the API calls without deleting",
				"<%= config.bin %> <%= command.id %> --id abc123 --dry-run",
			]);
		});
	});
});
