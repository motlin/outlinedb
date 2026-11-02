// Run: node --test plugins/gtd/scripts/collect-due-items.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import
{
	applyReschedule,
	attachRecurringCounterparts,
	collectDueItems,
	fromReminders,
	fromThings,
	fromWorkflowy,
	groupCrossSourceDuplicates,
	resolveTimeframe,
	skipKey,
} from "./collect-due-items.mts";
import type {WorkflowyRootInput} from "./collect-due-items.mts";
import {foldSkipLog} from "./compute-overdue.mts";
import type {TreeNode} from "./compute-overdue.mts";
import {at} from "./test-helpers.mts";

interface WorkflowyRootSpec
{
	rootKey?: string;
	bucketName?: string;
	tasks?: TreeNode[];
	asapChildren?: TreeNode[];
}

const TODAY = "2026-08-07"; // a Friday

test("recurring lookup includes future nested matches and excludes mirrors, archives, and completed work", () =>
{
	const future =
	{
		id: "alice",
		shortId: "alice-short",
		name: '<b>Check filter</b> <time startYear="2000" startMonth="7" startDay="1">date</time>',
	};
	const tree =
	{
		children: [
			{
				name: "🔄 Every 6 months Review",
				children: [
					{
						name: "Maintenance",
						children: [future],
					},
					{
						...future,
						id: "bob",
						completedAt: 1,
					},
					{
						name: "Mirror",
						mirror:
						{
							isMirror: true,
						},
						children: [future],
					},
				],
			},
			{
				name: "🗃️ Routine Archive",
				children: [future],
			},
		],
	};
	const rows = [
		{
			source: "workflowy",
			id: "charlie",
			title: " CHECK   FILTER ",
			due: "1999-12-31",
		},
	];
	assert.deepStrictEqual(attachRecurringCounterparts(rows, tree), [
		{
			source: "workflowy",
			id: "charlie",
			title: " CHECK   FILTER ",
			due: "1999-12-31",
			recurringCounterparts: [
				{
					id: "alice",
					title: "Check filter",
					path: "Personal > 🔄 Review > 🔄 Every 6 months Review > Maintenance > Check filter",
					nextDate: "2000-07-01",
					url: "https://workflowy.com/#/alice-short",
				},
			],
		},
	]);
});

test("recurring lookup retains multiple undated candidates and excludes the due node itself", () =>
{
	const rows = [
		{
			source: "workflowy",
			id: "alice",
			title: "Check filter",
		},
		{
			source: "reminders",
			id: "bob",
			title: "Different task",
		},
	];
	const tree =
	{
		children: [
			{
				name: "Monthly",
				children: [
					{
						id: "alice",
						name: "Check filter",
					},
					{
						id: "bob",
						name: "Check filter",
					},
					{
						id: "charlie",
						name: "Check filter",
					},
				],
			},
		],
	};
	assert.deepStrictEqual(attachRecurringCounterparts(rows, tree), [
		{
			source: "workflowy",
			id: "alice",
			title: "Check filter",
			recurringCounterparts: [
				{
					id: "bob",
					title: "Check filter",
					path: "Personal > 🔄 Review > Monthly > Check filter",
					nextDate: null,
					url: "https://workflowy.com/#/bob",
				},
				{
					id: "charlie",
					title: "Check filter",
					path: "Personal > 🔄 Review > Monthly > Check filter",
					nextDate: null,
					url: "https://workflowy.com/#/charlie",
				},
			],
		},
		{
			source: "reminders",
			id: "bob",
			title: "Different task",
			recurringCounterparts: [],
		},
	]);
});

test("cross-source matches keep one Workflowy survivor and the exact external operations", () =>
{
	const survivor =
	{
		source: "workflowy",
		id: "alice",
		title: "<b>Check the filter</b>",
		ops:
		{
			complete: "complete alice",
		},
	};
	const things =
	{
		source: "things",
		id: "bob",
		title: "  CHECK   the filter ",
		ops:
		{
			drop: "cancel bob",
		},
	};
	const reminder =
	{
		source: "reminders",
		id: "charlie",
		title: "Check the filter",
		ops:
		{
			drop: "delete charlie",
		},
	};
	assert.deepStrictEqual(groupCrossSourceDuplicates([things, survivor, reminder]), [
		{
			...survivor,
			duplicateCopies: [things, reminder],
		},
	]);
});

