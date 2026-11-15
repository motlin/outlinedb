import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Update from "../../../src/commands/node/update.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, isolateInternalAuth, pendingOutbox} from "../../helpers/upstream-outbox.js";

describe("node update command", () =>
{
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance<typeof fetch>;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		originalEnv =
		{
			...process.env,
		};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-update-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		isolateInternalAuth(tempDir);

		fetchStub = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() =>
	{
		process.env = originalEnv;

		cleanupTestDatabase(testDatabase);

		if (fs.existsSync(tempDir))
		{
			fs.rmSync(
				tempDir,
				{
					recursive: true,
					force: true,
				},
			);
		}
	});

	describe("environment variable validation", () =>
	{
		it("requires WORKFLOWY_API_KEY", async () =>
		{
			delete process.env.WORKFLOWY_API_KEY;

			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "node-id",
							name: "Test",
							parentId: null,
						},
					),
				]),
			);

			await expect(Update.run(["--id", "node-id", "--name", "New Name"])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("flag validation", () =>
	{
		it("requires either --id or --path", async () =>
		{
			await expect(Update.run(["--name", "New Name"])).rejects.toThrow("Either --id or --path is required");
		});

		it("requires at least one update field", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "node-id",
							name: "Test",
							parentId: null,
						},
					),
				]),
			);

			await expect(Update.run(["--id", "node-id"])).rejects.toThrow(
				"At least one of --name, --clear-name, --note, --clear-note, or --layout-mode must be provided",
			);
		});
	});

	describe("mirror targets", () =>
	{
		it("sends new text for a mirror to its original so the mirror never diverges", async () =>
		{
			seedTestData(
				testDatabase,
				{
					...nodeFixtures([
						createTestNode(
							{
								id: "orig-id",
								name: "Game night",
								parentId: null,
							},
						),
						createTestNode(
							{
								id: "mirror-id",
								name: null,
								parentId: null,
							},
						),
					]),
					mirrors: [
						{
							originalId: "orig-id",
							mirrorId: "mirror-id",
							systemFrom: "2026-01-01 00:00:00",
							systemTo: FAR_FUTURE_DATE,
						},
					],
				},
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Update.run(["--id", "mirror-id", "--name", "Game night #games", "--dry-run"]);
			});

			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/orig-id\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "name": "Game night #games"\n    }\n\nNode: Game night\n',
			);
		});
	});

	/** Seed `Work > Tasks > My Task` (`work-id`, `tasks-id`, `target-id`). */
	function seedTask(name = "My Task"): void
	{
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: "work-id",
						name: "Work",
						parentId: null,
					},
				),
				createTestNode(
					{
						id: "tasks-id",
						name: "Tasks",
						parentId: "work-id",
					},
				),
				createTestNode(
					{
						id: "target-id",
						name,
						parentId: "tasks-id",
					},
				),
			]),
		);
	}

	describe("local write and drain", () =>
	{
		it("writes the node locally, then delivers it to workflowy.com in one push and leaves nothing pending", async () =>
		{
			seedTask();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Update.run(["--id", "target-id", "--name", "Renamed", "--note", "Details"]);
			});

			expect(
				{
					error,
					stdout,
					node: testDatabase.db
						.select(
							{
								name: nodeContent.name,
								note: nodeContent.note,
							},
						)
						.from(nodeContent)
						.where(and(eq(nodeContent.id, "target-id"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
						.all(),
					pushes: upstream.pushes,
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: "Updating node: Work > Tasks > My Task\n\nSuccessfully updated node\n  New name: Renamed\n  New note: Details\n",
					node: [
						{
							name: "Renamed",
							note: "Details",
						},
					],
					pushes: [
						[
							{
								type: "edit",
								data:
								{
									projectid: "target-id",
									name: "Renamed",
									description: "Details",
									metadataPatches: [],
									metadataInversePatches: [],
								},
							},
						],
					],
					pending: [],
				},
			);
		});

		it("keeps the local write and its outbox rows when the push fails, and exits non-zero with the pending count", async () =>
		{
			seedTask();
			const upstream = fakeUpstream(
				fetchStub,
				testDatabase,
				tempDir,
				{
					failPush: true,
				},
			);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Update.run(["--id", "target-id", "--name", "Renamed", "--note", "Details"]);
			});

			expect(
				{
					stdout,
					error: error?.message,
					exit: error?.oclif?.exit,
					name: testDatabase.db
						.select(
							{
								name: nodeContent.name,
							},
						)
						.from(nodeContent)
						.where(and(eq(nodeContent.id, "target-id"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
						.get()?.name,
					pushes: upstream.pushes,
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					stdout: "Updating node: Work > Tasks > My Task\n",
					error: "Saved locally, but delivering it to workflowy.com failed: Workflowy rejected the operations: upstream_rejected\n2 outbox rows pending; they go out on the next write or with 'outbox drain'.",
					exit: 1,
					name: "Renamed",
					pushes: [],
					pending: [
						{
							nodeId: "target-id",
							aspect: "name",
							lastError: "Workflowy rejected the operations: upstream_rejected",
						},
						{
							nodeId: "target-id",
							aspect: "note",
							lastError: "Workflowy rejected the operations: upstream_rejected",
						},
					],
				},
			);
		});

		it("refuses to write without internal-API credentials, leaving the node and the outbox alone", async () =>
		{
			seedTask();

			await expect(Update.run(["--id", "target-id", "--name", "Renamed"])).rejects.toThrow(
				"Writing needs the internal API",
			);

			expect(
				{
					pending: pendingOutbox(testDatabase),
					fetches: fetchStub.mock.calls.length,
				},
			).toStrictEqual(
				{
					pending: [],
					fetches: 0,
				},
			);
		});
	});

	describe("backlinks", () =>
	{
		const TARGET_LINK = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

		it("creates the backlink item locally when the new text links to a node, and delivers it with the edit", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "source-id",
							name: "Old",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "01234567-0000-4000-8000-0123456789ab",
							name: "Target",
							parentId: null,
						},
					),
				]),
			);
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Update.run(["--id", "source-id", "--name", `see ${TARGET_LINK}`]);
			});

			expect(
				{
					error,
					types: upstream.pushes.map((ops) => ops.map((op) => op.type)),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					types: [["bulk_create", "bulk_create", "edit", "edit"]],
					pending: [],
				},
			);
		});
	});

	describe("dry run mode", () =>
	{
		it("shows API call without executing for name update", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "node-id",
							name: "Original Name",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Update.run(["--id", "node-id", "--name", "New Name", "--dry-run"]);
			});

			// Dry run outputs human-readable text, not JSON
			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/node-id\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "name": "New Name"\n    }\n\nNode: Original Name\n',
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("shows note in dry run output", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "node-id",
							name: "Test",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Update.run(["--id", "node-id", "--note", "New note content", "--dry-run"]);
			});

			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/node-id\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "note": "New note content"\n    }\n\nNode: Test\n',
			);
		});

		it("shows layout mode in dry run output", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "node-id",
							name: "Test",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Update.run(["--id", "node-id", "--layout-mode", "board", "--dry-run"]);
			});

			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/node-id\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "layoutMode": "board"\n    }\n\nNode: Test\n',
			);
		});

		it("shows clear-note in dry run output", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "node-id",
							name: "Test",
							note: "Old note",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Update.run(["--id", "node-id", "--clear-note", "--dry-run"]);
			});

			expect(stdout).toBe(
				'Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/node-id\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n  Body:\n    {\n      "note": ""\n    }\n\nNode: Test\n',
			);
		});
	});

	describe("--expect-name precondition", () =>
	{
		it("refuses to update when current name does not match --expect-name", async () =>
		{
			seedTask("Long current text the user expanded later");

			await expect(
				Update.run(["--id", "target-id", "--name", "Short stub", "--expect-name", "Stale original text"]),
			).rejects.toThrow(/does not match --expect-name/u);

			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("proceeds with the update when current name matches --expect-name", async () =>
		{
			seedTask("Exact current name");
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Update.run(["--id", "target-id", "--name", "New Name", "--expect-name", "Exact current name"]);
			});

			expect(
				{
					error,
					pushes: upstream.pushes,
				},
			).toStrictEqual(
				{
					error: undefined,
					pushes: [
						[
							{
								type: "edit",
								data:
								{
									projectid: "target-id",
									name: "New Name",
									metadataPatches: [],
									metadataInversePatches: [],
								},
							},
						],
					],
				},
			);
		});

		it("refuses when the node no longer exists in the cache", async () =>
		{
			seedTask();

			await expect(
				Update.run(["--id", "missing-id", "--name", "New Name", "--expect-name", "Anything"]),
			).rejects.toThrow(/does not match --expect-name/u);

			expect(fetchStub.mock.calls).toStrictEqual([]);
		});
	});

	describe("updating by path", () =>
	{
		it("resolves path to correct node ID", async () =>
		{
			seedTask();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Update.run([
					"--path",
					"Work,Tasks,My Task",
					"--clear-name",
					"--clear-note",
					"--layout-mode",
					"board",
				]);
			});

			expect(
				{
					error,
					stdout,
					pushes: upstream.pushes,
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: "Updating node: Work > Tasks > My Task\n\nSuccessfully updated node\n  Name cleared\n  Note cleared\n  Layout mode: board\n",
					pushes: [
						[
							{
								type: "edit",
								data:
								{
									projectid: "target-id",
									name: "",
									metadataPatches: [
										{
											op: "add",
											path: ["layoutMode"],
											value: "board",
										},
									],
									metadataInversePatches: [
										{
											op: "remove",
											path: ["layoutMode"],
										},
									],
								},
							},
						],
					],
				},
			);
		});

		it("errors when path not found", async () =>
		{
			// Cache is empty, API returns empty children for root (path not found)
			fetchStub.mockResolvedValue(
				Response.json(
					{
						nodes: [],
					},
					{
						status: 200,
					},
				),
			);

			await expect(Update.run(["--path", "Missing,Path", "--name", "New Name"])).rejects.toThrow(
				"Node not found at path: Missing > Path",
			);
		});
	});

	describe("command metadata", () =>
	{
		it("has correct description", () =>
		{
			expect(Update.description).toBe("Update a Workflowy node");
		});

		it("has examples", () =>
		{
			expect(Update.examples).toStrictEqual([
				"# Update node name by ID",
				'<%= config.bin %> <%= command.id %> --id abc123 --name "Updated Task"',
				"",
				"# Update node by path",
				'<%= config.bin %> <%= command.id %> --path "Work,Tasks,Old Name" --name "New Name"',
				"",
				"# Update note only",
				'<%= config.bin %> <%= command.id %> --id abc123 --note "Additional details"',
				"",
				"# Update both name and note",
				'<%= config.bin %> <%= command.id %> --id abc123 --name "Updated" --note "With note"',
				"",
				"# Clear the note from a node",
				"<%= config.bin %> <%= command.id %> --id abc123 --clear-note",
				"",
				"# Clear a node's name",
				"<%= config.bin %> <%= command.id %> --id abc123 --clear-name",
				"",
				"# Preview the API call without updating",
				'<%= config.bin %> <%= command.id %> --id abc123 --name "Updated" --dry-run',
			]);
		});
	});
});
