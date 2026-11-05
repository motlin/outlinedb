// Run: node --test plugins/gtd/scripts/compute-overdue.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
	addInterval,
	buildTimeElement,
	computeOverdue,
	foldSkipLog,
	intervalDays,
	intervalForSection,
	loadAnsweredKeys,
	loadSkipStreaks,
	nextLongerSection,
	nodeContext,
	parseTimeISO,
	recordOutcome,
	swapTimeElement,
} from "./compute-overdue.mts";
import type {OverdueRow, TreeNode, TreeRoot} from "./compute-overdue.mts";
import {at} from "./test-helpers.mts";

function rowFor(rows: OverdueRow[], id: string): OverdueRow {
	const row = rows.find((r) => r.id === id);
	assert.ok(row, `expected a row for ${id}`);
	return row;
}

/** The first item of the first section, which the marker tests rewrite. */
function firstItem(tree: TreeRoot): TreeNode {
	const item = tree.children?.[0]?.children?.[0];
	assert.ok(item, "expected a first item in the first section");
	return item;
}

test("parseTimeISO pulls the date out of a node name", () => {
	const name = 'Record status <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ';
	assert.strictEqual(parseTimeISO(name), "2026-06-24");
});

test("parseTimeISO returns null when there is no time element", () => {
	assert.strictEqual(parseTimeISO("A task with no date"), null);
});

test("intervalForSection matches by substring, ignoring emoji prefixes", () => {
	assert.deepStrictEqual(intervalForSection("🔄 Daily Review"), {amount: 1, unit: "d"});
	assert.deepStrictEqual(intervalForSection("⬆️ Frequently Important"), {amount: 1, unit: "d"});
	assert.deepStrictEqual(intervalForSection("☀️ Low priority daily tasks"), {amount: 1, unit: "d"});
	assert.deepStrictEqual(intervalForSection("🗓️ Weekly Review"), {amount: 7, unit: "d"});
	assert.deepStrictEqual(intervalForSection("🔄 Every 4 weeks"), {amount: 28, unit: "d"});
	assert.deepStrictEqual(intervalForSection("Monthly Review"), {amount: 1, unit: "m"});
	assert.deepStrictEqual(intervalForSection("Every 2 months"), {amount: 2, unit: "m"});
	assert.deepStrictEqual(intervalForSection("Every 6 months"), {amount: 6, unit: "m"});
	assert.deepStrictEqual(intervalForSection("Annual Review"), {amount: 1, unit: "y"});
});

test("intervalForSection returns null when the section needs a user-chosen interval", () => {
	assert.strictEqual(intervalForSection("Every few years"), null);
	assert.strictEqual(intervalForSection("🤷 Unrecognized section"), null);
});

test("addInterval advances days, weeks, months, and years", () => {
	assert.strictEqual(addInterval("2026-06-24", {amount: 1, unit: "d"}), "2026-06-25");
	assert.strictEqual(addInterval("2026-06-24", {amount: 7, unit: "d"}), "2026-07-01");
	assert.strictEqual(addInterval("2026-06-24", {amount: 1, unit: "m"}), "2026-07-24");
	assert.strictEqual(addInterval("2026-06-24", {amount: 1, unit: "y"}), "2027-06-24");
});

test("addInterval clamps a month rollover to the last day rather than skipping a month", () => {
	// Jan 31 + 1 month must not roll into March.
	assert.strictEqual(addInterval("2026-01-31", {amount: 1, unit: "m"}), "2026-02-28");
});

test("buildTimeElement computes the weekday and keeps the trailing space", () => {
	const el = buildTimeElement("2026-06-24");
	assert.match(el, /startYear="2026"/u);
	assert.match(el, /startMonth="6"/u);
	assert.match(el, /startDay="24"/u);
	assert.match(el, />Wed, Jun 24, 2026<\/time> $/u);
});

test("swapTimeElement replaces an existing time element in place", () => {
	const name = 'Reminders <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ';
	const next = buildTimeElement("2026-06-25");
	const swapped = swapTimeElement(name, next);
	assert.match(swapped, /^Reminders /u);
	assert.match(swapped, /startDay="25"/u);
	assert.doesNotMatch(swapped, /startDay="24"/u);
});

