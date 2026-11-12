import {createHash} from "node:crypto";
import {beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import {findUnregisteredInboxes} from "../../src/services/unregistered-inboxes.js";
import {cleanupTestDatabase, createInMemoryTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";

describe("unregistered inbox diagnostics", () =>
{
	let database: TestDatabase;
	beforeAll(() =>
	{
		database = createInMemoryTestDatabase();
	});
	afterAll(() =>
	{
		cleanupTestDatabase(database);
	});

	it("finds nested inboxes beyond the search default and excludes registered IDs and non-inbox names", () =>
	{
		seedTestData(
			database,
			nodeFixtures([
				...Array.from(
					{
						length: 30,
					},
					(_, index) =>
						createTestNode(
							{
								id: `registered-${index}`,
								name: "Inbox",
							},
						),
				),
				createTestNode(
					{
						id: "work",
						name: "Work",
					},
				),
				createTestNode(
					{
						id: "reference",
						name: "Reference",
						parentId: "work",
					},
				),
				createTestNode(
					{
						id: "nested",
						name: "<b>📥 Inbox</b>",
						parentId: "reference",
					},
				),
				createTestNode(
					{
						id: "root",
						name: "Inbox",
					},
				),
				createTestNode(
					{
						id: "plural",
						name: "📥 Inboxes",
					},
				),
				createTestNode(
					{
						id: "note",
						name: "Task",
						note: "Inbox",
					},
				),
				createTestNode(
					{
						id: "prefix",
						name: "Inbox reminders",
					},
				),
				createTestNode(
					{
						id: "link",
						name: '<a href="https://example.com">Inbox</a>',
					},
				),
			]),
		);
		// Deep-equality over the raw database bytes walks them one index at a time; a digest compares the same bytes in milliseconds.
		const digest = (): string => createHash("sha256").update(database.sqlite.serialize()).digest("hex");
		const before = digest();
		const registeredIds = new Set([
			...Array.from(
				{
					length: 30,
				},
				(_, index) => `registered-${index}`,
			),
			"link",
		]);
		expect(findUnregisteredInboxes(database.db, registeredIds)).toStrictEqual([
			{
				id: "nested",
				name: "📥 Inbox",
				path: "Work > Reference > 📥 Inbox",
			},
			{
				id: "root",
				name: "Inbox",
				path: "Inbox",
			},
		]);
		expect(digest()).toStrictEqual(before);
	});

	it("returns no warnings when all inbox nodes are registered", () =>
	{
		seedTestData(
			database,
			nodeFixtures([
				createTestNode(
					{
						id: "registered",
						name: "📥 Inbox",
					},
				),
			]),
		);
		expect(findUnregisteredInboxes(database.db, new Set(["registered"]))).toStrictEqual([]);
	});
});