test("ambiguous Workflowy matches and external-only matches remain separate", () =>
{
	const rows = [
		{
			source: "workflowy",
			id: "alice",
			title: "Check filter",
		},
		{
			source: "workflowy",
			id: "bob",
			title: "Check filter",
		},
		{
			source: "things",
			id: "charlie",
			title: "Check filter",
		},
		{
			source: "things",
			id: "dave",
			title: "Check valve",
		},
		{
			source: "reminders",
			id: "eve",
			title: "Check valve",
		},
	];
	assert.deepStrictEqual(groupCrossSourceDuplicates(rows), rows);
});

function workflowyRoot({
	rootKey = "personal",
	bucketName = "⏰ Tasks (due dates) (personal)",
	tasks = [],
	asapChildren = [
		{
			name: "Not a due task",
			id: "x",
		},
	],
}: WorkflowyRootSpec = {}): WorkflowyRootInput
{
	return {
		rootKey,
		root:
		{
			name: "☑️ Next (Personal)",
			id: "root-uuid",
			children: [
				{
					name: "📋 Meeting agendas",
					id: "agendas-uuid",
					children: [],
				},
				{
					name: "✅ Tasks",
					id: "wrapper-uuid",
					children: [
						{
							name: bucketName,
							id: "bucket-uuid",
							children: tasks,
						},
						{
							name: "📌 Tasks (asap) (personal)",
							id: "asap-uuid",
							children: asapChildren,
						},
					],
				},
			],
		},
	};
}

const dated = (name: string, iso: string, id: string): TreeNode => (
{
	name: `${name} <time startYear="${iso.slice(0, 4)}" startMonth="${Number(iso.slice(5, 7))}" startDay="${Number(iso.slice(8, 10))}">label</time> `,
	id,
	shortId: id.slice(-12),
	children: [],
});

test("collector groups due copies without losing survivor state and resets its duplicate outcome streak", () =>
{
	const today = "2000-01-01";
	const workflowy = [
		workflowyRoot(
			{
				tasks: [dated("Check filter", today, "alice")],
			},
		),
	];
	const things =
	{
		due: [
			{
				id: "bob",
				title: "CHECK FILTER",
				due: today,
			},
		],
	};
	const survivor = collectDueItems(
		{
			workflowy,
		},
		today,
	)[0];
	const copy = collectDueItems(
		{
			things,
		},
		today,
	)[0];
	const skipStreaks = foldSkipLog([
		{
			key: "workflowy:alice",
			outcome: "skip",
			date: "1999-12-31",
		},
		{
			key: "workflowy:alice",
			outcome: "dropDuplicate",
			date: today,
		},
	]);
	assert.deepStrictEqual(
		collectDueItems(
			{
				workflowy,
				things,
			},
			today,
			{
				skipStreaks,
			},
		),
		[
			{
				...survivor,
				duplicateCopies: [copy],
			},
		],
	);
});

test("collector attaches future recurring context to both sides of a cross-source group", () =>
{
	const today = "2000-01-01";
	const workflowy = [
		workflowyRoot(
			{
				tasks: [dated("Check filter", today, "alice")],
			},
		),
	];
	const things =
	{
		due: [
			{
				id: "bob",
				title: "CHECK FILTER",
				due: today,
			},
		],
	};
	const recurring =
	{
		children: [
			{
				name: "Every 6 months Review",
				children: [dated("Check filter", "2000-07-01", "charlie")],
			},
		],
	};
	const recurringCounterparts = [
		{
			id: "charlie",
			title: "Check filter",
			path: "Personal > 🔄 Review > Every 6 months Review > Check filter",
			nextDate: "2000-07-01",
			url: "https://workflowy.com/#/charlie",
		},
	];
	const survivor = collectDueItems(
		{
			workflowy,
		},
		today,
	)[0];
	const copy = collectDueItems(
		{
			things,
		},
		today,
	)[0];
	assert.deepStrictEqual(
		collectDueItems(
			{
				workflowy,
				things,
				recurring,
			},
			today,
		),
		[
			{
				...survivor,
				recurringCounterparts,
				duplicateCopies: [
					{
						...copy,
						recurringCounterparts,
					},
				],
			},
		],
	);
});