const FIXTURE = {
	children: [
		{
			name: "🔄 Daily Review",
			priority: 3,
			children: [
				{
					name: 'Reminders <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ',
					id: "id-reminders",
					shortId: "sid-reminders",
					children: [],
				},
				{
					name: 'Future task <time startYear="2026" startMonth="6" startDay="30">Tue, Jun 30, 2026</time> ',
					id: "id-future",
					shortId: "sid-future",
					children: [],
				},
				{
					name: "A task with no date and so never overdue",
					id: "id-nodate",
					shortId: "sid-nodate",
					children: [],
				},
			],
		},
		{
			name: "🗓️ Weekly Review",
			priority: 5,
			children: [
				{
					name: 'Factorio data converter #llm-task <time startYear="2026" startMonth="6" startDay="20">Sat, Jun 20, 2026</time> ',
					id: "id-factorio",
					shortId: "sid-factorio",
					children: [{name: "a sub-step"}],
				},
			],
		},
		{
			name: "🗃️ Routine Archive",
			priority: 9,
			children: [
				{
					name: 'Archived thing <time startYear="2020" startMonth="1" startDay="1">Wed, Jan 1, 2020</time> ',
					id: "id-archive",
					shortId: "sid-archive",
					children: [],
				},
			],
		},
	],
};

test("computeOverdue finds only on-or-before-today dated items, skipping the archive", () => {
	const rows = computeOverdue(FIXTURE, "2026-06-26");
	const ids = rows.map((r) => r.id);
	assert.deepStrictEqual(ids, ["id-reminders", "id-factorio"]);
});

test("computeOverdue skips the Phase 0 LLM Tasks: container and its subtree", () => {
	const tree = {
		children: [
			{
				name: "🔄 Daily Review",
				priority: 3,
				children: [
					{
						name: 'Real recurring task <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ',
						id: "id-real",
						shortId: "sid-real",
						children: [],
					},
					{
						name: "LLM Tasks:",
						id: "id-llm-container",
						shortId: "sid-llm",
						children: [
							{
								name: '📥 Import latest workflowy data #llm-task <time startYear="2026" startMonth="6" startDay="20">Sat, Jun 20, 2026</time> ',
								id: "id-import",
								shortId: "sid-import",
								children: [],
							},
						],
					},
				],
			},
		],
	};
	const ids = computeOverdue(tree, "2026-06-26").map((r) => r.id);
	assert.deepStrictEqual(ids, ["id-real"]);
});

test("computeOverdue orders by section priority then due date", () => {
	const rows = computeOverdue(FIXTURE, "2026-06-26");
	assert.strictEqual(at(rows, 0).section, "🔄 Daily Review");
	assert.strictEqual(at(rows, 1).section, "🗓️ Weekly Review");
});

test("computeOverdue annotates overdue days, llm-task, and child count", () => {
	const rows = computeOverdue(FIXTURE, "2026-06-26");
	const reminders = rowFor(rows, "id-reminders");
	assert.strictEqual(reminders.due, "2026-06-24");
	assert.strictEqual(reminders.overdueByDays, 2);
	assert.strictEqual(reminders.isLlmTask, false);
	assert.strictEqual(reminders.childCount, 0);

	const factorio = rowFor(rows, "id-factorio");
	assert.strictEqual(factorio.isLlmTask, true);
	assert.strictEqual(factorio.childCount, 1);
});

test("computeOverdue stages the next date and a verbatim node update applyOp", () => {
	const rows = computeOverdue(FIXTURE, "2026-06-26");
	const reminders = rowFor(rows, "id-reminders");
	// Daily Review = +1 day from today (the review date advances to today + interval).
	assert.strictEqual(reminders.nextDate, "2026-06-27");
	assert.ok(reminders.newName !== null && reminders.applyOp !== null);
	assert.match(reminders.newName, /^Reminders /u);
	assert.match(reminders.newName, /startDay="27"/u);
	assert.match(reminders.applyOp, /^\.\/bin\/run\.js node update --id id-reminders --name /u);
	// The new <time> element must be embedded in the applyOp verbatim.
	assert.ok(reminders.applyOp.includes(reminders.newName));
});

test("computeOverdue flags sections that need a user-chosen interval", () => {
	const tree = {
		children: [
			{
				name: "Every few years",
				priority: 1,
				children: [
					{
						name: 'Replace smoke detectors <time startYear="2026" startMonth="1" startDay="1">Thu, Jan 1, 2026</time> ',
						id: "id-smoke",
						shortId: "sid-smoke",
						children: [],
					},
				],
			},
		],
	};
	const rows = computeOverdue(tree, "2026-06-26");
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(at(rows, 0).needsInterval, true);
	assert.strictEqual(at(rows, 0).nextDate, null);
	assert.strictEqual(at(rows, 0).applyOp, null);
});

