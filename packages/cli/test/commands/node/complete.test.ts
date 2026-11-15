import {beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import Complete from "../../../src/commands/node/complete.js";
import Uncomplete from "../../../src/commands/node/uncomplete.js";
import {CacheService} from "../../../src/services/cache.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, isolateInternalAuth, pendingOutbox} from "../../helpers/upstream-outbox.js";

const FULL_ID = "3435cb92-d00d-45be-9950-b1ed4735574c";
const SHORT_ID = "b1ed4735574c";

describe("node complete and uncomplete commands", () =>
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

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-complete-test-"));
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

	it("expands a short id to the full UUID before completing", async () =>
	{
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: FULL_ID,
						name: "Test Node",
						parentId: null,
					},
				),
			]),
		);

		const {stdout} = await captureOutput(async () =>
		{
			await Complete.run(["--id", SHORT_ID, "--dry-run"]);
		});

		expect(stdout).toBe(
			`Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/${FULL_ID}/complete\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n\nNode: Test Node\n`,
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("expands a short id to the full UUID before uncompleting", async () =>
	{
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: FULL_ID,
						name: "Test Node",
						parentId: null,
					},
				),
			]),
		);

		const {stdout} = await captureOutput(async () =>
		{
			await Uncomplete.run(["--id", SHORT_ID, "--dry-run"]);
		});

		expect(stdout).toBe(
			`Would execute API call:\n  Method: POST\n  URL: https://workflowy.com/api/v1/nodes/${FULL_ID}/uncomplete\n  Headers:\n    Authorization: Bearer <WORKFLOWY_API_KEY>\n    Content-Type: application/json\n\nNode: Test Node\n`,
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("completes locally and delivers the completion, then uncompletes the same way", async () =>
	{
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: FULL_ID,
						name: "Test Node",
						parentId: null,
					},
				),
			]),
		);
		const upstream = fakeUpstream(fetchStub, testDatabase, tempDir);
		const completed = () => new CacheService(testDatabase.db).getNode(FULL_ID)?.completedAt !== null;

		const complete = await captureOutput(async () =>
		{
			await Complete.run(["--id", SHORT_ID]);
		});
		const afterComplete = completed();
		const uncomplete = await captureOutput(async () =>
		{
			await Uncomplete.run(["--id", SHORT_ID]);
		});

		expect(
			{
				complete,
				afterComplete,
				uncomplete,
				afterUncomplete: completed(),
				types: upstream.pushes.map((ops) => ops.map((op) => op.type)),
				pending: pendingOutbox(testDatabase),
			},
		).toStrictEqual(
			{
				complete:
				{
					stdout: "Marking node as completed: Test Node\n\n✓ Successfully marked node as completed\n",
					stderr: "",
					result: undefined,
				},
				afterComplete: true,
				uncomplete:
				{
					stdout: "Marking node as not completed: Test Node\n\n✓ Successfully marked node as not completed\n",
					stderr: "",
					result: undefined,
				},
				afterUncomplete: false,
				types: [["complete"], ["uncomplete"]],
				pending: [],
			},
		);
	});

	it("rejects a short id that is not in the cache", async () =>
	{
		await expect(Complete.run(["--id", "ffffffffffff", "--dry-run"])).rejects.toThrow(
			"No node found for short ID: ffffffffffff",
		);
	});
});