test("fromWorkflowy pulls dated tasks out of the ⏰ bucket only", () =>
{
	const items = fromWorkflowy(
		[
			workflowyRoot(
				{
					tasks: [
						dated("Call the allergist", "2026-07-04", "aaaaaaaaaaaa1111"),
						dated("Future thing", "2026-09-01", "bbbbbbbbbbbb2222"),
					],
				},
			),
		],
		TODAY,
	);

	assert.deepStrictEqual(
		items.map((i) => [i.source, i.title, i.due, i.overdueByDays]),
		[
			["workflowy", "Call the allergist", "2026-07-04", 34],
			["workflowy", "Future thing", "2026-09-01", -25],
		],
	);
});

test("fromWorkflowy never returns items from the 📌 asap bucket", () =>
{
	const items = fromWorkflowy(
		[
			workflowyRoot(
				{
					tasks: [],
				},
			),
		],
		TODAY,
	);
	assert.deepStrictEqual(items, []);
});

test("fromWorkflowy flags undated tasks sitting in the ⏰ bucket as needing a date", () =>
{
	const items = fromWorkflowy(
		[
			workflowyRoot(
				{
					tasks: [
						{
							name: "Forgot to date this one",
							id: "cccccccccccc3333",
							shortId: "cccc33334444",
							children: [],
						},
					],
				},
			),
		],
		TODAY,
	);

	assert.strictEqual(items.length, 1);
	assert.strictEqual(at(items, 0).due, null);
	assert.strictEqual(at(items, 0).needsDate, true);
});

test("fromWorkflowy skips completed tasks", () =>
{
	const task = dated("Already done", "2026-06-01", "dddddddddddd4444");
	task.completedAt = "2026-06-02T00:00:00.000Z";
	assert.deepStrictEqual(
		fromWorkflowy(
			[
				workflowyRoot(
					{
						tasks: [task],
					},
				),
			],
			TODAY,
		),
		[],
	);
});

test("fromWorkflowy stages complete and reschedule ops carrying the full uuid", () =>
{
	const item = at(
		fromWorkflowy(
			[
				workflowyRoot(
					{
						tasks: [dated("Pay dues", "2026-07-31", "eeeeeeeeeeee5555")],
					},
				),
			],
			TODAY,
		),
		0,
	);

	assert.strictEqual(item.ops.complete, "./bin/run.js node complete --id eeeeeeeeeeee5555");
	assert.match(item.ops.reschedule, /^\.\/bin\/run\.js node update --id eeeeeeeeeeee5555 --name /u);
	assert.match(item.ops.reschedule, /\{\{date\}\}/u);
});

test("fromThings maps due-dated and Today-list tasks, deduping by id", () =>
{
	const items = fromThings(
		{
			due: [
				{
					id: "JMwVZ",
					title: "Pay temple dues",
					due: "2026-08-01",
					list: "Anytime",
				},
			],
			today: [
				{
					id: "JMwVZ",
					title: "Pay temple dues",
					due: "2026-08-01",
					list: "Today",
				},
				{
					id: "9XHRt",
					title: "FreshDirect order",
					due: null,
					list: "Today",
				},
			],
		},
		TODAY,
	);

	assert.deepStrictEqual(
		items.map((i) => [i.source, i.id, i.title, i.due]),
		[
			["things", "JMwVZ", "Pay temple dues", "2026-08-01"],
			// An undated Today-list task is not undated work: Things scheduling it for today IS the
			// due signal, so it dates to today rather than sinking to the bottom of the walk.
			["things", "9XHRt", "FreshDirect order", TODAY],
		],
	);
});