test("intervalDays orders every cadence from daily to annual", () => {
	assert.strictEqual(intervalDays({amount: 1, unit: "d"}), 1);
	assert.strictEqual(intervalDays({amount: 7, unit: "d"}), 7);
	assert.ok(intervalDays({amount: 1, unit: "m"}) > intervalDays({amount: 7, unit: "d"}));
	assert.ok(intervalDays({amount: 1, unit: "y"}) > intervalDays({amount: 6, unit: "m"}));
	assert.strictEqual(intervalDays(null), Infinity);
});

const LADDER_SECTIONS = [
	{name: "⬆️ Frequently Important", id: "sec-freq"},
	{name: "🗓️ Weekly Review", id: "sec-weekly"},
	{name: "📅 Monthly Review", id: "sec-monthly"},
	{name: "🗓️ Every 6 months", id: "sec-6mo"},
	{name: "🎆 Annual Review", id: "sec-annual"},
	{name: "🗃️ Routine Archive", id: "sec-archive"},
	{name: "Every few years", id: "sec-fewyears"},
];

test("nextLongerSection climbs one rung of the cadence ladder", () => {
	assert.strictEqual(nextLongerSection(LADDER_SECTIONS, {amount: 1, unit: "d"})?.id, "sec-weekly");
	assert.strictEqual(nextLongerSection(LADDER_SECTIONS, {amount: 7, unit: "d"})?.id, "sec-monthly");
	assert.strictEqual(nextLongerSection(LADDER_SECTIONS, {amount: 1, unit: "m"})?.id, "sec-6mo");
	assert.strictEqual(nextLongerSection(LADDER_SECTIONS, {amount: 6, unit: "m"})?.id, "sec-annual");
});

test("nextLongerSection returns null at the top of the ladder and for unknown cadences", () => {
	assert.strictEqual(nextLongerSection(LADDER_SECTIONS, {amount: 1, unit: "y"}), null);
	assert.strictEqual(nextLongerSection(LADDER_SECTIONS, null), null);
});

test("nextLongerSection never targets the archive", () => {
	const sections = [
		{name: "🔄 Daily Review", id: "sec-daily"},
		{name: "🗃️ Routine Archive", id: "sec-archive"},
	];
	assert.strictEqual(nextLongerSection(sections, {amount: 1, unit: "d"}), null);
});

test("foldSkipLog counts consecutive trailing skips per item", () => {
	const streaks = foldSkipLog([
		{key: "id-a", outcome: "done", date: "2026-08-10"},
		{key: "id-a", outcome: "skip", date: "2026-08-11"},
		{key: "id-a", outcome: "skip", date: "2026-08-12"},
		{key: "id-b", outcome: "skip", date: "2026-08-12"},
	]);
	assert.deepStrictEqual(
		streaks,
		new Map([
			["id-a", {skipStreak: 2, skippedSince: "2026-08-11"}],
			["id-b", {skipStreak: 1, skippedSince: "2026-08-12"}],
		]),
	);
});

test("foldSkipLog resets the streak when the item is finally handled", () => {
	const streaks = foldSkipLog([
		{key: "id-a", outcome: "skip", date: "2026-08-10"},
		{key: "id-a", outcome: "skip", date: "2026-08-11"},
		{key: "id-a", outcome: "done", date: "2026-08-12"},
	]);
	assert.deepStrictEqual(streaks, new Map([["id-a", {skipStreak: 0, skippedSince: null}]]));
});

test("foldSkipLog collapses repeats from the same day so a re-run cannot inflate a streak", () => {
	const streaks = foldSkipLog([
		{key: "id-a", outcome: "skip", date: "2026-08-12"},
		{key: "id-a", outcome: "skip", date: "2026-08-12"},
		{key: "id-a", outcome: "skip", date: "2026-08-12"},
	]);
	assert.deepStrictEqual(streaks, new Map([["id-a", {skipStreak: 1, skippedSince: "2026-08-12"}]]));
});

test("foldSkipLog lets a same-day correction overwrite an earlier outcome", () => {
	const streaks = foldSkipLog([
		{key: "id-a", outcome: "skip", date: "2026-08-11"},
		{key: "id-a", outcome: "skip", date: "2026-08-12"},
		{key: "id-a", outcome: "done", date: "2026-08-12"},
	]);
	assert.deepStrictEqual(streaks, new Map([["id-a", {skipStreak: 0, skippedSince: null}]]));
});

test("recordOutcome appends to the log and loadSkipStreaks reads it back", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtd-skip-"));
	const logPath = join(dir, "skip-log.jsonl");
	recordOutcome("id-a", "skip", {date: "2026-08-11", path: logPath});
	recordOutcome("id-a", "skip", {date: "2026-08-12", path: logPath});
	recordOutcome("id-b", "done", {date: "2026-08-12", path: logPath});

	const streaks = loadSkipStreaks(logPath);
	assert.deepStrictEqual(
		streaks,
		new Map([
			["id-a", {skipStreak: 2, skippedSince: "2026-08-11"}],
			["id-b", {skipStreak: 0, skippedSince: null}],
		]),
	);
	rmSync(dir, {recursive: true, force: true});
});

