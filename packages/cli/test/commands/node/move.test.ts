import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Move from "../../../src/commands/node/move.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {seedTaggedCalendar} from "../../helpers/calendar-fixture.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {requestJson} from "../../helpers/request-body.js";

describe("node:move command", () => {
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-move-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";

		fetchStub = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		process.env = originalEnv;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	describe("environment variable validation", () => {
		it("requires WORKFLOWY_API_KEY", async () => {
			delete process.env.WORKFLOWY_API_KEY;

			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "source-id", name: "Source", parentId: null}),
					createTestNode({id: "target-id", name: "Target", parentId: null}),
				]),
			);

			await expect(Move.run(["--node-id", "source-id", "--parent-id", "target-id"])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("flag validation", () => {
		it("requires either --node-id or --node-path", async () => {
			await expect(Move.run(["--parent-id", "target-id"])).rejects.toThrow(
				"Either --node-id or --node-path is required",
			);
		});

		it("requires a parent flag", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "source-id", name: "Source", parentId: null})]),
			);

			await expect(Move.run(["--node-id", "source-id"])).rejects.toThrow(
				"Either --parent-id or --parent-path is required",
			);
		});
	});

	describe("dry run mode", () => {
		it("shows move preview without executing", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "source-id", name: "Source Node", parentId: null}),
					createTestNode({id: "target-id", name: "Target Folder", parentId: null}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id", "--dry-run"]);
			});

			// Dry run outputs human-readable text
			expect(stdout).toBe(
				"Would move:\n  From: Source Node\n  To:   Target Folder\n\nExecute with:\n  outlinedb node:move --node-id source-id --parent-id target-id\n",
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("shows position in dry run output", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "source-id", name: "Source", parentId: null}),
					createTestNode({id: "target-id", name: "Target", parentId: null}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Move.run([
					"--node-id",
					"source-id",
					"--parent-id",
					"target-id",
					"--position",
					"bottom",
					"--dry-run",
				]);
			});

			expect(stdout).toBe(
				"Would move:\n  From: Source\n  To:   Target\n  Position: bottom\n\nExecute with:\n  outlinedb node:move --node-id source-id --parent-id target-id --position bottom\n",
			);
		});
	});

	/**
	 * Answer a move with success, a GET of the moved node with `moved`, and the
	 * re-read of its new parent's children with `moved` alone. Returns each
	 * request as `METHOD url` and each request body, in order.
	 */
	function fakeMove(moved: {id: string; name: string; parent_id: string | null; priority: number}): {
		requests: string[];
		bodies: unknown[];
	} {
		const now = Math.floor(Date.now() / 1000);
		const node = {
			...moved,
			note: null,
			completed: false,
			createdAt: now,
			modifiedAt: now,
			completedAt: null,
			data: {},
		};
		const requests: string[] = [];
		const bodies: unknown[] = [];
		fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = url instanceof Request ? url.url : String(url);
			const method = init?.method ?? "GET";
			requests.push(`${method} ${urlStr}`);
			if (method === "POST" && urlStr.endsWith(`/nodes/${moved.id}/move`)) {
				bodies.push(requestJson(init));
				return Promise.resolve(Response.json({}, {status: 200}));
			}
			if (method === "GET" && urlStr.endsWith(`/nodes/${moved.id}`)) {
				return Promise.resolve(Response.json({node}, {status: 200}));
			}
			const childrenUrl =
				moved.parent_id === null
					? "https://workflowy.com/api/v1/nodes"
					: `https://workflowy.com/api/v1/nodes?parent_id=${moved.parent_id}`;
			if (method === "GET" && urlStr === childrenUrl) {
				return Promise.resolve(Response.json({nodes: [node]}, {status: 200}));
			}
			return Promise.resolve(Response.json({error: "Not found"}, {status: 404}));
		});
		return {requests, bodies};
	}

	describe("moving by ID", () => {
		it("moves node via API", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "source-id", name: "Source", parentId: null}),
					createTestNode({id: "target-id", name: "Target", parentId: null}),
				]),
			);
			const {requests, bodies} = fakeMove({id: "source-id", name: "Source", parent_id: "target-id", priority: 0});

			const {stdout} = await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id"]);
			});

			expect({stdout, requests, bodies}).toStrictEqual({
				stdout: "Moving:\n  From: Source\n  To:   Target\nSuccessfully moved node\n",
				requests: [
					"POST https://workflowy.com/api/v1/nodes/source-id/move",
					"GET https://workflowy.com/api/v1/nodes/source-id",
					"GET https://workflowy.com/api/v1/nodes?parent_id=target-id",
				],
				bodies: [{parent_id: "target-id"}],
			});
		});

		it("includes position in API request for top", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "source-id", name: "Source", parentId: null}),
					createTestNode({id: "target-id", name: "Target", parentId: null}),
				]),
			);
			const {bodies} = fakeMove({id: "source-id", name: "Source", parent_id: "target-id", priority: -1});

			await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id", "--position", "top"]);
			});

			expect(bodies).toStrictEqual([{parent_id: "target-id", position: "top"}]);
		});

		it("includes position in API request for bottom", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "source-id", name: "Source", parentId: null}),
					createTestNode({id: "target-id", name: "Target", parentId: null}),
				]),
			);
			const {bodies} = fakeMove({id: "source-id", name: "Source", parent_id: "target-id", priority: 0});

			await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id", "--position", "bottom"]);
			});

			expect(bodies).toStrictEqual([{parent_id: "target-id", position: "bottom"}]);
		});
	});

	describe("calendar adoption", () => {
		const day21 = '<time startYear="2026" startMonth="10" startDay="21">Wed, Oct 21, 2026</time>';

		it("tags a dated row moved under a calendar month as that day", async () => {
			seedTaggedCalendar(testDatabase);
			process.env.WORKFLOWY_USERNAME = "alice@example.com";
			process.env.WORKFLOWY_PASSWORD = "hunter2";
			process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
			fakeMove({id: "stray", name: day21, parent_id: "m10", priority: 0});
			const moveApi = fetchStub.getMockImplementation()!;
			fetchStub.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				if ((url instanceof Request ? url.url : String(url)).endsWith("/nodes/m10")) {
					const now = Math.floor(Date.now() / 1000);
					const node = {id: "m10", name: "10", note: null, parent_id: "y2026", priority: 0, completed: false};
					return Promise.resolve(
						Response.json({node: {...node, createdAt: now, modifiedAt: now, completedAt: null, data: {}}}),
					);
				}
				return moveApi(url, init) as Promise<Response>;
			});
			const setMeta = vi.spyOn(WorkflowyInternalAdapter.prototype, "setNodeMetaValues").mockResolvedValue();

			await captureOutput(async () => {
				await Move.run(["--node-id", "stray", "--parent-id", "m10"]);
			});

			expect(setMeta.mock.calls).toStrictEqual([
				[
					"stray",
					[
						{
							path: ["calendar"],
							value: {
								level: "day",
								value: "21",
								timestamp: new Date(2026, 9, 21).getTime(),
								dateId: 20_261_021,
							},
						},
					],
				],
			]);
		});
	});

	describe("moving by path", () => {
		it("resolves source and target paths", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "tasks-id", name: "Tasks", parentId: "work-id"}),
					createTestNode({id: "source-id", name: "My Task", parentId: "tasks-id"}),
					createTestNode({id: "archive-id", name: "Archive", parentId: "work-id"}),
				]),
			);
			const {requests, bodies} = fakeMove({
				id: "source-id",
				name: "My Task",
				parent_id: "archive-id",
				priority: 0,
			});

			const {stdout} = await captureOutput(async () => {
				await Move.run(["--node-path", "Work,Tasks,My Task", "--parent-path", "Work,Archive"]);
			});

			expect({stdout, requests, bodies}).toStrictEqual({
				stdout: "Moving:\n  From: Work > Tasks > My Task\n  To:   Work > Archive\nSuccessfully moved node\n",
				requests: [
					"POST https://workflowy.com/api/v1/nodes/source-id/move",
					"GET https://workflowy.com/api/v1/nodes/source-id",
					"GET https://workflowy.com/api/v1/nodes?parent_id=archive-id",
				],
				bodies: [{parent_id: "archive-id"}],
			});
		});
	});

	describe("system targets", () => {
		it("moves to inbox system target via --parent-id", async () => {
			// The API accepts 'inbox' as parent_id on move but 404s on GET /nodes/inbox,
			// so the real parent is learned from the moved node.
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "inbox-uuid", name: "Inbox", parentId: null}),
					createTestNode({id: "source-id", name: "Source", parentId: null}),
				]),
			);
			const {requests, bodies} = fakeMove({
				id: "source-id",
				name: "Source",
				parent_id: "inbox-uuid",
				priority: 0,
			});

			const {error} = await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "inbox"]);
			});

			expect({error, requests, bodies}).toStrictEqual({
				error: undefined,
				requests: [
					"POST https://workflowy.com/api/v1/nodes/source-id/move",
					"GET https://workflowy.com/api/v1/nodes/source-id",
					"GET https://workflowy.com/api/v1/nodes?parent_id=inbox-uuid",
				],
				bodies: [{parent_id: "inbox"}],
			});
			expect(
				testDatabase.db
					.select({id: nodeContent.id, parentId: nodeContent.parentId})
					.from(nodeContent)
					.where(and(eq(nodeContent.id, "source-id"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
					.all(),
			).toStrictEqual([{id: "source-id", parentId: "inbox-uuid"}]);
		});
	});

	describe("home (top level)", () => {
		it("dry run shows Home as the destination", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "source-id", name: "Source", parentId: "work-id"}),
				]),
			);

			const {stdout} = await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "home", "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would move:\n  From: Work > Source\n  To:   Home\n\nExecute with:\n  outlinedb node:move --node-id source-id --parent-id home\n",
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("moves to the top level by omitting parent_id, and caches a null parent", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "source-id", name: "Source", parentId: "work-id"}),
				]),
			);
			const {requests, bodies} = fakeMove({id: "source-id", name: "Source", parent_id: null, priority: 0});

			const {stdout} = await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "home", "--position", "top"]);
			});

			expect({stdout, requests, bodies}).toStrictEqual({
				stdout: "Moving:\n  From: Work > Source\n  To:   Home\n  Position: top\nSuccessfully moved node\n",
				requests: [
					"POST https://workflowy.com/api/v1/nodes/source-id/move",
					"GET https://workflowy.com/api/v1/nodes/source-id",
					"GET https://workflowy.com/api/v1/nodes",
				],
				bodies: [{position: "top"}],
			});
			expect(
				testDatabase.db
					.select({id: nodeContent.id, parentId: nodeContent.parentId})
					.from(nodeContent)
					.where(and(eq(nodeContent.id, "source-id"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
					.all(),
			).toStrictEqual([{id: "source-id", parentId: null}]);
		});
	});

	describe("output", () => {
		it("displays from and to paths", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "work-id", name: "Work", parentId: null}),
					createTestNode({id: "source-id", name: "Source", parentId: "work-id"}),
					createTestNode({id: "target-id", name: "Target", parentId: null}),
				]),
			);

			fetchStub.mockResolvedValue(Response.json({}, {status: 200}));

			const {stdout} = await captureOutput(async () => {
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id"]);
			});

			expect(stdout).toBe("Moving:\n  From: Work > Source\n  To:   Target\n");
		});
	});

	describe("command metadata", () => {
		it("has correct description", () => {
			expect(Move.description).toBe("Move a single node to a new location by ID or path");
		});

		it("has examples", () => {
			expect(Move.examples).toStrictEqual([
				"# Move node to inbox (system target)",
				"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id inbox",
				"",
				"# Move node to the top level (Home)",
				"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id home",
				"",
				"# Move node by ID to parent ID",
				"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id def456",
				"",
				"# Move node by path to parent path",
				'<%= config.bin %> <%= command.id %> --node-path "Work,Tasks,My Task" --parent-path "Work,Archive"',
				"",
				"# Move node to bottom of parent (default is top)",
				"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id def456 --position bottom",
				"",
				"# Preview the move command without executing",
				"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id inbox --dry-run",
				"",
				"# Mixed: move by ID to path",
				'<%= config.bin %> <%= command.id %> --node-id abc123 --parent-path "Work,Archive"',
			]);
		});
	});
});
