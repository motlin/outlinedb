import {findInbox, runUnitOfWork, writeAccountSnapshot} from "@outlinedb/shared/cache";
import {rootPreferences} from "@outlinedb/shared/db";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vite-plus/test";
import {findUnregisteredInboxes} from "../../src/services/unregistered-inboxes.js";
import {cleanupTestDatabase, createInMemoryTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";
import {findSameTitleSiblings, resolveInboxLinks} from "../../src/services/inbox-registry.js";

describe("inbox lookup", () => {
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
					account: {userId: "1", dateJoinedSec: 2},
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
});

describe("inbox registry", () => {
	const LIVE_INBOX_ID = "aaaaaaaa-aaaa-aaaa-aaaa-41bd95477fbc";
	const DELETED_INBOX_SHORT_ID = "03bdae87b4e1";

	function linkName(shortId: string, text = "Inbox"): string {
		return `<a href="https://workflowy.com/#/${shortId}">${text}</a>`;
	}

	describe("inbox registry", () => {
		let database: TestDatabase;
		beforeAll(() => {
			database = createInMemoryTestDatabase();
		});
		afterAll(() => {
			cleanupTestDatabase(database);
		});

		it("resolves live links and reports links whose target is missing from the cache", () => {
			seedTestData(database, nodeFixtures([createTestNode({id: LIVE_INBOX_ID, name: "Inbox"})]));
			const result = resolveInboxLinks(database.db, [
				{id: "link-live", name: linkName("41bd95477fbc", "Personal 📥 Inbox")},
				{id: "link-broken", name: linkName(DELETED_INBOX_SHORT_ID)},
				{id: "plain", name: "Work 📥 Inbox"},
			]);
			expect(result).toStrictEqual({
				targets: new Map([["link-live", LIVE_INBOX_ID]]),
				broken: [{linkId: "link-broken", name: "Inbox", shortId: DELETED_INBOX_SHORT_ID}],
			});
		});

		it("flags open same-title siblings as probable duplicates, ignoring markup, case, and completed items", () => {
			expect(
				findSameTitleSiblings([
					{id: "a", name: "Cancel Backblaze", completed: false},
					{id: "b", name: "Buy milk", completed: false},
					{id: "c", name: "<b>cancel  backblaze</b> ", completed: false},
					{id: "d", name: "Buy milk", completed: true},
					{id: "e", name: "", completed: false},
					{id: "f", name: "", completed: false},
				]),
			).toStrictEqual([{title: "Cancel Backblaze", ids: ["a", "c"]}]);
		});
	});
});
