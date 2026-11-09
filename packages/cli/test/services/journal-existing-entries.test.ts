import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {CacheService} from "@outlinedb/shared/cache";
import {loadExistingEntries} from "../../src/services/journal-existing-entries.js";
import {cleanupTestDatabase, createInMemoryTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {seedTaggedCalendar} from "../helpers/calendar-fixture.js";

describe("loadExistingEntries", () => {
	let testDatabase: TestDatabase;

	beforeEach(() => {
		testDatabase = createInMemoryTestDatabase();
		seedTaggedCalendar(testDatabase);
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);
	});

	it("reads each date's entries from the day node workflowy.com uses, not from month-level rows that mention the date", () => {
		const existing = loadExistingEntries(testDatabase.db, new CacheService(testDatabase.db), [
			"2026-10-05",
			"2026-10-06",
			"2026-10-07",
		]);

		expect(existing).toStrictEqual({"2026-10-05": ["Dentist"]});
	});
});