test("loadAnsweredKeys returns items with any outcome at or after the run start", () => {
	const dir = mkdtempSync(join(tmpdir(), "gtd-skip-"));
	const logPath = join(dir, "skip-log.jsonl");
	recordOutcome("before", "skip", {date: "2026-10-14", at: "2026-10-14T09:00:00.000Z", path: logPath});
	recordOutcome("at-start", "done", {date: "2026-10-14", at: "2026-10-14T10:00:00.000Z", path: logPath});
	recordOutcome("after", "skip", {date: "2026-10-15", at: "2026-10-15T00:05:00.000Z", path: logPath});

	assert.deepStrictEqual(loadAnsweredKeys("2026-10-14T10:00:00.000Z", logPath), new Set(["at-start", "after"]));
	assert.deepStrictEqual(loadAnsweredKeys("2026-10-14T10:00:00.000Z", join(dir, "missing.jsonl")), new Set());
	rmSync(dir, {recursive: true, force: true});
});

test("computeOverdue drops rows already answered this run", () => {
	const all = computeOverdue(FIXTURE, "2026-06-26");
	const [first] = all;
	assert.ok(first?.id);
	const rows = computeOverdue(FIXTURE, "2026-06-26", {answeredKeys: new Set([first.id])});
	assert.deepStrictEqual(
		rows.map((r) => r.id),
		all.filter((r) => r.id !== first.id).map((r) => r.id),
	);
});

test("loadSkipStreaks treats a missing log as no history", () => {
	const streaks = loadSkipStreaks(join(tmpdir(), "gtd-skip-does-not-exist", "skip-log.jsonl"));
	assert.deepStrictEqual(streaks, new Map());
});

test("computeOverdue reports a zero skip streak when there is no history", () => {
	const rows = computeOverdue(FIXTURE, "2026-06-26");
	assert.strictEqual(at(rows, 0).skipStreak, 0);
	assert.strictEqual(at(rows, 0).skippedSince, null);
});

test("computeOverdue carries each item skip streak onto its row", () => {
	const streaks = foldSkipLog([
		{key: "id-reminders", outcome: "skip", date: "2026-06-24"},
		{key: "id-reminders", outcome: "skip", date: "2026-06-25"},
	]);
	const rows = computeOverdue(FIXTURE, "2026-06-26", {skipStreaks: streaks});
	const reminders = rowFor(rows, "id-reminders");
	assert.strictEqual(reminders.skipStreak, 2);
	assert.strictEqual(reminders.skippedSince, "2026-06-24");
});

const LADDER_TREE = {
	children: [
		{
			name: "🔄 Daily Review",
			id: "sec-daily",
			priority: 3,
			children: [
				{
					name: 'Change batteries in the front door lock <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ',
					id: "id-batteries",
					shortId: "sid-batteries",
					children: [],
				},
			],
		},
		{name: "🗓️ Weekly Review", id: "sec-weekly", priority: 5, children: []},
		{name: "🎆 Annual Review", id: "sec-annual", priority: 8, children: []},
	],
};

test("computeOverdue stages a lengthen op that moves the item up one cadence rung", () => {
	const rows = computeOverdue(LADDER_TREE, "2026-06-26");
	const {lengthen} = at(rows, 0);
	assert.ok(lengthen);
	assert.strictEqual(lengthen.section, "🗓️ Weekly Review");
	assert.strictEqual(lengthen.sectionId, "sec-weekly");
	assert.deepStrictEqual(lengthen.interval, {amount: 7, unit: "d"});
	assert.strictEqual(lengthen.nextDate, "2026-07-03");
	assert.match(lengthen.newName, /startDay="3"/u);
	assert.match(lengthen.newName, /startMonth="7"/u);
	assert.ok(lengthen.applyOp.includes(`node update --id id-batteries --name `));
	assert.ok(lengthen.applyOp.includes(lengthen.newName));
	assert.ok(lengthen.applyOp.includes("node move --node-id id-batteries --parent-id sec-weekly"));
});

