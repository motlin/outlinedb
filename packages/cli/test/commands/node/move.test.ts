import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Move from "../../../src/commands/node/move.js";
import {CacheService} from "../../../src/services/cache.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {seedTaggedCalendar} from "../../helpers/calendar-fixture.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, isolateInternalAuth, pendingOutbox} from "../../helpers/upstream-outbox.js";

describe("node:move command", () =>
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

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-move-test-"));
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
							id: "source-id",
							name: "Source",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "target-id",
							name: "Target",
							parentId: null,
						},
					),
				]),
			);

			await expect(Move.run(["--node-id", "source-id", "--parent-id", "target-id"])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("flag validation", () =>
	{
		it("requires either --node-id or --node-path", async () =>
		{
			await expect(Move.run(["--parent-id", "target-id"])).rejects.toThrow(
				"Either --node-id or --node-path is required",
			);
		});

		it("requires a parent flag", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "source-id",
							name: "Source",
							parentId: null,
						},
					),
				]),
			);

			await expect(Move.run(["--node-id", "source-id"])).rejects.toThrow(
				"Either --parent-id or --parent-path is required",
			);
		});
	});

	describe("dry run mode", () =>
	{
		it("shows move preview without executing", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "source-id",
							name: "Source Node",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "target-id",
							name: "Target Folder",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id", "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would move:\n  From: Source Node\n  To:   Target Folder\n" +
					"Would save locally (outbox rows):\n" +
					"  source-id  placement  Source Node\n" +
					"Would push to workflowy.com:\n" +
					'  move {"projectid":"source-id","parentid":"target-id","priority":0}\n',
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
			expect(pendingOutbox(testDatabase)).toStrictEqual([]);
			expect(new CacheService(testDatabase.db).getNode("source-id")?.parentId).toBeNull();
		});

		it("shows position in dry run output", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: "source-id",
							name: "Source",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "target-id",
							name: "Target",
							parentId: null,
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
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
				"Would move:\n  From: Source\n  To:   Target\n  Position: bottom\n" +
					"Would save locally (outbox rows):\n" +
					"  source-id  placement  Source\n" +
					"Would push to workflowy.com:\n" +
					'  move {"projectid":"source-id","parentid":"target-id","priority":0}\n',
			);
		});
	});

	/** `Work > Source` and `Target > Existing` at Home, with `extra` nodes. */
	function seedOutline(...extra: ReturnType<typeof createTestNode>[]): void
	{
		seedTestData(
			testDatabase,
			nodeFixtures([
				...extra,
				createTestNode(
					{
						id: "work-id",
						name: "Work",
						parentId: null,
					},
				),
				createTestNode(
					{
						id: "source-id",
						name: "Source",
						parentId: "work-id",
					},
				),
				createTestNode(
					{
						id: "target-id",
						name: "Target",
						parentId: null,
					},
				),
				createTestNode(
					{
						id: "existing-id",
						name: "Existing",
						parentId: "target-id",
					},
				),
			]),
		);
	}

	/** A parent's child ids in order, as the local tables hold them. */
	function childIds(parentId: string | null): string[]
	{
		return new CacheService(testDatabase.db).getChildren(parentId).map((child) => child.id);
	}

	describe("moving by ID", () =>
	{
		it("moves the node locally to the top of the parent, delivers the move, and leaves nothing pending", async () =>
		{
			seedOutline();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id"]);
			});

			expect(
				{
					error,
					stdout,
					work: childIds("work-id"),
					target: childIds("target-id"),
					pushes: upstream.pushes,
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: "Moving:\n  From: Work > Source\n  To:   Target\nSuccessfully moved node\n",
					work: [],
					target: ["source-id", "existing-id"],
					pushes: [
						[
							{
								type: "move",
								data:
								{
									projectid: "source-id",
									parentid: "target-id",
									priority: 0,
								},
							},
						],
					],
					pending: [],
				},
			);
		});

		it("moves to the bottom with --position bottom", async () =>
		{
			seedOutline();
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id", "--position", "bottom"]);
			});

			expect(
				{
					error,
					target: childIds("target-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					target: ["existing-id", "source-id"],
				},
			);
		});

		it("keeps the local move and its outbox row when the push fails, and exits non-zero", async () =>
		{
			seedOutline();
			fakeUpstream(
				fetchStub,
				testDatabase,
				tempDir,
				{
					failPush: true,
				},
			);

			const {error} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "source-id", "--parent-id", "target-id"]);
			});

			expect(
				{
					error: error?.message,
					exit: error?.oclif?.exit,
					target: childIds("target-id"),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: "Saved locally (moved node source-id), but delivering it to workflowy.com failed: Workflowy rejected the operations: upstream_rejected\n1 outbox row pending; they go out on the next write or with 'outbox drain'.",
					exit: 1,
					target: ["source-id", "existing-id"],
					pending: [
						{
							nodeId: "source-id",
							aspect: "placement",
							lastError: "Workflowy rejected the operations: upstream_rejected",
						},
					],
				},
			);
		});
	});

	describe("calendar adoption", () =>
	{
		it("tags a dated row moved under a calendar month as that day, and delivers the tag with the move", async () =>
		{
			// `stray` is a dated row at Home.
			seedTaggedCalendar(testDatabase);
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "stray", "--parent-id", "m10"]);
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
								type: "move",
								data:
								{
									projectid: "stray",
									parentid: "m10",
									priority: 0,
								},
							},
							{
								type: "edit",
								data:
								{
									projectid: "stray",
									metadataPatches: [
										{
											op: "add",
											path: ["calendar"],
											value:
											{
												level: "day",
												value: "21",
												timestamp: new Date(2026, 9, 21).getTime(),
												dateId: 20_261_021,
											},
										},
									],
									metadataInversePatches: [
										{
											op: "remove",
											path: ["calendar"],
										},
									],
								},
							},
						],
					],
				},
			);
		});
	});

	describe("moving by path", () =>
	{
		it("resolves source and target paths", async () =>
		{
			seedOutline();
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Move.run(["--node-path", "Work,Source", "--parent-path", "Target,Existing"]);
			});

			expect(
				{
					error,
					stdout,
					existing: childIds("existing-id"),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: "Moving:\n  From: Work > Source\n  To:   Target > Existing\nSuccessfully moved node\n",
					existing: ["source-id"],
				},
			);
		});
	});

	describe("system targets", () =>
	{
		it("moves to the account's Inbox node via --parent-id inbox", async () =>
		{
			seedOutline(
				createTestNode(
					{
						id: "inbox-uuid",
						name: "Inbox",
						parentId: null,
					},
				),
			);
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "source-id", "--parent-id", "inbox"]);
			});

			expect(
				{
					error,
					inbox: childIds("inbox-uuid"),
				},
			).toStrictEqual(
				{
					error: undefined,
					inbox: ["source-id"],
				},
			);
		});
	});

	describe("home (top level)", () =>
	{
		it("dry run shows Home as the destination", async () =>
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
							id: "source-id",
							name: "Source",
							parentId: "work-id",
						},
					),
				]),
			);

			const {stdout} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "source-id", "--parent-id", "home", "--dry-run"]);
			});

			expect(stdout).toBe(
				"Would move:\n  From: Work > Source\n  To:   Home\n" +
					"Would save locally (outbox rows):\n" +
					"  source-id  placement  Source\n" +
					"Would push to workflowy.com:\n" +
					'  move {"projectid":"source-id","parentid":"None","priority":0}\n',
			);
			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("moves to the top level", async () =>
		{
			seedOutline();
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Move.run(["--node-id", "source-id", "--parent-id", "home"]);
			});

			expect(
				{
					error,
					home: childIds(null),
					pushes: upstream.pushes,
				},
			).toStrictEqual(
				{
					error: undefined,
					home: ["source-id", "target-id", "work-id"],
					pushes: [
						[
							{
								type: "move",
								data:
								{
									projectid: "source-id",
									parentid: "None",
									priority: 0,
								},
							},
						],
					],
				},
			);
		});
	});

	describe("command metadata", () =>
	{
		it("has correct description", () =>
		{
			expect(Move.description).toBe("Move a single node to a new location by ID or path");
		});

		it("has examples", () =>
		{
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