test("fromThings distinguishes a real deadline from a Today-list scheduling", () =>
{
	const items = fromThings(
		{
			due: [
				{
					id: "a",
					title: "Has a deadline",
					due: "2026-08-01",
					list: "Anytime",
				},
			],
			today: [
				{
					id: "b",
					title: "Merely scheduled",
					due: null,
					list: "Today",
				},
			],
		},
		TODAY,
	);

	assert.deepStrictEqual(
		items.map((i) => [i.id, i.dueSource, i.needsDate]),
		[
			["a", "deadline", false],
			["b", "scheduled", false],
		],
	);
});

test("fromThings dates a deadline-less Today task by its activation date when earlier than today", () =>
{
	// A repeating chore Things activated on Tuesday and nobody ticked off is Tuesday's chore, not
	// today's. Dating it to today put "take out the garbage" on the wrong night in the walk.
	const items = fromThings(
		{
			due: [],
			today: [
				{
					id: "past",
					title: "Take out the garbage",
					due: null,
					list: "Today",
					activationDate: "2026-08-04",
				},
				{
					id: "now",
					title: "Water the plants",
					due: null,
					list: "Today",
					activationDate: TODAY,
				},
				{
					id: "none",
					title: "Call the plumber",
					due: null,
					list: "Today",
					activationDate: null,
				},
				{
					id: "dl",
					title: "Pay the bill",
					due: "2026-08-06",
					list: "Today",
					activationDate: "2026-08-01",
				},
			],
		},
		TODAY,
	);

	assert.deepStrictEqual(
		items.map((i) => [i.id, i.due, i.dueSource, i.overdueByDays]),
		[
			["past", "2026-08-04", "scheduled", 3],
			["now", TODAY, "scheduled", 0],
			["none", TODAY, "scheduled", 0],
			["dl", "2026-08-06", "deadline", 1],
		],
	);
});

test("fromThings leaves an undated task outside the Today list undated", () =>
{
	assert.deepStrictEqual(
		fromThings(
			{
				due: [],
				today: [],
				anytime: [
					{
						id: "c",
						title: "Someday",
						due: null,
						list: "Anytime",
					},
				],
			},
			TODAY,
		),
		[],
	);
});

test("fromThings stages an AppleScript completion keyed on the stable id", () =>
{
	const item = at(
		fromThings(
			{
				due: [
					{
						id: "JMwVZ",
						title: "Alice's task",
						due: "2026-08-01",
					},
				],
				today: [],
			},
			TODAY,
		),
		0,
	);

	assert.match(item.ops.complete, /Things3/u);
	assert.match(item.ops.complete, /JMwVZ/u);
	assert.match(item.ops.complete, /completed/u);
});

test("fromReminders flattens overdue and dueToday, ignoring dueTomorrow", () =>
{
	const items = fromReminders(
		{
			overdue: [
				{
					title: "Pay credit card",
					dueDate: "2026-08-01T09:00:00",
					list: "Personal",
				},
			],
			dueToday: [
				{
					title: "Call doctor",
					dueDate: "2026-08-07T14:00:00",
					list: "Personal",
				},
			],
			dueTomorrow: [
				{
					title: "Submit report",
					dueDate: "2026-08-08T17:00:00",
					list: "Work",
				},
			],
		},
		TODAY,
	);

	assert.deepStrictEqual(
		items.map((i) => [i.source, i.title, i.due]),
		[
			["reminders", "Pay credit card", "2026-08-01"],
			["reminders", "Call doctor", "2026-08-07"],
		],
	);
});

