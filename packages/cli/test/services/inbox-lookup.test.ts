import {findInbox, runUnitOfWork, writeAccountSnapshot} from "@workflowy/shared/cache";
import {rootPreferences} from "@workflowy/shared/db";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vite-plus/test";
import {findUnregisteredInboxes} from "../../src/services/unregistered-inboxes.js";
import {cleanupTestDatabase, createInMemoryTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";

describe("findInbox", () => {
	let database: TestDatabase;
	beforeAll(() => {
		database = createInMemoryTestDatabase();
	});
	beforeEach(() => {
		database.db.delete(rootPreferences).run();
	});
	afterAll(() => {
		cleanupTestDatabase(database);
	});

	function pointInboxAt(inboxId: string): void {
		runUnitOfWork(database.db, (unitOfWork) => {
			writeAccountSnapshot(unitOfWork, {
				account: {userId: 1, dateJoinedSec: 2},
				rootMetadata: {inbox_id: inboxId},
				settings: {},
				visibleFeatures: [],
			});
		});
	}

	it("returns the live node root metadata inbox_id names, even when renamed or nested", () => {
		seedTestData(
			database,
			nodeFixtures([
				createTestNode({id: "home-inbox", name: "Inbox", parentId: null}),
				createTestNode({id: "personal", name: "Personal", parentId: null}),
				createTestNode({id: "renamed", name: "📥 Capture", parentId: "personal"}),
			]),
		);
		pointInboxAt("renamed");
		expect(findInbox(database.db)).toStrictEqual({id: "renamed", name: "📥 Capture", source: "inbox_id"});
	});

	it("falls back to the top-level node named Inbox when inbox_id is unset", () => {
		seedTestData(
			database,
			nodeFixtures([
				createTestNode({id: "nested", name: "Inbox", parentId: "personal"}),
				createTestNode({id: "personal", name: "Personal", parentId: null}),
				createTestNode({id: "home-inbox", name: "<b>Inbox</b>", parentId: null}),
			]),
		);
		expect(findInbox(database.db)).toStrictEqual({id: "home-inbox", name: "Inbox", source: "name"});
	});

	it("falls back to the named node when inbox_id points at a deleted node", () => {
		seedTestData(database, nodeFixtures([createTestNode({id: "home-inbox", name: "Inbox", parentId: null})]));
		pointInboxAt("deleted-node");
		expect(findInbox(database.db)).toStrictEqual({id: "home-inbox", name: "Inbox", source: "name"});
	});

	it("returns undefined when neither inbox_id nor a top-level Inbox resolves", () => {
		seedTestData(database, nodeFixtures([createTestNode({id: "personal", name: "Personal", parentId: null})]));
		expect(findInbox(database.db)).toBeUndefined();
	});

	it("flags the inbox_id node as unregistered even when it is not named Inbox", () => {
		seedTestData(
			database,
			nodeFixtures([
				createTestNode({id: "personal", name: "Personal", parentId: null}),
				createTestNode({id: "renamed", name: "📥 Capture", parentId: "personal"}),
			]),
		);
		pointInboxAt("renamed");
		expect({
			unregistered: findUnregisteredInboxes(database.db, new Set()),
			registered: findUnregisteredInboxes(database.db, new Set(["renamed"])),
		}).toStrictEqual({
			unregistered: [{id: "renamed", name: "📥 Capture", path: "Personal > 📥 Capture"}],
			registered: [],
		});
	});
});
