import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import MigrateDates from "../../../src/commands/calendar/migrate-dates.js";
import {CacheService} from "../../../src/services/cache.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {fakeUpstream, pendingOutbox} from "../../helpers/upstream-outbox.js";

const ARCHIVE = "00000000-0000-4000-8000-0000000a7c41";

describe("calendar migrate-dates command", () =>
{
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		originalEnv =
		{
			...process.env,
		};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-migrate-dates-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
	});

	afterEach(() =>
	{
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("renames each text-dated day locally and keeps the renames pending when workflowy.com rejects the drain", async () =>
	{
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode(
					{
						id: ARCHIVE,
						name: "Archive",
						parentId: null,
					},
				),
				createTestNode(
					{
						id: "y2020",
						name: "2020",
						parentId: ARCHIVE,
					},
				),
				createTestNode(
					{
						id: "nov",
						name: "November",
						parentId: "y2020",
					},
				),
				createTestNode(
					{
						id: "day",
						name: "Tue, Nov 17, 2020",
						parentId: "nov",
					},
				),
			]),
		);
		const upstream = fakeUpstream(
			vi.spyOn(globalThis, "fetch"),
			testDatabase,
			tempDir,
			{
				failPush: true,
			},
		);

		const {error} = await captureOutput(async () =>
		{
			await MigrateDates.run(["--archive-id", "0000000a7c41"]);
		});

		expect(
			{
				exit: error?.oclif?.exit,
				name: new CacheService(testDatabase.db).getNode("day")?.name,
				pushes: upstream.pushes,
				pending: pendingOutbox(testDatabase).map(({nodeId, aspect}) => [nodeId, aspect]),
			},
		).toStrictEqual(
			{
				exit: 1,
				name: '<time startYear="2020" startMonth="11" startDay="17">Tue, Nov 17, 2020</time>',
				pushes: [],
				pending: [["day", "name"]],
			},
		);
	});
});
