import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {nodeContent, nodeLabelSuggestions} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {asc} from "drizzle-orm";
import {entriesToScore, saveLabelSuggestions} from "../../src/services/label-suggestions.js";
import {cleanupTestDatabase, createInMemoryTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";

const ENTRY = "entry-1";
const OTHER = "entry-2";
const EDITED_AT = "2026-11-03 21:14:02.000";
const FIRST_RUN = "2026-11-04 06:00:11.000";
const SECOND_RUN = "2026-11-05 06:00:11.000";

describe("label suggestions persistence", () =>
{
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		testDatabase = createInMemoryTestDatabase();
		testDatabase.db
			.insert(nodeContent)
			.values([
				{
					id: ENTRY,
					name: "Played pickleball with Alice",
					note: null,
					parentId: "day",
					systemFrom: EDITED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
				{
					id: OTHER,
					name: "Dentist",
					note: null,
					parentId: "day",
					systemFrom: EDITED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
			])
			.run();
	});

	afterEach(() =>
	{
		cleanupTestDatabase(testDatabase);
	});

	function allRows()
	{
		return testDatabase.db
			.select()
			.from(nodeLabelSuggestions)
			.orderBy(
				asc(nodeLabelSuggestions.systemFrom),
				asc(nodeLabelSuggestions.source),
				asc(nodeLabelSuggestions.label),
			)
			.all();
	}

	it("writes one live row per label and source, stamped with the content version it scored", () =>
	{
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef-flash-shortlist",
					score: 0.62,
				},
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef-flash",
					score: 0.98,
				},
			],
			FIRST_RUN,
		);

		expect(allRows()).toStrictEqual([
			{
				nodeId: ENTRY,
				label: "#pickleball",
				labelKind: "tag",
				source: "clef-flash",
				score: 0.98,
				contentFrom: EDITED_AT,
				systemFrom: FIRST_RUN,
				systemTo: FAR_FUTURE_DATE,
			},
			{
				nodeId: ENTRY,
				label: "#pickleball",
				labelKind: "tag",
				source: "clef-flash-shortlist",
				score: 0.62,
				contentFrom: EDITED_AT,
				systemFrom: FIRST_RUN,
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("re-scoring closes every live row of that entry and inserts the new scores, leaving other entries alone", () =>
	{
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef-flash",
					score: 0.98,
				},
				{
					label: "@AliceChen",
					kind: "person",
					source: "clef-flash",
					score: 0.07,
				},
			],
			FIRST_RUN,
		);
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: OTHER,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#health",
					kind: "tag",
					source: "clef-flash",
					score: 0.9,
				},
			],
			FIRST_RUN,
		);

		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef",
					score: 0.95,
				},
			],
			SECOND_RUN,
		);

		expect(allRows()).toStrictEqual([
			{
				nodeId: OTHER,
				label: "#health",
				labelKind: "tag",
				source: "clef-flash",
				score: 0.9,
				contentFrom: EDITED_AT,
				systemFrom: FIRST_RUN,
				systemTo: FAR_FUTURE_DATE,
			},
			{
				nodeId: ENTRY,
				label: "#pickleball",
				labelKind: "tag",
				source: "clef-flash",
				score: 0.98,
				contentFrom: EDITED_AT,
				systemFrom: FIRST_RUN,
				systemTo: SECOND_RUN,
			},
			{
				nodeId: ENTRY,
				label: "@AliceChen",
				labelKind: "person",
				source: "clef-flash",
				score: 0.07,
				contentFrom: EDITED_AT,
				systemFrom: FIRST_RUN,
				systemTo: SECOND_RUN,
			},
			{
				nodeId: ENTRY,
				label: "#pickleball",
				labelKind: "tag",
				source: "clef",
				score: 0.95,
				contentFrom: EDITED_AT,
				systemFrom: SECOND_RUN,
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("needs scoring for entries never scored and entries edited since their live scores, skipping fresh ones", () =>
	{
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef-flash",
					score: 0.98,
				},
			],
			FIRST_RUN,
		);

		expect(
			entriesToScore(
				testDatabase.db,
				[ENTRY, OTHER, "missing"],
				{
					force: false,
				},
			),
		).toStrictEqual([
			{
				nodeId: OTHER,
				contentFrom: EDITED_AT,
			},
		]);
	});

	it("treats live rows as stale once node_content.system_from moves past their content_from", () =>
	{
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef-flash",
					score: 0.98,
				},
			],
			FIRST_RUN,
		);
		const reEditedAt = "2026-11-04 20:00:00.000";
		testDatabase.sqlite
			.prepare("UPDATE node_content SET system_to = ? WHERE id = ? AND system_to = ?")
			.run(reEditedAt, ENTRY, FAR_FUTURE_DATE);
		testDatabase.db
			.insert(nodeContent)
			.values(
				{
					id: ENTRY,
					name: "Played pickleball with Alice and Bob",
					note: null,
					parentId: "day",
					systemFrom: reEditedAt,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();

		expect(
			entriesToScore(
				testDatabase.db,
				[ENTRY],
				{
					force: false,
				},
			),
		).toStrictEqual([
			{
				nodeId: ENTRY,
				contentFrom: reEditedAt,
			},
		]);
	});

	it("an entry whose only scores are closed needs scoring again", () =>
	{
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef-flash",
					score: 0.98,
				},
			],
			FIRST_RUN,
		);
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[],
			SECOND_RUN,
		);

		expect(
			entriesToScore(
				testDatabase.db,
				[ENTRY],
				{
					force: false,
				},
			),
		).toStrictEqual([
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
		]);
	});

	it("--force rescoring returns fresh entries too, in the order asked", () =>
	{
		saveLabelSuggestions(
			testDatabase.db,
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
			[
				{
					label: "#pickleball",
					kind: "tag",
					source: "clef-flash",
					score: 0.98,
				},
			],
			FIRST_RUN,
		);

		expect(
			entriesToScore(
				testDatabase.db,
				[OTHER, ENTRY, "missing"],
				{
					force: true,
				},
			),
		).toStrictEqual([
			{
				nodeId: OTHER,
				contentFrom: EDITED_AT,
			},
			{
				nodeId: ENTRY,
				contentFrom: EDITED_AT,
			},
		]);
	});
});
