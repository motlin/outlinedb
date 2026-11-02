import {beforeAll, afterAll, describe, expect, it} from "vite-plus/test";
import {findSameTitleSiblings, resolveInboxLinks} from "../../src/services/inbox-registry.js";
import {cleanupTestDatabase, createInMemoryTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";

const LIVE_INBOX_ID = "aaaaaaaa-aaaa-aaaa-aaaa-41bd95477fbc";
const DELETED_INBOX_SHORT_ID = "03bdae87b4e1";

function linkName(shortId: string, text = "Inbox"): string
{
	return `<a href="https://workflowy.com/#/${shortId}">${text}</a>`;
}

describe("inbox registry", () =>
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

	it("resolves live links and reports links whose target is missing from the cache", () =>
	{
		seedTestData(
			database,
			nodeFixtures([
				createTestNode(
					{
						id: LIVE_INBOX_ID,
						name: "Inbox",
					},
				),
			]),
		);
		const result = resolveInboxLinks(database.db, [
			{
				id: "link-live",
				name: linkName("41bd95477fbc", "Personal 📥 Inbox"),
			},
			{
				id: "link-broken",
				name: linkName(DELETED_INBOX_SHORT_ID),
			},
			{
				id: "plain",
				name: "Work 📥 Inbox",
			},
		]);
		expect(result).toStrictEqual(
			{
				targets: new Map([["link-live", LIVE_INBOX_ID]]),
				broken: [
					{
						linkId: "link-broken",
						name: "Inbox",
						shortId: DELETED_INBOX_SHORT_ID,
					},
				],
			},
		);
	});

	it("flags open same-title siblings as probable duplicates, ignoring markup, case, and completed items", () =>
	{
		expect(
			findSameTitleSiblings([
				{
					id: "a",
					name: "Cancel Backblaze",
					completed: false,
				},
				{
					id: "b",
					name: "Buy milk",
					completed: false,
				},
				{
					id: "c",
					name: "<b>cancel  backblaze</b> ",
					completed: false,
				},
				{
					id: "d",
					name: "Buy milk",
					completed: true,
				},
				{
					id: "e",
					name: "",
					completed: false,
				},
				{
					id: "f",
					name: "",
					completed: false,
				},
			]),
		).toStrictEqual([
			{
				title: "Cancel Backblaze",
				ids: ["a", "c"],
			},
		]);
	});
});
