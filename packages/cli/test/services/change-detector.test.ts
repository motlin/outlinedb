import {beforeEach, afterEach, describe, expect, it} from "vite-plus/test";
import {ChangeDetector} from "@outlinedb/shared/changes";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {cleanupTestDatabase, createInMemoryTestDatabase, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";

const BEFORE = "2026-01-01 00:00:00.000";
const CUTOFF = new Date("2026-01-02T00:00:00.000Z");
const AFTER = "2026-01-03 00:00:00.000";

function content(id: string, name: string | null, parentId: string | null, systemFrom: string, systemTo: string)
{
	return {
		id,
		name,
		note: null,
		parentId,
		systemFrom,
		systemTo,
	};
}

/**
 * A mirror never has text of its own, so stale text stored on a mirror row
 * changing is not a change. Its own position, completion, creation, and
 * deletion still are, and it is labelled with its original's text.
 */
describe("ChangeDetector on mirrors", () =>
{
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		testDatabase = createInMemoryTestDatabase();
		seedTestData(
			testDatabase,
			{
				nodeContent: [
					content("p", "Parent", null, BEFORE, FAR_FUTURE_DATE),
					content("q", "Other parent", null, BEFORE, FAR_FUTURE_DATE),
					content("orig", "Old title", "q", BEFORE, AFTER),
					content("orig", "New title", "q", AFTER, FAR_FUTURE_DATE),
					// Stale mirror text churning in place.
					content("mir-stale", "Stale A", "p", BEFORE, AFTER),
					content("mir-stale", "Stale B", "p", AFTER, FAR_FUTURE_DATE),
					// A mirror moved to another parent, with churning stale text.
					content("mir-moved", "Stale C", "p", BEFORE, AFTER),
					content("mir-moved", "Stale D", "q", AFTER, FAR_FUTURE_DATE),
				],
				mirrors: [
					{
						originalId: "orig",
						mirrorId: "mir-stale",
						systemFrom: BEFORE,
						systemTo: FAR_FUTURE_DATE,
					},
					{
						originalId: "orig",
						mirrorId: "mir-moved",
						systemFrom: BEFORE,
						systemTo: FAR_FUTURE_DATE,
					},
				],
			},
		);
	});

	afterEach(() =>
	{
		cleanupTestDatabase(testDatabase);
	});

	it("ignores stale mirror text, keeps mirror moves, and labels mirrors with the original", () =>
	{
		const result = new ChangeDetector(testDatabase.db).detectChanges(CUTOFF);

		const change =
		{
			isNew: false,
			isDeleted: false,
			completionChanged: false,
			noteChanged: false,
			oldNote: null,
			oldCompletedAt: null,
			currentNote: null,
			currentCompletedAt: null,
		};
		const origChange =
		{
			...change,
			id: "orig",
			contentChanged: true,
			parentChanged: false,
			oldName: "Old title",
			oldParentId: "q",
			currentName: "New title",
			currentParentId: "q",
			parentId: "q",
		};
		const movedChange =
		{
			...change,
			id: "mir-moved",
			contentChanged: false,
			parentChanged: true,
			oldName: "Old title",
			oldParentId: "p",
			currentName: "New title",
			currentParentId: "q",
			parentId: "q",
		};
		expect(result).toStrictEqual(
			{
				changes: [origChange, movedChange],
				tree: [
					{
						id: "q",
						name: "Other parent",
						isContext: true,
						change: null,
						children: [
							{
								id: "orig",
								name: "New title",
								isContext: false,
								change: origChange,
								children: [],
							},
							{
								id: "mir-moved",
								name: "New title",
								isContext: false,
								change: movedChange,
								children: [],
							},
						],
					},
				],
				summary:
				{
					added: 0,
					deleted: 0,
					changed: 1,
					moved: 1,
					completed: 0,
					uncompleted: 0,
				},
				cutoffDate: CUTOFF,
			},
		);
	});
});
