import {captureOutput} from "@oclif/test";
import {runUnitOfWork, writeAccountSnapshot} from "@outlinedb/shared/cache";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import AccountInbox from "../../../../src/commands/gtd/inboxes/account.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../../db/migration-helper.js";
import type {TestDatabase} from "../../../db/migration-helper.js";
import {createTestNode} from "../../../helpers/node-fixtures.js";

describe("gtd inboxes account command", () => {
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() => {
		originalEnv = {...process.env};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-account-inbox-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
	});

	afterEach(() => {
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("prints the node root metadata inbox_id names with its path", async () => {
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode({id: "personal", name: "Personal", parentId: null}),
				createTestNode({id: "inbox-node", name: "Inbox", parentId: "personal"}),
			]),
		);
		runUnitOfWork(testDatabase.db, (unitOfWork) => {
			writeAccountSnapshot(unitOfWork, {
				account: {userId: 1, dateJoinedSec: 2},
				rootMetadata: {inbox_id: "inbox-node"},
				settings: {},
				visibleFeatures: [],
			});
		});
		const {stdout, error} = await captureOutput(async () => AccountInbox.run([]));
		expect({error, result: JSON.parse(stdout) as unknown}).toStrictEqual({
			error: undefined,
			result: {id: "inbox-node", name: "Inbox", path: "Personal > Inbox", source: "inbox_id"},
		});
	});

	it("fails when no Inbox resolves", async () => {
		seedTestData(testDatabase, nodeFixtures([createTestNode({id: "personal", name: "Personal", parentId: null})]));
		const {error} = await captureOutput(async () => AccountInbox.run([]));
		expect(error?.message).toBe(
			"No Inbox found: root metadata inbox_id is unset or deleted and Home has no node named Inbox",
		);
	});
});