test("computeOverdue leaves lengthen null at the top of the ladder", () => {
	const tree = {
		children: [
			{
				name: "🎆 Annual Review",
				id: "sec-annual",
				priority: 8,
				children: [
					{
						name: 'Review the will <time startYear="2026" startMonth="1" startDay="1">Thu, Jan 1, 2026</time> ',
						id: "id-will",
						shortId: "sid-will",
						children: [],
					},
				],
			},
		],
	};
	assert.strictEqual(at(computeOverdue(tree, "2026-06-26"), 0).lengthen, null);
});

test("computeOverdue leaves lengthen null when the section interval is unknown", () => {
	const tree = {
		children: [
			{
				name: "Every few years",
				id: "sec-fewyears",
				priority: 1,
				children: [
					{
						name: 'Replace smoke detectors <time startYear="2026" startMonth="1" startDay="1">Thu, Jan 1, 2026</time> ',
						id: "id-smoke",
						shortId: "sid-smoke",
						children: [],
					},
				],
			},
			{name: "🎆 Annual Review", id: "sec-annual", priority: 8, children: []},
		],
	};
	assert.strictEqual(at(computeOverdue(tree, "2026-06-26"), 0).lengthen, null);
});

test("computeOverdue leaves lengthen null when the target section has no id to move into", () => {
	const tree = {
		children: [
			{
				name: "🔄 Daily Review",
				id: "sec-daily",
				priority: 3,
				children: [
					{
						name: 'Water the plants <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ',
						id: "id-plants",
						shortId: "sid-plants",
						children: [],
					},
				],
			},
			{name: "🗓️ Weekly Review", priority: 5, children: []},
		],
	};
	assert.strictEqual(at(computeOverdue(tree, "2026-06-26"), 0).lengthen, null);
});

test("nodeContext gathers the context the walk shows before asking", () => {
	const node = {
		name: 'Inventory the drives <a href="https://example.com/spec">spec</a> <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ',
		id: "id-drives",
		shortId: "sid-drives",
		note: "see https://example.com/notes",
		modifiedAt: "2026-06-20T11:02:00Z",
		children: [
			{
				name: 'Drive A <time startYear="2026" startMonth="1" startDay="2">Fri, Jan 2, 2026</time> ',
				shortId: "sid-a",
				children: [{name: "nested"}],
			},
			{name: "Drive B", shortId: null, note: "spare", children: []},
		],
	};
	const context = nodeContext(node);
	assert.deepStrictEqual(context, {
		note: "see https://example.com/notes",
		modifiedAt: "2026-06-20T11:02:00Z",
		childCount: 2,
		children: [
			{title: "Drive A", note: null, childCount: 1, url: "https://workflowy.com/#/sid-a"},
			{title: "Drive B", note: "spare", childCount: 0, url: null},
		],
		// Links are what the walk opens, so the node's own href and any bare URL in the note both count.
		links: ["https://example.com/spec", "https://example.com/notes"],
	});
});

test("nodeContext drops completed children so finished work is never read aloud as open", () => {
	// A recurring item that mirrors a bucket: most candidates are already done.
	const node = {
		name: "Set goals for today",
		shortId: "sid-goals",
		children: [
			{
				name: "Transfer stock to Temple Sinai",
				shortId: "sid-1",
				completedAt: "2026-08-19T12:00:00Z",
				children: [],
			},
			{name: "Cancel Apple iCloud Subscriptions", shortId: "sid-2", completedAt: 1_755_600_000, children: []},
			{name: "Respond to blog comments", shortId: "sid-3", completedAt: null, children: []},
		],
	};
	const context = nodeContext(node);
	// childCount is the open count, not the raw child count.
	assert.deepStrictEqual(context, {
		note: null,
		modifiedAt: null,
		childCount: 1,
		children: [
			{title: "Respond to blog comments", note: null, childCount: 0, url: "https://workflowy.com/#/sid-3"},
		],
		links: [],
	});
});

test("nodeContext returns an empty context for a childless, noteless node", () => {
	assert.deepStrictEqual(nodeContext({name: "Bare", children: []}), {
		note: null,
		modifiedAt: null,
		childCount: 0,
		children: [],
		links: [],
	});
});

test("computeOverdue skips items that are already completed", () => {
	// A recurring item the user finished still carries its old <time>. Surfacing it asks
	// the user about work they already did, which is how 10 of 51 rows in one run were dead.
	const tree = {
		children: [
			{
				name: "🔄 Daily Review",
				priority: 3,
				children: [
					{
						name: 'Already done <time startYear="2026" startMonth="6" startDay="1">Mon, Jun 1, 2026</time>',
						id: "id-done",
						shortId: "sid-done",
						completedAt: 1_786_587_745,
						children: [],
					},
					{
						name: 'Still open <time startYear="2026" startMonth="6" startDay="1">Mon, Jun 1, 2026</time>',
						id: "id-open",
						shortId: "sid-open",
						completedAt: null,
						children: [],
					},
				],
			},
		],
	};
	const rows = computeOverdue(tree, "2026-08-26");
	assert.deepStrictEqual(
		rows.map((r) => r.id),
		["id-open"],
	);
});

