// Run: node --test plugins/gtd/scripts/collect-completed-tasks.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {collectCompletedTasks, completionDate} from "./collect-completed-tasks.mts";

test("completionDate converts a UTC completion timestamp to the local calendar date", () =>
{
	assert.equal(completionDate("2026-10-24T15:30:00.000Z", "America/New_York"), "2026-10-24");
	assert.equal(completionDate("2026-10-25T02:30:00.000Z", "America/New_York"), "2026-10-24");
});

test("collects only the top-most completed items under each root's tasks wrapper, in tree order", () =>
{
	const personal =
	{
		id: "personal-root",
		name: "Personal",
		children: [
			{
				id: "tasks",
				name: "✅ Tasks",
				children: [
					{
						id: "asap",
						name: "📌 Tasks (asap)",
						children: [
							{
								id: "tier1",
								name: "1st",
								children: [
									{
										id: "open",
										name: "Open task",
										completedAt: null,
									},
									{
										id: "done-parent",
										name: "Done parent",
										completedAt: "2026-10-24T15:30:00.000Z",
										children: [
											{
												id: "done-child",
												name: "Done child",
												completedAt: "2026-10-24T15:31:00.000Z",
											},
										],
									},
								],
							},
						],
					},
					{
						id: "loose-done",
						name: "Loose done",
						completedAt: "2026-10-20T12:00:00.000Z",
					},
				],
			},
			{
				id: "agendas",
				name: "📋 Meeting agendas",
				children: [
					{
						id: "agenda-done",
						name: "Done agenda",
						completedAt: "2026-10-01T12:00:00.000Z",
					},
				],
			},
		],
	};
	const rows = collectCompletedTasks(
		[
			{
				root: "Personal",
				tree: personal,
			},
		],
		"America/New_York",
	);
	assert.deepEqual(rows, [
		{
			root: "Personal",
			id: "done-parent",
			name: "Done parent",
			completedAt: "2026-10-24T15:30:00.000Z",
			completedDate: "2026-10-24",
			path: ["✅ Tasks", "📌 Tasks (asap)", "1st"],
			childCount: 1,
		},
		{
			root: "Personal",
			id: "loose-done",
			name: "Loose done",
			completedAt: "2026-10-20T12:00:00.000Z",
			completedDate: "2026-10-20",
			path: ["✅ Tasks"],
			childCount: 0,
		},
	]);
});

test("a root without a tasks wrapper yields nothing", () =>
{
	assert.deepEqual(
		collectCompletedTasks(
			[
				{
					root: "Work",
					tree:
					{
						id: "w",
						name: "Work",
						children: [],
					},
				},
			],
			"UTC",
		),
		[],
	);
});
