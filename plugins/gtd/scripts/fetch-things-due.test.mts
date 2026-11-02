// Run: node --test plugins/gtd/scripts/fetch-things-due.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import
{
	FIELD_SEP,
	OSASCRIPT_TIMEOUT_MS,
	parseThingsRows,
	partitionThings,
	RECORD_SEP,
	script,
} from "./fetch-things-due.mts";
import type {ThingsTask} from "./fetch-things-due.mts";

const row = (...fields: string[]): string => fields.join(FIELD_SEP);
const out = (...rows: string[]): string => rows.join(RECORD_SEP) + RECORD_SEP;

test("partitionThings carries the Someday list through for the Workflowy sweep", () =>
{
	// Someday is a third backlog that nothing prunes. It has to reach the sweep as its own
	// set, and a task already sitting in Today or Anytime must not be duplicated into it.
	const shared: ThingsTask =
	{
		id: "dup",
		title: "In both lists",
		due: null,
		list: "Anytime",
		notes: null,
	};
	const sets = partitionThings(
		{
			todayList: [],
			anytime: [shared],
			someday: [
				shared,
				{
					id: "s1",
					title: "Learn woodworking",
					due: null,
					list: "Someday",
					notes: null,
				},
			],
		},
		"2026-08-27",
	);
	assert.deepStrictEqual(
		sets.someday.map((t) => t.id),
		["s1"],
	);
});

test("parseThingsRows splits the record-separated AppleScript output", () =>
{
	const raw = out(
		row("JMwVZ", "Pay temple dues", "2026-8-1", "Today", "bring the receipt", "2026-7-30"),
		row("9XHRt", "FreshDirect order", "", "Today", "", ""),
	);

	// The notes come along because the walk shows an item's context before asking about it.
	assert.deepStrictEqual(parseThingsRows(raw), [
		{
			id: "JMwVZ",
			title: "Pay temple dues",
			due: "2026-08-01",
			list: "Today",
			notes: "bring the receipt",
			activationDate: "2026-07-30",
		},
		{
			id: "9XHRt",
			title: "FreshDirect order",
			due: null,
			list: "Today",
			notes: null,
			activationDate: null,
		},
	]);
});

test("parseThingsRows zero-pads single-digit months and days", () =>
{
	assert.strictEqual(parseThingsRows(out(row("a", "T", "2026-3-9", "Anytime", "", "")))[0]?.due, "2026-03-09");
});

test("parseThingsRows returns nothing for empty output", () =>
{
	assert.deepStrictEqual(parseThingsRows(""), []);
	assert.deepStrictEqual(parseThingsRows(RECORD_SEP), []);
});

test("parseThingsRows preserves titles containing newlines and pipes", () =>
{
	// Control-character separators are used precisely so ordinary punctuation in a task title
	// cannot corrupt the parse.
	const raw = out(row("x", "Buy milk | eggs\nand bread", "", "Today", "", ""));
	assert.strictEqual(parseThingsRows(raw)[0]?.title, "Buy milk | eggs\nand bread");
});

test("parseThingsRows skips malformed records rather than emitting partial rows", () =>
{
	const raw = out(row("good", "Fine", "", "Today", "", ""), "truncated-record");
	assert.deepStrictEqual(
		parseThingsRows(raw).map((r) => r.id),
		["good"],
	);
});

const task = (
	id: string,
	due: string | null,
	list: string,
):
{
	id: string;
	title: string;
	due: string | null;
	list: string;
} => (
{
	id,
	title: `task ${id}`,
	due,
	list,
});

test("partitionThings unions Today and Anytime into the due set without duplicating a task", () =>
{
	const todayList = [task("a", "2026-08-01", "Today"), task("b", null, "Today")];
	const anytime = [task("a", "2026-08-01", "Anytime"), task("c", "2026-08-05", "Anytime")];

	const {due, today} = partitionThings(
		{
			todayList,
			anytime,
		},
		"2026-08-07",
	);

	assert.deepStrictEqual(
		due.map((t) => [t.id, t.list]),
		[
			["a", "Today"],
			["c", "Anytime"],
		],
	);
	assert.strictEqual(today, todayList);
});

test("partitionThings leaves tasks due after today out of the due set", () =>
{
	const {due} = partitionThings(
		{
			todayList: [],
			anytime: [task("later", "2026-09-01", "Anytime")],
		},
		"2026-08-07",
	);
	assert.deepStrictEqual(due, []);
});