test("computeOverdue carries the item context so the walk can show it before asking", () => {
	const tree = {
		children: [
			{
				name: "🔄 Daily Review",
				priority: 3,
				children: [
					{
						name: 'Inventory the drives <time startYear="2026" startMonth="6" startDay="24">Wed, Jun 24, 2026</time> ',
						id: "id-drives",
						shortId: "sid-drives",
						note: "started last week",
						modifiedAt: "2026-06-20T11:02:00Z",
						children: [{name: "Drive A", shortId: "sid-a", children: []}],
					},
				],
			},
		],
	};
	const row = at(computeOverdue(tree, "2026-06-26"), 0);
	assert.strictEqual(row.url, "https://workflowy.com/#/sid-drives");
	assert.strictEqual(row.note, "started last week");
	assert.strictEqual(row.modifiedAt, "2026-06-20T11:02:00Z");
	assert.strictEqual(row.childCount, 1);
	assert.deepStrictEqual(row.children, [
		{title: "Drive A", note: null, childCount: 0, url: "https://workflowy.com/#/sid-a"},
	]);
	assert.deepStrictEqual(row.links, []);
});

test("computeOverdue skips mirror nodes and everything under them", () => {
	// "Set goals for today" is a real recurring item that carries mirrors of the four task
	// buckets as children. Those mirrors reflect one-shot tasks that live in Next Actions --
	// they are not recurring review items, and walking into them reports real dated tasks as
	// overdue Daily Review rows.
	const tree = {
		name: "🔄 Review",
		children: [
			{
				name: "🔄 Daily Review",
				priority: 1,
				children: [
					{
						id: "real-1",
						shortId: "real1",
						name: 'Set goals for today <time startYear="2026" startMonth="9" startDay="1">Tue, Sep 1, 2026</time> ',
						children: [
							{
								id: "mirror-bucket",
								shortId: "mirr1",
								name: "⏰ Tasks (due dates) (work)",
								mirror: {isMirror: true, originalNodeId: "bucket-orig"},
								children: [
									{
										id: "one-shot",
										shortId: "shot1",
										name: 'Review the CVE remediation epic <time startYear="2026" startMonth="8" startDay="31">Mon, Aug 31, 2026</time> ',
										children: [],
									},
								],
							},
						],
					},
				],
			},
		],
	};

	const rows = computeOverdue(tree, "2026-09-02");
	const ids = rows.map((row) => row.id);

	assert.deepStrictEqual(ids, ["real-1"], "only the real recurring item is reported");
	assert.strictEqual(
		ids.includes("one-shot"),
		false,
		"a one-shot task reached through a bucket mirror must not be reported as recurring",
	);
	assert.strictEqual(ids.includes("mirror-bucket"), false, "the mirror node itself is never a row");
});

test("nodeContext leaves Workflowy permalinks out of the links the walk opens", () => {
	// @mention links and "see also" pointers are workflowy.com hrefs. The walk opens every link it
	// is handed, and opening a permalink boots the Workflowy SPA for seconds to show text the
	// question already carries -- so a permalink must never reach the list in the first place.
	const node = {
		name: 'Ask <a href="https://workflowy.com/#/abc123def456">@Alice</a> about the <a href="https://example.com/rfc">RFC</a>',
		shortId: "sid-ask",
		note: "context: https://workflowy.com/#/789abc012def and https://example.com/thread",
		children: [],
	};
	assert.deepStrictEqual(nodeContext(node).links, ["https://example.com/rfc", "https://example.com/thread"]);
});

const HARD_DEADLINE_TREE = {
	children: [
		{
			name: "Every 4 weeks",
			children: [
				{
					id: "test-deadline",
					shortId: "test-short",
					name: `Example renewal ${buildTimeElement("2000-01-01")}`,
					children: [{name: "Hard deadline: 3d"}],
				},
			],
		},
		{name: "Monthly Review", id: "test-monthly"},
	],
};