test("fromReminders keys its completion op on the title, since iMCP exposes no id", () =>
{
	const item = at(
		fromReminders(
			{
				overdue: [
					{
						title: "O'Brien follow-up",
						dueDate: "2026-08-01T09:00:00",
						list: "Personal",
					},
				],
			},
			TODAY,
		),
		0,
	);

	assert.strictEqual(item.id, "O'Brien follow-up");
	assert.match(item.ops.complete, /Reminders/u);
	assert.match(item.ops.complete, /O'"'"'Brien follow-up/u);
});

test("collectDueItems merges all three sources sorted by due date, undated last", () =>
{
	const rows = collectDueItems(
		{
			workflowy: [
				workflowyRoot(
					{
						tasks: [
							dated("Workflowy overdue", "2026-06-15", "ffffffffffff6666"),
							{
								name: "Workflowy undated",
								id: "gggggggggggg7777",
								children: [],
							},
						],
					},
				),
			],
			things:
			{
				due: [
					{
						id: "TH1",
						title: "Things overdue",
						due: "2026-07-01",
					},
				],
				today: [],
			},
			reminders:
			{
				overdue: [
					{
						title: "Reminder overdue",
						dueDate: "2026-05-01T09:00:00",
					},
				],
				dueToday: [],
			},
		},
		TODAY,
	);

	assert.deepStrictEqual(
		rows.map((r) => [r.source, r.due]),
		[
			["reminders", "2026-05-01"],
			["workflowy", "2026-06-15"],
			["things", "2026-07-01"],
			["workflowy", null],
		],
	);
});

test("collectDueItems drops items due after today", () =>
{
	const rows = collectDueItems(
		{
			workflowy: [
				workflowyRoot(
					{
						tasks: [dated("Next month", "2026-09-01", "hhhhhhhhhhhh8888")],
					},
				),
			],
			things: null,
			reminders: null,
		},
		TODAY,
	);
	assert.deepStrictEqual(rows, []);
});

test("collectDueItems widens to items due within the horizon when asked", () =>
{
	const rows = collectDueItems(
		{
			workflowy: [
				workflowyRoot(
					{
						tasks: [
							dated("In three days", "2026-08-10", "hhhhhhhhhhhh8888"),
							dated("In eight days", "2026-08-15", "iiiiiiiiiiii9999"),
						],
					},
				),
			],
			things: null,
			reminders: null,
		},
		TODAY,
		{
			horizonDays: 7,
		},
	);
	assert.deepStrictEqual(
		rows.map((r) => [r.title, r.due, r.overdueByDays]),
		[["In three days", "2026-08-10", -3]],
	);
});

test("collectDueItems tolerates missing sources", () =>
{
	assert.deepStrictEqual(collectDueItems({}, TODAY), []);
});

test("resolveTimeframe converts the file-tasks timeframes into concrete dates", () =>
{
	// 2026-08-07 is a Friday, so "this week" lands on that same Friday.
	assert.strictEqual(resolveTimeframe("Today", TODAY), "2026-08-07");
	assert.strictEqual(resolveTimeframe("This week", TODAY), "2026-08-07");
	assert.strictEqual(resolveTimeframe("This month", TODAY), "2026-08-31");
});

test("resolveTimeframe picks the upcoming Friday mid-week", () =>
{
	assert.strictEqual(resolveTimeframe("This week", "2026-08-03"), "2026-08-07"); // Monday -> Friday
	assert.strictEqual(resolveTimeframe("This week", "2026-08-08"), "2026-08-14"); // Saturday -> next Friday
});

/**
 * Regression test for the reschedule placeholder. Workflowy stores dates as a `<time>` element,
 * but the Things and Reminders ops are AppleScript and need a plain date string. The walk was
 * documented to substitute `buildTimeElement(iso)` into every `{{date}}`, which injected HTML
 * markup into `set due date ... to date "..."` and set a garbage date. `applyReschedule` makes
 * the substitution source-aware so the caller never picks the format.
 */
test("applyReschedule substitutes a <time> element for Workflowy items", () =>
{
	const item = at(
		fromWorkflowy(
			[
				workflowyRoot(
					{
						tasks: [
							{
								name: 'Ship the thing <time startYear="2026" startMonth="6" startDay="1">Mon, Jun 1, 2026</time>',
								id: "wf-uuid",
							},
						],
					},
				),
			],
			TODAY,
		),
		0,
	);
	const cmd = applyReschedule(item, "2026-08-31");
	assert.match(cmd, /startYear="2026" startMonth="8" startDay="31"/u);
	assert.doesNotMatch(cmd, /\{\{date\}\}/u);
});

test("applyReschedule substitutes an AppleScript date string for Things items", () =>
{
	const item = at(
		fromThings(
			{
				due: [
					{
						id: "things-1",
						title: "Refill the propane tank",
						due: "2026-04-25",
					},
				],
			},
			TODAY,
		),
		0,
	);
	const cmd = applyReschedule(item, "2026-08-31");
	assert.doesNotMatch(cmd, /<time/u);
	assert.doesNotMatch(cmd, /\{\{date\}\}/u);
	assert.match(cmd, /date "August 31, 2026"/u);
});

test("applyReschedule substitutes an AppleScript date string for Reminders items", () =>
{
	const item = at(
		fromReminders(
			{
				overdue: [
					{
						title: "Replace the HEPA filters",
						dueDate: "2026-08-07T00:00:00-04:00",
					},
				],
			},
			TODAY,
		),
		0,
	);
	const cmd = applyReschedule(item, "2026-08-31");
	assert.doesNotMatch(cmd, /<time/u);
	assert.match(cmd, /date "August 31, 2026"/u);
});

/**
 * Regression test for the missing walk outcome. A task filed under `⏰ Tasks (due dates)` that has
 * no real deadline was only ever offered Done / Reschedule / Drop / Skip, so it got its date
 * pushed forward run after run instead of moving to the bucket it belongs in. `moveToAsap` files
 * it under `📌 Tasks (asap)` and strips the `<time>` element, since that bucket carries no dates.
 */
test("fromWorkflowy falls back to the asap bucket root when it has no tier ladder", () =>
{
	const item = at(
		fromWorkflowy(
			[
				workflowyRoot(
					{
						tasks: [dated("Turn rollups into a shared marketplace", "2026-08-07", "ffffffffffff6666")],
					},
				),
			],
			TODAY,
		),
		0,
	);

	assert.ok(item.ops.moveToAsap, "expected a moveToAsap op");
	assert.match(item.ops.moveToAsap, /node update --id ffffffffffff6666 --name /u);
	assert.doesNotMatch(item.ops.moveToAsap, /<time/u);
	assert.match(item.ops.moveToAsap, /node move --node-id ffffffffffff6666 --parent-id asap-uuid/u);
});

/**
 * A task that never had a real deadline is not urgent by definition, so it lands on the bottom
 * rung of the asap ladder rather than at the top of the bucket where it would outrank everything
 * the user deliberately promoted.
 */
test("moveToAsap targets the bottom tier when the asap bucket has a ladder", () =>
{
	const item = at(
		fromWorkflowy(
			[
				workflowyRoot(
					{
						tasks: [dated("Turn rollups into a shared marketplace", "2026-08-07", "ffffffffffff6666")],
						asapChildren: [
							{
								name: "1st",
								id: "tier-1-uuid",
								children: [],
							},
							{
								name: "2nd",
								id: "tier-2-uuid",
								children: [],
							},
							{
								name: "3rd",
								id: "tier-3-uuid",
								children: [],
							},
						],
					},
				),
			],
			TODAY,
		),
		0,
	);

	assert.match(item.ops.moveToAsap ?? "", /node move --node-id ffffffffffff6666 --parent-id tier-3-uuid -p bottom/u);
});

test("moveToAsap ignores category containers left over from before the tier migration", () =>
{
	const item = at(
		fromWorkflowy(
			[
				workflowyRoot(
					{
						tasks: [dated("Turn rollups into a shared marketplace", "2026-08-07", "ffffffffffff6666")],
						asapChildren: [
							{
								name: "💻 Coding",
								id: "cat-coding-uuid",
								children: [],
							},
						],
					},
				),
			],
			TODAY,
		),
		0,
	);

	assert.match(item.ops.moveToAsap ?? "", /node move --node-id ffffffffffff6666 --parent-id asap-uuid -p bottom/u);
});

test("moveToAsap is absent when the root has no asap bucket", () =>
{
	const root = workflowyRoot(
		{
			tasks: [dated("Orphan", "2026-08-07", "aaaaaaaaaaaa7777")],
		},
	);
	const wrapper = root.root.children?.[1];
	assert.ok(wrapper?.children);
	wrapper.children = [at(wrapper.children, 0)]; // drop the asap bucket
	const item = at(fromWorkflowy([root], TODAY), 0);
	assert.strictEqual(item.ops.moveToAsap, undefined);
});

test("resolveTimeframe reaches the longer horizons offered to repeatedly skipped tasks", () =>
{
	assert.strictEqual(resolveTimeframe("Next month", TODAY), "2026-09-07");
	assert.strictEqual(resolveTimeframe("Next quarter", TODAY), "2026-11-07");
});

test("resolveTimeframe still rejects a timeframe it does not know", () =>
{
	assert.throws(() => resolveTimeframe("Someday", TODAY), /unknown timeframe/u);
});

test("skipKey namespaces an item id by source so two systems cannot collide", () =>
{
	assert.strictEqual(
		skipKey(
			{
				source: "things",
				id: "abc",
			},
		),
		"things:abc",
	);
	assert.strictEqual(
		skipKey(
			{
				source: "reminders",
				id: "abc",
			},
		),
		"reminders:abc",
	);
});

test("collectDueItems reports a zero skip streak when there is no history", () =>
{
	const rows = collectDueItems(
		{
			things:
			{
				due: [
					{
						id: "things-1",
						title: "Renew the passport",
						due: "2026-07-01",
					},
				],
			},
		},
		TODAY,
	);
	assert.strictEqual(at(rows, 0).skipStreak, 0);
	assert.strictEqual(at(rows, 0).skippedSince, null);
});

test("collectDueItems carries each item skip streak onto its row", () =>
{
	const skipStreaks = foldSkipLog([
		{
			key: "things:things-1",
			outcome: "skip",
			date: "2026-08-05",
		},
		{
			key: "things:things-1",
			outcome: "skip",
			date: "2026-08-06",
		},
	]);
	const rows = collectDueItems(
		{
			things:
			{
				due: [
					{
						id: "things-1",
						title: "Renew the passport",
						due: "2026-07-01",
					},
				],
			},
		},
		TODAY,
		{
			skipStreaks,
		},
	);
	assert.strictEqual(at(rows, 0).skipStreak, 2);
	assert.strictEqual(at(rows, 0).skippedSince, "2026-08-05");
});

test("fromWorkflowy carries the subtree context the walk shows before asking", () =>
{
	const task = dated("Inventory the drives", "2026-08-01", "dddddddddddd1111");
	task.note = "started at https://example.com/notes";
	task.modifiedAt = "2026-07-30T09:15:00Z";
	task.children = [
		{
			name: 'Drive A <time startYear="2026" startMonth="1" startDay="2">Fri, Jan 2, 2026</time> ',
			shortId: "sid-a",
			children: [
				{
					name: "nested",
				},
			],
		},
		{
			name: "Drive B",
			shortId: null,
			note: "spare",
			children: [],
		},
	];
	const item = at(
		fromWorkflowy(
			[
				workflowyRoot(
					{
						tasks: [task],
					},
				),
			],
			TODAY,
		),
		0,
	);
	assert.strictEqual(item.note, "started at https://example.com/notes");
	assert.strictEqual(item.modifiedAt, "2026-07-30T09:15:00Z");
	assert.strictEqual(item.childCount, 2);
	assert.deepStrictEqual(item.children, [
		{
			title: "Drive A",
			note: null,
			childCount: 1,
			url: "https://workflowy.com/#/sid-a",
		},
		{
			title: "Drive B",
			note: "spare",
			childCount: 0,
			url: null,
		},
	]);
	assert.deepStrictEqual(item.links, ["https://example.com/notes"]);
});

test("fromThings carries the task note so the walk can show it", () =>
{
	const item = at(
		fromThings(
			{
				due: [
					{
						id: "T1",
						title: "Renew passport",
						due: "2026-08-01",
						list: "Today",
						notes: "form DS-82",
					},
				],
			},
			TODAY,
		),
		0,
	);
	assert.strictEqual(item.note, "form DS-82");
	assert.strictEqual(item.modifiedAt, null);
	assert.deepStrictEqual(item.children, []);
	assert.deepStrictEqual(item.links, []);
});

test("fromReminders carries the reminder note so the walk can show it", () =>
{
	const item = at(
		fromReminders(
			{
				overdue: [
					{
						title: "Pay the tolls",
						dueDate: "2026-08-05T09:00:00",
						list: "Reminders",
						notes: "account 4821",
					},
				],
			},
			TODAY,
		),
		0,
	);
	assert.strictEqual(item.note, "account 4821");
	assert.deepStrictEqual(item.children, []);
	assert.deepStrictEqual(item.links, []);
});

test("a URL in a Things note becomes a link the walk opens", () =>
{
	const item = at(
		fromThings(
			{
				due: [
					{
						id: "T2",
						title: "Watch the Factorio talk",
						due: "2026-08-01",
						list: "Today",
						notes: "https://youtube.com/watch?v=abc",
					},
				],
			},
			TODAY,
		),
		0,
	);
	assert.deepStrictEqual(item.links, ["https://youtube.com/watch?v=abc"]);
});

test("rows flag #llm-task items so batch pages can exclude them mechanically", () =>
{
	const rows = fromWorkflowy(
		[
			workflowyRoot(
				{
					tasks: [
						dated("Add photos to Status #llm-task", "2026-08-01", "aaaaaaaaaaaa1111"),
						dated("Call the allergist", "2026-08-01", "bbbbbbbbbbbb2222"),
					],
				},
			),
		],
		TODAY,
	);
	assert.deepStrictEqual(
		rows.map((r) => [r.title, r.isLlmTask]),
		[
			["Add photos to Status #llm-task", true],
			["Call the allergist", false],
		],
	);
	assert.deepStrictEqual(
		fromThings(
			{
				due: [
					{
						id: "t1",
						title: "Sort album #llm-task",
						due: "2026-08-01",
					},
				],
			},
			TODAY,
		).map((r) => r.isLlmTask),
		[true],
	);
	assert.deepStrictEqual(
		fromReminders(
			{
				overdue: [
					{
						title: "Pay rent",
						dueDate: "2026-08-01",
					},
				],
			},
			TODAY,
		).map((r) => r.isLlmTask),
		[false],
	);
});

test("rows flag Workflowy tasks whose children say Claude runs them but lack #llm-task", () =>
{
	const withChild = (node: TreeNode, child: string): TreeNode => (
	{
		...node,
		children: [
			{
				name: child,
			},
		],
	});
	const rows = fromWorkflowy(
		[
			workflowyRoot(
				{
					tasks: [
						withChild(
							dated("Add photos to Status", "2026-08-01", "aaaaaaaaaaaa1111"),
							"Claude does this end to end.",
						),
						withChild(
							dated("Call the allergist", "2026-08-01", "bbbbbbbbbbbb2222"),
							"Ask about the refill.",
						),
					],
				},
			),
		],
		TODAY,
	);
	assert.deepStrictEqual(
		rows.map((r) => [r.title, r.missingLlmTag]),
		[
			["Add photos to Status", true],
			["Call the allergist", false],
		],
	);
	assert.deepStrictEqual(
		fromThings(
			{
				due: [
					{
						id: "t1",
						title: "Sort album",
						due: "2026-08-01",
					},
				],
			},
			TODAY,
		).map((r) => r.missingLlmTag),
		[false],
	);
	assert.deepStrictEqual(
		fromReminders(
			{
				overdue: [
					{
						title: "Pay rent",
						dueDate: "2026-08-01",
					},
				],
			},
			TODAY,
		).map((r) => r.missingLlmTag),
		[false],
	);
});
