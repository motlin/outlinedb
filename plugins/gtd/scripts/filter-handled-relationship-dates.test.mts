// Run: node --test plugins/gtd/scripts/filter-handled-relationship-dates.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {filterHandled, filterHandledFile} from "./filter-handled-relationship-dates.mts";

const staged =
{
	task: "birthdays",
	status: "ready",
	proposals: [
		{
			person: "@Alice",
			field: "🎂 Birthday",
			occurrence: "2026-11-17",
			daysAgo: 4,
		},
		{
			person: "@Bob",
			field: "🎂 Birthday",
			occurrence: "2026-11-16",
			daysAgo: 5,
		},
		{
			person: "@Carol",
			field: "💍 Anniversary",
			occurrence: "2026-11-15",
			daysAgo: 6,
		},
	],
	summary:
	{
		backlogStaged: 3,
	},
};

const handled = [
	{
		person: "@Alice",
		field: "🎂 Birthday",
		occurrence: "2026-11-17",
		decision: "still-owed",
		decidedAt: "2026-11-14",
	},
	{
		person: "@Bob",
		field: "🎂 Birthday",
		occurrence: "2025-11-16",
		decision: "handled",
		decidedAt: "2025-11-20",
	},
	{
		key: "@Carol:💍 Anniversary:2026-11-15",
		person: "@Carol",
		field: "💍 Anniversary",
		occurrence: "2026-11-15",
		decision: "handled",
		decidedAt: "2026-11-15",
	},
];

test("filterHandled drops proposals whose person:field:occurrence is recorded under any decision, keeping other years", () =>
{
	assert.deepStrictEqual(
		filterHandled(staged, handled),
		{
			staged:
			{
				task: "birthdays",
				status: "ready",
				proposals: [
					{
						person: "@Bob",
						field: "🎂 Birthday",
						occurrence: "2026-11-16",
						daysAgo: 5,
					},
				],
				summary:
				{
					backlogStaged: 1,
				},
			},
			dropped: ["@Alice:🎂 Birthday:2026-11-17", "@Carol:💍 Anniversary:2026-11-15"],
		},
	);
});

test("filterHandledFile rewrites the staged file in place and treats a missing handled file as empty", () =>
{
	const directory = mkdtempSync(join(tmpdir(), "filter-handled-"));
	const stagedPath = join(directory, "birthdays.json");
	const handledPath = join(directory, "relationship-dates-handled.json");
	writeFileSync(stagedPath, JSON.stringify(staged));

	assert.deepStrictEqual(filterHandledFile(stagedPath, join(directory, "missing.json")), []);
	assert.deepStrictEqual(JSON.parse(readFileSync(stagedPath, "utf8")), staged);

	writeFileSync(handledPath, JSON.stringify(handled));
	assert.deepStrictEqual(filterHandledFile(stagedPath, handledPath), [
		"@Alice:🎂 Birthday:2026-11-17",
		"@Carol:💍 Anniversary:2026-11-15",
	]);
	assert.deepStrictEqual(
		JSON.parse(readFileSync(stagedPath, "utf8")),
		{
			...staged,
			proposals: [staged.proposals[1]],
			summary:
			{
				backlogStaged: 1,
			},
		},
	);
});