test("hard deadlines become due three days early and retain the external cycle after late completion", () => {
	assert.deepStrictEqual(computeOverdue(HARD_DEADLINE_TREE, "1999-12-28"), []);
	const row = at(computeOverdue(HARD_DEADLINE_TREE, "2000-01-02"), 0);
	assert.deepStrictEqual(row, {
		section: "Every 4 weeks",
		sectionIndex: 0,
		priority: null,
		id: "test-deadline",
		shortId: "test-short",
		name: 'Example renewal <time startYear="2000" startMonth="1" startDay="1">Sat, Jan 1, 2000</time> ',
		due: "1999-12-29",
		hardDeadline: {date: "2000-01-01", leadDays: 3, nextDate: "2000-01-29"},
		weekday: null,
		overdueByDays: 4,
		isLlmTask: false,
		missingLlmTag: false,
		url: "https://workflowy.com/#/test-short",
		note: null,
		modifiedAt: null,
		childCount: 1,
		children: [{title: "Hard deadline: 3d", note: null, childCount: 0, url: null}],
		links: [],
		interval: {amount: 28, unit: "d"},
		needsInterval: false,
		nextDate: "2000-01-26",
		nextTimeElement: '<time startYear="2000" startMonth="1" startDay="29">Sat, Jan 29, 2000</time> ',
		newName: 'Example renewal <time startYear="2000" startMonth="1" startDay="29">Sat, Jan 29, 2000</time> ',
		applyOp: `./bin/run.js node update --id test-deadline --name 'Example renewal <time startYear="2000" startMonth="1" startDay="29">Sat, Jan 29, 2000</time> '`,
		skipStreak: 0,
		skippedSince: null,
		lengthen: null,
	});
	assert.deepStrictEqual(computeOverdue(HARD_DEADLINE_TREE, "1999-12-29"), [{...row, overdueByDays: 0}]);
});

test("hard deadline completion advances exactly one 28-day occurrence even after missed cycles", () => {
	const row = at(computeOverdue(HARD_DEADLINE_TREE, "2000-03-01"), 0);
	assert.deepStrictEqual(row.hardDeadline, {date: "2000-01-01", leadDays: 3, nextDate: "2000-01-29"});
	const nextTree = structuredClone(HARD_DEADLINE_TREE);
	assert.ok(row.newName);
	firstItem(nextTree).name = row.newName;
	const next = at(computeOverdue(nextTree, "2000-03-01"), 0);
	assert.deepStrictEqual(next.hardDeadline, {date: "2000-01-29", leadDays: 3, nextDate: "2000-02-26"});
});

test("hard deadline markers reject malformed, duplicate, and undated configurations", () => {
	for (const marker of ["Hard deadline: -3d", "Hard deadline: 3m", "Hard deadline: tomorrow"]) {
		const tree = structuredClone(HARD_DEADLINE_TREE);
		firstItem(tree).children = [{name: marker}];
		assert.throws(
			() => computeOverdue(tree, "2000-01-01"),
			new Error("Expected Hard deadline: <nonnegative days>d on test-deadline"),
		);
	}
	const duplicate = structuredClone(HARD_DEADLINE_TREE);
	firstItem(duplicate).children?.push({name: "Hard deadline: 0d"});
	assert.throws(
		() => computeOverdue(duplicate, "2000-01-01"),
		new Error("Multiple hard deadline markers on test-deadline"),
	);
	const undated = structuredClone(HARD_DEADLINE_TREE);
	firstItem(undated).name = "Example renewal";
	assert.throws(
		() => computeOverdue(undated, "2000-01-01"),
		new Error("Hard deadline requires a dated item: test-deadline"),
	);
});

const WEEKDAY_TREE = {
	children: [
		{
			name: "Weekly Review",
			children: [
				{
					id: "test-weekday",
					shortId: "weekday-short",
					name: `Example chore ${buildTimeElement("2000-01-01")}`,
					children: [{name: "Next: Saturday"}],
				},
			],
		},
		{
			name: "Daily Review",
			children: [
				{
					id: "test-daily-weekday",
					name: `Daily chore ${buildTimeElement("2000-01-01")}`,
					children: [{name: "Next: Saturday"}],
				},
			],
		},
		{
			name: "Monthly Review",
			id: "test-monthly",
			children: [
				{
					id: "test-monthly-weekday",
					name: `Monthly chore ${buildTimeElement("2000-01-01")}`,
					children: [{name: "Next: sunday"}],
				},
			],
		},
	],
};

