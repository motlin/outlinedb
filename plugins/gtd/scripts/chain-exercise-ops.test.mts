// Run: node --test plugins/gtd/scripts/chain-exercise-ops.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseProposalFile, resolveExerciseProposals, validateExerciseChain} from "./chain-exercise-ops.mts";
import type {ChainedOp, ProposalEntry, ProposalFile} from "./chain-exercise-ops.mts";

const fixture = (name: string): ProposalFile =>
	parseProposalFile(
		JSON.parse(readFileSync(new URL(`fixtures/exercise-chain/${name}.json`, import.meta.url), "utf8")),
		name,
	);

const entryAt = (file: ProposalFile, index: number): ProposalEntry =>
{
	const entry = file.proposals[index];
	if (entry === undefined)
	{
		throw new Error(`fixture has no proposals[${index}]`);
	}
	return entry;
};

const chainedOf = (entry: ProposalEntry): ChainedOp =>
{
	if (entry.chained === undefined)
	{
		throw new Error(`${entry.nodeId} has no chained op`);
	}
	return entry.chained;
};

const OVERLAP_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const SOLO_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const JOURNAL_AFTER = "#program phase 2 week 3 day 2 back and biceps with @Alice. #exercise";
const LIVE_BEFORE = "#program phase 2 week 3 day 2 back and biceps with Alice. #exercise";
const SOLO_BEFORE = "💪 #Program phase 2 week 3 day 4 cardio #exercise";

const soloResolved = (): ProposalEntry => (
{
	nodeId: SOLO_ID,
	header: "Sep 5",
	before: SOLO_BEFORE,
	after: "💪 #Program phase 2, week 3, day 4, Cardio #exercise",
	changes: entryAt(fixture("refine-exercise"), 1).changes,
	applyOps: entryAt(fixture("refine-exercise"), 1).applyOps,
});

test("the fixture chains the overlapping entry on the journal after text", () =>
{
	assert.deepStrictEqual(
		validateExerciseChain(fixture("refine-exercise"), fixture("refine-journal")),
		{
			valid: true,
			errors: [],
		},
	);
});

test("rejects an overlapping entry staged with only the live-text op", () =>
{
	const exercise = fixture("refine-exercise");
	delete entryAt(exercise, 0).chained;

	assert.deepStrictEqual(
		validateExerciseChain(exercise, fixture("refine-journal")),
		{
			valid: false,
			errors: [
				`proposals[0]: ${OVERLAP_ID} is also staged by refine-journal but carries no "chained" op — accepting the journal proposal would stale-skip it`,
			],
		},
	);
});

test("rejects a chained op keyed on text other than the journal after", () =>
{
	const exercise = fixture("refine-exercise");
	chainedOf(entryAt(exercise, 0)).before = LIVE_BEFORE;

	assert.deepStrictEqual(
		validateExerciseChain(exercise, fixture("refine-journal")),
		{
			valid: false,
			errors: [`proposals[0]: chained.before does not equal the refine-journal after text for ${OVERLAP_ID}`],
		},
	);
});

test("rejects a chained name update without --expect-name", () =>
{
	const exercise = fixture("refine-exercise");
	chainedOf(entryAt(exercise, 0)).applyOps = [`./bin/run.js node update --id ${OVERLAP_ID} --name 'x'`];

	assert.deepStrictEqual(
		validateExerciseChain(exercise, fixture("refine-journal")),
		{
			valid: false,
			errors: ["proposals[0]: chained.applyOps[0] updates --name without --expect-name"],
		},
	);
});

test("runs the chained op when the journal proposal was accepted", () =>
{
	const exercise = fixture("refine-exercise");
	const live =
	{
		[OVERLAP_ID]: JOURNAL_AFTER,
		[SOLO_ID]: SOLO_BEFORE,
	};

	assert.deepStrictEqual(
		resolveExerciseProposals(exercise, live),
		{
			...exercise,
			proposals: [
				{
					nodeId: OVERLAP_ID,
					header: "Sep 3",
					before: JOURNAL_AFTER,
					after: "💪 #Program phase 2, week 3, day 2, Back and Biceps with @Alice #exercise",
					changes: entryAt(exercise, 0).changes,
					applyOps: chainedOf(entryAt(exercise, 0)).applyOps,
				},
				soloResolved(),
			],
		},
	);
});

test("runs the fallback op when the journal proposal was rejected", () =>
{
	const exercise = fixture("refine-exercise");
	const live =
	{
		[OVERLAP_ID]: LIVE_BEFORE,
		[SOLO_ID]: SOLO_BEFORE,
	};

	assert.deepStrictEqual(
		resolveExerciseProposals(exercise, live),
		{
			...exercise,
			proposals: [
				{
					nodeId: OVERLAP_ID,
					header: "Sep 3",
					before: LIVE_BEFORE,
					after: "💪 #Program phase 2, week 3, day 2, Back and Biceps with Alice #exercise",
					changes: entryAt(exercise, 0).changes,
					applyOps: entryAt(exercise, 0).applyOps,
				},
				soloResolved(),
			],
		},
	);
});

test("keeps the fallback when the entry drifted from both texts, so --expect-name stale-skips it", () =>
{
	const exercise = fixture("refine-exercise");
	const live =
	{
		[OVERLAP_ID]: "hand-edited during the journal walk",
		[SOLO_ID]: SOLO_BEFORE,
	};

	assert.deepStrictEqual(
		entryAt(resolveExerciseProposals(exercise, live), 0).applyOps,
		entryAt(exercise, 0).applyOps,
	);
});

test("drops an entry whose accepted journal text is already canonical", () =>
{
	const exercise = fixture("refine-exercise");
	chainedOf(entryAt(exercise, 0)).after = JOURNAL_AFTER;
	chainedOf(entryAt(exercise, 0)).applyOps = [];
	const live =
	{
		[OVERLAP_ID]: JOURNAL_AFTER,
		[SOLO_ID]: SOLO_BEFORE,
	};

	assert.deepStrictEqual(
		resolveExerciseProposals(exercise, live),
		{
			...exercise,
			proposals: [soloResolved()],
			status: "ready",
		},
	);
});

test("marks the file empty when every proposal drops", () =>
{
	const exercise = fixture("refine-exercise");
	exercise.proposals = [entryAt(exercise, 0)];
	chainedOf(entryAt(exercise, 0)).after = JOURNAL_AFTER;
	chainedOf(entryAt(exercise, 0)).applyOps = [];

	assert.deepStrictEqual(
		resolveExerciseProposals(
			exercise,
			{
				[OVERLAP_ID]: JOURNAL_AFTER,
			},
		),
		{
			...exercise,
			proposals: [],
			status: "empty",
		},
	);
});