/**
 * Things "Anytime" is where undated personal work piles up invisibly -- nothing ever surfaces it,
 * because nothing is due. The review sweeps it into the personal asap ladder instead, so these
 * rows are reported separately from `due` and carry no date.
 */
test("partitionThings reports undated Anytime tasks separately for the asap sweep", () =>
{
	const todayList = [task("in-today", null, "Today")];
	const anytime = [
		task("in-today", null, "Anytime"),
		task("undated", null, "Anytime"),
		task("dated", "2026-09-01", "Anytime"),
	];

	const {anytime: sweep} = partitionThings(
		{
			todayList,
			anytime,
		},
		"2026-08-07",
	);

	assert.deepStrictEqual(
		sweep.map((t) => t.id),
		["undated"],
	);
});

test("the osascript budget leaves room for a large Anytime backlog", () =>
{
	assert.strictEqual(OSASCRIPT_TIMEOUT_MS, 180_000);
});

test("the AppleScript resolves each to-do by id, never by list index", () =>
{
	// `repeat with t in (to dos of list "Today")` binds each `t` to a LAZY reference of the form
	// `item N of every to do of list "Today"`, resolved only when a property is read. The Things
	// Today list is dynamic -- a repeating to-do can roll off mid-loop -- so the list shrinks
	// under the iteration and the next dereference dies with:
	//   Things3 got an error: Can't get item 17 of every to do of list "Today". Invalid index. (-1719)
	// That aborted the whole file-tasks phase on 2026-09-04. Snapshotting the ids first and
	// looking each one up with `to do id` makes every read a stable lookup instead of an index.
	const src = script("Today");
	assert.doesNotMatch(
		src,
		/repeat\s+with\s+\w+\s+in\s+\(to dos of list/u,
		"must not iterate list references directly -- indices go stale mid-loop",
	);
	assert.match(src, /id of every to do of list "Today"/u, "must snapshot the ids up front");
	assert.match(src, /to do id /u, "must resolve each to-do by its stable id");
});

test("the AppleScript tolerates a to-do that disappears between the snapshot and the lookup", () =>
{
	// Completing or deleting a to-do in the window between the id snapshot and its lookup is a
	// real race, not a bug to crash on -- but it must not vanish silently either.
	const src = script("Anytime");
	assert.match(src, /\btry\b/u, "must guard the per-id lookup");
	assert.match(src, /\bon error\b/u, "must handle the vanished-to-do case explicitly");
});

test("a failed per-id lookup is retried and then reported, never silently dropped", () =>
{
	// The first version of the id-snapshot fix wrapped each `to do id` lookup in a bare
	// `try ... on error ... end try` that did nothing. That treats EVERY failure as "the to-do is
	// gone", including transient Apple Event failures under load -- so items disappear from the
	// result non-deterministically. Two runs minutes apart returned today=17/anytime=0 and then
	// today=8/anytime=2 off an unchanged database, and the Anytime sweep consequently swept
	// nothing while the real Anytime list held 18 to-dos.
	// A lookup that fails must be retried once, and a lookup that still fails must be COUNTED and
	// surfaced, so a dropped item is visible instead of silently changing the answer.
	const src = script("Anytime");
	assert.match(src, /repeat with attempt from 1 to 2/u, "must retry a failed lookup once");
	assert.match(src, /set skipped to skipped \+ 1/u, "must count a lookup that failed both attempts");
	assert.match(src, /"SKIPPED"/u, "must emit the skip count so the caller can see dropped items");
});

test("the parsed row count is reconciled against the id snapshot", () =>
{
	// Reporting the skip count only helps if something reads it. parseThingsRows must be able to
	// see the trailing count line without mistaking it for a to-do.
	const raw = out(row("A1", "Real task", "", "Anytime", "", ""));
	const rows = parseThingsRows(`${raw}SKIPPED\x1F2${RECORD_SEP}`);
	assert.deepStrictEqual(
		rows.map((r) => r.id),
		["A1"],
		"the skip-count marker must not be parsed as a to-do",
	);
});

test("the AppleScript emits each to-do's activation date", () =>
{
	// A repeating Today task with no deadline (take out the garbage) is only meaningful on the day
	// Things activated it. Without the activation date the review can only guess "today", and a
	// task left over from Tuesday shows up as Wednesday's chore.
	assert.match(script("Today"), /activation date of t/u);
});
