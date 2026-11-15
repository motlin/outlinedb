import {it, vi, afterEach, expect, describe, beforeEach} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {mirrors, nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq} from "drizzle-orm";
import {z} from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Mirror from "../../../src/commands/node/mirror.js";
import {CacheService} from "../../../src/services/cache.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, isolateInternalAuth, pendingOutbox} from "../../helpers/upstream-outbox.js";

const ORIGIN_ID = "10e2d6c2-d165-b390-9484-d4fdbf4c4afa";
const PARENT_ID = "a71aed23-b0cc-4000-8000-000000000001";
const MIRROR_ID = "b82bfe34-c1dd-4000-8000-000000000002";
/** The id a created mirror gets: the internal client's transient id takes the first generated one. */
const NEW_MIRROR_ID = "00000000-0000-4000-8000-0000000000b2";

const NodeMirrorResultSchema = z.object(
	{
		action: z.string(),
		mirrorId: z.string(),
		originId: z.string().nullable(),
		parentId: z.string().nullable(),
	},
);

describe("node:mirror command", () =>
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

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-mirror-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		delete process.env.WORKFLOWY_API_URL;
		isolateInternalAuth(tempDir);

		fetchStub = vi.spyOn(globalThis, "fetch");
		vi.spyOn(crypto, "randomUUID")
			.mockReturnValueOnce("00000000-0000-4000-8000-0000000000b1")
			.mockReturnValueOnce(NEW_MIRROR_ID);

		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: ORIGIN_ID,
						name: "Origin Task",
						parentId: null,
					},
				),
				createTestNode(
					{
						id: PARENT_ID,
						name: "Agendas",
						parentId: null,
					},
				),
			]),
		);
	});

	afterEach(() =>
	{
		process.env = originalEnv;
		vi.restoreAllMocks();
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

	function currentMirrorRows()
	{
		return testDatabase.db
			.select(
				{
					originalId: mirrors.originalId,
					mirrorId: mirrors.mirrorId,
				},
			)
			.from(mirrors)
			.where(eq(mirrors.systemTo, FAR_FUTURE_DATE))
			.all();
	}

	function currentContent(id: string)
	{
		return testDatabase.db
			.select(
				{
					id: nodeContent.id,
					name: nodeContent.name,
					note: nodeContent.note,
					parentId: nodeContent.parentId,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.all();
	}

	describe("flag validation", () =>
	{
		it("requires an origin node", async () =>
		{
			await expect(Mirror.run(["--parent-id", PARENT_ID])).rejects.toThrow(
				"Either --node-id or --node-path is required",
			);
		});

		it("requires a parent when creating", async () =>
		{
			await expect(Mirror.run(["--node-id", ORIGIN_ID])).rejects.toThrow(
				"Either --parent-id or --parent-path is required",
			);
		});

		it("requires WORKFLOWY_API_KEY", async () =>
		{
			delete process.env.WORKFLOWY_API_KEY;
			await expect(Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", PARENT_ID])).rejects.toThrow(
				"WORKFLOWY_API_KEY environment variable is required",
			);
		});
	});

	describe("creating a mirror", () =>
	{
		it("creates the mirror locally at the top of the parent with short IDs expanded, delivers it, and leaves nothing pending", async () =>
		{
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Mirror.run(["--node-id", "d4fdbf4c4afa", "--parent-id", "000000000001"]);
			});

			expect(
				{
					error,
					stdout,
					mirror: currentContent(NEW_MIRROR_ID),
					mirrors: currentMirrorRows(),
					types: upstream.pushes.map((ops) => ops.map((op) => op.type)),
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: `Mirroring:\n  Origin: Origin Task\n  Into:   Agendas\nSuccessfully created mirror\n  ID: ${NEW_MIRROR_ID}\n  Origin: ${ORIGIN_ID}\n`,
					mirror: [
						{
							id: NEW_MIRROR_ID,
							name: "",
							note: null,
							parentId: PARENT_ID,
						},
					],
					mirrors: [
						{
							originalId: ORIGIN_ID,
							mirrorId: NEW_MIRROR_ID,
						},
					],
					types: [["bulk_create", "edit"]],
					pending: [],
				},
			);
		});

		it("places the mirror at the bottom with --position bottom", async () =>
		{
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode(
						{
							id: ORIGIN_ID,
							name: "Origin Task",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: PARENT_ID,
							name: "Agendas",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "agenda-item",
							name: "Item",
							parentId: PARENT_ID,
						},
					),
				]),
			);
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", PARENT_ID, "--position", "bottom"]);
			});

			expect(
				{
					error,
					children: new CacheService(testDatabase.db).getChildren(PARENT_ID).map((child) => child.id),
				},
			).toStrictEqual(
				{
					error: undefined,
					children: ["agenda-item", NEW_MIRROR_ID],
				},
			);
		});

		it("mirrors to the top of Home", async () =>
		{
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {error} = await captureOutput(async () =>
			{
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", "home"]);
			});

			expect(
				{
					error,
					home: new CacheService(testDatabase.db).getChildren(null).map((child) => child.id),
				},
			).toStrictEqual(
				{
					error: undefined,
					home: [NEW_MIRROR_ID, ORIGIN_ID, PARENT_ID],
				},
			);
		});

		it("emits JSON with --json", async () =>
		{
			fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout} = await captureOutput(async () =>
			{
				await Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", PARENT_ID, "--json"]);
			});

			expect(NodeMirrorResultSchema.parse(JSON.parse(stdout))).toStrictEqual(
				{
					action: "created",
					mirrorId: NEW_MIRROR_ID,
					originId: ORIGIN_ID,
					parentId: PARENT_ID,
				},
			);
		});

		it("refuses to write without internal-API credentials", async () =>
		{
			await expect(Mirror.run(["--node-id", ORIGIN_ID, "--parent-id", "home"])).rejects.toThrow(
				"Writing needs the internal API",
			);
			expect(
				{
					mirrors: currentMirrorRows(),
					fetches: fetchStub.mock.calls,
				},
			).toStrictEqual(
				{
					mirrors: [],
					fetches: [],
				},
			);
		});
	});

	describe("deleting a mirror", () =>
	{
		beforeEach(() =>
		{
			seedTestData(
				testDatabase,
				{
					...nodeFixtures([
						createTestNode(
							{
								id: ORIGIN_ID,
								name: "Origin Task",
								parentId: null,
							},
						),
						createTestNode(
							{
								id: PARENT_ID,
								name: "Agendas",
								parentId: null,
							},
						),
						createTestNode(
							{
								id: MIRROR_ID,
								name: "",
								parentId: PARENT_ID,
							},
						),
					]),
					mirrors: [
						{
							originalId: ORIGIN_ID,
							mirrorId: MIRROR_ID,
							systemFrom: "2026-01-01",
							systemTo: FAR_FUTURE_DATE,
						},
					],
				},
			);
		});

		it("removes the mirror locally and delivers the delete, leaving its original", async () =>
		{
			const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);

			const {stdout, error} = await captureOutput(async () =>
			{
				await Mirror.run(["--node-id", "000000000002", "--delete"]);
			});

			expect(
				{
					error,
					stdout,
					mirror: currentContent(MIRROR_ID),
					mirrors: currentMirrorRows(),
					origin: currentContent(ORIGIN_ID),
					pushes: upstream.pushes,
					pending: pendingOutbox(testDatabase),
				},
			).toStrictEqual(
				{
					error: undefined,
					stdout: `Successfully deleted mirror ${MIRROR_ID}\n`,
					mirror: [],
					mirrors: [],
					origin: [
						{
							id: ORIGIN_ID,
							name: "Origin Task",
							note: null,
							parentId: null,
						},
					],
					// The original stops listing the mirror upstream.
					pushes: [
						[
							{
								type: "edit",
								data:
								{
									projectid: ORIGIN_ID,
									metadataPatches: [
										{
											op: "remove",
											path: ["mirror", "mirrorRootIds", MIRROR_ID],
										},
									],
									metadataInversePatches: [
										{
											op: "add",
											path: ["mirror", "mirrorRootIds", MIRROR_ID],
											value: true,
										},
									],
								},
							},
							{
								type: "delete",
								data:
								{
									projectid: MIRROR_ID,
								},
							},
						],
					],
					pending: [],
				},
			);
		});

		it("refuses to delete a node that is not a mirror", async () =>
		{
			await expect(Mirror.run(["--node-id", ORIGIN_ID, "--delete"])).rejects.toThrow(
				`${ORIGIN_ID} is not a mirror; pass the mirror node, not its origin`,
			);
		});

		it("rejects --delete combined with a parent", async () =>
		{
			await expect(Mirror.run(["--node-id", MIRROR_ID, "--delete", "--parent-id", PARENT_ID])).rejects.toThrow(
				"--delete=true cannot also be provided when using --parent-id",
			);
		});
	});
});
