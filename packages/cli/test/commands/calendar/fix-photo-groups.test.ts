import {beforeEach, vi, afterEach, expect, describe, it} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {FAR_FUTURE_DATE, systemTimeAt} from "@outlinedb/shared/temporal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import FixPhotoGroups from "../../../src/commands/calendar/fix-photo-groups.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, pendingOutbox} from "../../helpers/upstream-outbox.js";
import {CacheService} from "../../../src/services/cache.js";

function s3File(nodeId: string, fileName: string, systemFrom = systemTimeAt("2026-01-01 00:00:00.000"))
{
	return {
		nodeId,
		fileName,
		fileType: "image/jpeg",
		objectFolder: null,
		isAnimatedGif: null,
		imageOriginalWidth: null,
		imageOriginalHeight: null,
		imageOriginalPixels: null,
		isDeleted: null,
		systemFrom,
		systemTo: FAR_FUTURE_DATE,
	};
}

/** Wrapper `wrapper` under entry `entry`, holding photos in reverse order. */
function seedWrappedGroup(testDatabase: TestDatabase)
{
	seedTestData(
		testDatabase,
		{
			...nodeFixtures([
				createTestNode(
					{
						id: "day",
						name: "Sat, May 23, 2026",
						parentId: null,
					},
				),
				createTestNode(
					{
						id: "entry",
						name: "Drove to a friend’s house",
						parentId: "day",
					},
				),
				createTestNode(
					{
						id: "wrapper",
						name: "",
						note: null,
						parentId: "entry",
					},
				),
				createTestNode(
					{
						id: "photo-1",
						name: "",
						parentId: "wrapper",
						priority: 100,
					},
				),
				createTestNode(
					{
						id: "photo-2",
						name: "",
						parentId: "wrapper",
						priority: 200,
					},
				),
				createTestNode(
					{
						id: "photo-3",
						name: "",
						parentId: "wrapper",
						priority: 300,
					},
				),
			]),
			s3Files: [
				s3File("photo-1", "IMG_0300.jpeg"),
				s3File("photo-2", "IMG_0200.jpeg"),
				s3File("photo-3", "IMG_0100.jpeg"),
			],
		},
	);
}