test("a Next: <weekday> marker lands the advanced date on the next matching weekday", () => {
	// 2000-01-05 is a Wednesday. Weekly: the next Saturday, not Wednesday + 7.
	// Daily: today + 1 is Thursday, so it rolls forward to Saturday.
	// Monthly: the last Sunday on or before Wed Feb 5 (Feb 5 + 0..6 back), i.e. Feb 6 is a Sunday -> Jan 30.
	const rows = computeOverdue(WEEKDAY_TREE, "2000-01-05");
	assert.deepStrictEqual(
		rows.map((row) => ({id: row.id, nextDate: row.nextDate, weekday: row.weekday, applyOp: row.applyOp})),
		[
			{
				id: "test-weekday",
				nextDate: "2000-01-08",
				weekday: "Saturday",
				applyOp: `./bin/run.js node update --id test-weekday --name 'Example chore <time startYear="2000" startMonth="1" startDay="8">Sat, Jan 8, 2000</time> '`,
			},
			{
				id: "test-daily-weekday",
				nextDate: "2000-01-08",
				weekday: "Saturday",
				applyOp: `./bin/run.js node update --id test-daily-weekday --name 'Daily chore <time startYear="2000" startMonth="1" startDay="8">Sat, Jan 8, 2000</time> '`,
			},
			{
				id: "test-monthly-weekday",
				nextDate: "2000-01-30",
				weekday: "Sunday",
				applyOp: `./bin/run.js node update --id test-monthly-weekday --name 'Monthly chore <time startYear="2000" startMonth="1" startDay="30">Sun, Jan 30, 2000</time> '`,
			},
		],
	);
});

test("a weekday-anchored item completed on its weekday advances a full week, not zero days", () => {
	// 2000-01-08 is a Saturday.
	const row = at(computeOverdue(WEEKDAY_TREE, "2000-01-08"), 0);
	assert.deepStrictEqual(
		{nextDate: row.nextDate, weekday: row.weekday},
		{nextDate: "2000-01-15", weekday: "Saturday"},
	);
});

test("an unanchored row reports weekday null", () => {
	const row = at(computeOverdue(HARD_DEADLINE_TREE, "2000-01-02"), 0);
	assert.strictEqual(row.weekday, null);
});

test("weekday markers reject malformed, duplicate, and hard-deadline combinations", () => {
	for (const marker of ["Next: Sat", "Next: someday", "Next: Saturday please"]) {
		const tree = structuredClone(WEEKDAY_TREE);
		firstItem(tree).children = [{name: marker}];
		assert.throws(() => computeOverdue(tree, "2000-01-05"), new Error("Expected Next: <weekday> on test-weekday"));
	}
	const duplicate = structuredClone(WEEKDAY_TREE);
	firstItem(duplicate).children?.push({name: "Next: Sunday"});
	assert.throws(
		() => computeOverdue(duplicate, "2000-01-05"),
		new Error("Multiple Next: <weekday> markers on test-weekday"),
	);
	const both = structuredClone(WEEKDAY_TREE);
	firstItem(both).children?.push({name: "Hard deadline: 3d"});
	assert.throws(
		() => computeOverdue(both, "2000-01-05"),
		new Error("Next: <weekday> cannot combine with Hard deadline on test-weekday"),
	);
});

test("lengthening a weekday-anchored item keeps the weekday", () => {
	const tree = structuredClone(WEEKDAY_TREE);
	at(tree.children, 0).id = "test-weekly";
	const row = at(computeOverdue(tree, "2000-01-05"), 0);
	// Next rung above Weekly is Monthly: last Saturday on or before Feb 5 is Feb 5 itself.
	assert.strictEqual(row.lengthen?.nextDate, "2000-02-05");
});

test("computeOverdue flags items whose children say Claude runs them but lack #llm-task", () => {
	const item = (id: string, name: string, children: string[]): TreeNode => ({
		name: `${name} ${buildTimeElement("2026-06-20")}`,
		id,
		shortId: id,
		children: children.map((child) => ({name: child})),
	});
	const tree = {
		children: [
			{
				name: "⬆️ Frequently Important",
				children: [
					item("alice", "Add photos", ["Claude does this whole item end to end."]),
					item("bob", "Export photos", [`Export: osascript -e 'tell application "Photos"'`]),
					item("carol", "Attach images", ["Attach with /workflowy:upload-attachment, one per child."]),
					item("dave", "Create entries", ["./bin/run.js node create --parent-id X --name ''"]),
					item("erin", "Tagged already #llm-task", ["Claude does this whole item end to end."]),
					item("frank", "Clean up Desktop", ["cd ~/Desktop &amp;&amp; claude", "Claude does it"]),
					item("grace", "Call the dentist", ["Ask for the earliest slot; just past noon works."]),
				],
			},
		],
	};
	assert.deepStrictEqual(
		computeOverdue(tree, "2026-06-26").map((r) => [r.id, r.missingLlmTag]),
		[
			["alice", true],
			["bob", true],
			["carol", true],
			["dave", true],
			["erin", false],
			["frank", false],
			["grace", false],
		],
	);
});