describe("calendar:fix-photo-groups command", () =>
{
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance<typeof fetch>;
	let tempDir: string;
	let testDatabase: TestDatabase;

	/** Run the command against a workflowy.com that rejects every push, so its writes stay pending locally. */
	async function runWithFailingUpstream(args: string[])
	{
		const upstream = fakeUpstream(
			fetchStub,
			testDatabase,
			tempDir,
			{
				failPush: true,
			},
		);
		const {error} = await captureOutput(async () =>
		{
			await FixPhotoGroups.run(args);
		});
		return {
			exit: error?.oclif?.exit,
			pushes: upstream.pushes,
		};
	}

	/** A node's live children, in order. */
	function childIds(parentId: string): string[]
	{
		return new CacheService(testDatabase.db).getChildren(parentId).map(({id}) => id);
	}

	/** The pending outbox rows as `[node, aspect]`, oldest first (one write's rows by node id). */
	function pending(): string[][]
	{
		return pendingOutbox(testDatabase).map(({nodeId, aspect}) => [nodeId, aspect]);
	}

	beforeEach(() =>
	{
		originalEnv =
		{
			...process.env,
		};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-photo-groups-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		// Without this the staleness check decompresses every real monthly backup
		// archive on disk, costing ~1.5s per test and coupling results to the
		// developer's machine.
		process.env.OUTLINEDB_BACKUPS_DIR = path.join(tempDir, "backups");

		// Nothing reaches workflowy.com unless a test fakes it; a write test fakes it rejecting every push.
		fetchStub = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected request"));
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

	it("previews a wrapped group without calling the API", async () =>
	{
		seedWrappedGroup(testDatabase);

		const {stdout} = await captureOutput(async () =>
		{
			await FixPhotoGroups.run(["--dry-run"]);
		});

		expect(stdout).toBe(
			'Found 1 photo groups: 1 to fix, 0 left alone\n\n--- DRY RUN ---\n  wrapper wrapper under entry entry "Drove to a friend’s house" — reverse (filenames descend)\n    photo-3  IMG_0100.jpeg\n    photo-2  IMG_0200.jpeg\n    photo-1  IMG_0300.jpeg\n\nTotal: 1 groups would be fixed\n',
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("unwraps and reverses a wrapped group, then deletes the wrapper, locally first", async () =>
	{
		seedWrappedGroup(testDatabase);

		const result = await runWithFailingUpstream([]);

		expect(
			{
				...result,
				entry: childIds("entry"),
				wrapper: new CacheService(testDatabase.db).getNode("wrapper"),
				pending: pending(),
			},
		).toStrictEqual(
			{
				exit: 1,
				pushes: [],
				entry: ["photo-3", "photo-2", "photo-1"],
				wrapper: undefined,
				pending: [
					["photo-1", "placement"],
					["photo-2", "placement"],
					["photo-3", "placement"],
					["wrapper", "delete"],
				],
			},
		);
	});

	it("reverses a loose group in place without deleting anything", async () =>
	{
		seedTestData(
			testDatabase,
			{
				...nodeFixtures([
					createTestNode(
						{
							id: "day",
							name: "Wed, Jul 1, 2026",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "entry",
							name: "Flat Rock Brook",
							parentId: "day",
						},
					),
					createTestNode(
						{
							id: "photo-1",
							name: "",
							parentId: "entry",
							priority: 100,
						},
					),
					createTestNode(
						{
							id: "photo-2",
							name: "",
							parentId: "entry",
							priority: 200,
						},
					),
				]),
				s3Files: [s3File("photo-1", "IMG_3695.jpeg"), s3File("photo-2", "IMG_3667.jpeg")],
			},
		);

		const result = await runWithFailingUpstream([]);

		expect(
			{
				...result,
				entry: childIds("entry"),
				pending: pending(),
			},
		).toStrictEqual(
			{
				exit: 1,
				pushes: [],
				entry: ["photo-2", "photo-1"],
				pending: [
					["photo-1", "placement"],
					["photo-2", "placement"],
				],
			},
		);
	});

	it("leaves a loose group alone when its filenames give no ordering evidence", async () =>
	{
		seedTestData(
			testDatabase,
			{
				...nodeFixtures([
					createTestNode(
						{
							id: "day",
							name: "Wed, Jul 1, 2026",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "entry",
							name: "Flat Rock Brook",
							parentId: "day",
						},
					),
					createTestNode(
						{
							id: "photo-1",
							name: "",
							parentId: "entry",
							priority: 100,
						},
					),
					createTestNode(
						{
							id: "photo-2",
							name: "",
							parentId: "entry",
							priority: 200,
						},
					),
				]),
				s3Files: [s3File("photo-1", "image.jpeg"), s3File("photo-2", "image.jpeg")],
			},
		);

		const {stdout} = await captureOutput(async () =>
		{
			await FixPhotoGroups.run([]);
		});

		expect(stdout).toBe(
			"Found 1 photo groups: 0 to fix, 1 left alone\n  1 left alone: loose group without filename evidence\n",
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("leaves a group alone when its filenames already ascend", async () =>
	{
		seedTestData(
			testDatabase,
			{
				...nodeFixtures([
					createTestNode(
						{
							id: "day",
							name: "Wed, Jul 1, 2026",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "entry",
							name: "Flat Rock Brook",
							parentId: "day",
						},
					),
					createTestNode(
						{
							id: "photo-1",
							name: "",
							parentId: "entry",
							priority: 100,
						},
					),
					createTestNode(
						{
							id: "photo-2",
							name: "",
							parentId: "entry",
							priority: 200,
						},
					),
				]),
				s3Files: [s3File("photo-1", "IMG_3667.jpeg"), s3File("photo-2", "IMG_3695.jpeg")],
			},
		);

		await captureOutput(async () =>
		{
			await FixPhotoGroups.run([]);
		});

		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("restricts work to one group using its short ID", async () =>
	{
		const wrapperId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		seedTestData(
			testDatabase,
			{
				...nodeFixtures([
					createTestNode(
						{
							id: "day",
							name: "Sat, May 23, 2026",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "entry",
							name: "Drove to a friend’s house",
							parentId: "day",
						},
					),
					createTestNode(
						{
							id: wrapperId,
							shortId: "eeeeeeeeeeee",
							name: "",
							parentId: "entry",
						},
					),
					createTestNode(
						{
							id: "photo-1",
							name: "",
							parentId: wrapperId,
							priority: 100,
						},
					),
					createTestNode(
						{
							id: "photo-2",
							name: "",
							parentId: wrapperId,
							priority: 200,
						},
					),
					createTestNode(
						{
							id: "other-entry",
							name: "Another entry",
							parentId: "day",
						},
					),
					createTestNode(
						{
							id: "other-wrapper",
							name: "",
							parentId: "other-entry",
						},
					),
					createTestNode(
						{
							id: "photo-3",
							name: "",
							parentId: "other-wrapper",
							priority: 100,
						},
					),
					createTestNode(
						{
							id: "photo-4",
							name: "",
							parentId: "other-wrapper",
							priority: 200,
						},
					),
				]),
				s3Files: [
					s3File("photo-1", "image.jpeg"),
					s3File("photo-2", "image.jpeg"),
					s3File("photo-3", "image.jpeg"),
					s3File("photo-4", "image.jpeg"),
				],
			},
		);

		await runWithFailingUpstream(["--node-id", "eeeeeeeeeeee"]);

		expect(
			{
				entry: childIds("entry"),
				otherWrapper: childIds("other-wrapper"),
				pending: pending(),
			},
		).toStrictEqual(
			{
				entry: ["photo-2", "photo-1"],
				otherWrapper: ["photo-3", "photo-4"],
				pending: [
					["photo-1", "placement"],
					["photo-2", "placement"],
					[wrapperId, "delete"],
				],
			},
		);
	});

	it("resolves a short ID for a dry run without an API key", async () =>
	{
		delete process.env.WORKFLOWY_API_KEY;
		const wrapperId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		seedTestData(
			testDatabase,
			{
				...nodeFixtures([
					createTestNode(
						{
							id: "day",
							name: "Sat, May 23, 2026",
							parentId: null,
						},
					),
					createTestNode(
						{
							id: "entry",
							name: "Drove to a friend’s house",
							parentId: "day",
						},
					),
					createTestNode(
						{
							id: wrapperId,
							shortId: "eeeeeeeeeeee",
							name: "",
							parentId: "entry",
						},
					),
					createTestNode(
						{
							id: "photo-1",
							name: "",
							parentId: wrapperId,
							priority: 100,
						},
					),
					createTestNode(
						{
							id: "photo-2",
							name: "",
							parentId: wrapperId,
							priority: 200,
						},
					),
				]),
				s3Files: [s3File("photo-1", "image.jpeg"), s3File("photo-2", "image.jpeg")],
			},
		);

		const {stdout} = await captureOutput(async () =>
		{
			await FixPhotoGroups.run(["--node-id", "eeeeeeeeeeee", "--dry-run"]);
		});

		expect(stdout).toBe(
			`Found 1 photo groups: 1 to fix, 0 left alone\n\n--- DRY RUN ---\n  wrapper ${wrapperId} under entry entry "Drove to a friend’s house" — reverse (wrapped group, assuming a single reversed paste)\n    photo-2  image.jpeg\n    photo-1  image.jpeg\n\nTotal: 1 groups would be fixed\n`,
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("requires WORKFLOWY_API_KEY when not doing a dry run", async () =>
	{
		delete process.env.WORKFLOWY_API_KEY;
		seedWrappedGroup(testDatabase);

		await expect(FixPhotoGroups.run([])).rejects.toThrow("WORKFLOWY_API_KEY environment variable is required");
	});
});
