import {describe, expect, it} from "vite-plus/test";
import {setAccountFeatures} from "../src/client/features.js";
import
{
	MOVE_TO_DATE_COMMANDS,
	executeMirrorToDate,
	executeMoveToDate,
	moveToDateDestination,
} from "../src/client/move-to-date.js";

const FRIDAY = new Date(2026, 9, 23, 7, 39);
const SUNDAY = new Date(2026, 9, 25, 7, 39);

describe("MOVE_TO_DATE_COMMANDS", () =>
{
	it("holds upstream's seven commands", () =>
	{
		expect(MOVE_TO_DATE_COMMANDS).toStrictEqual(
			{
				move_to_today:
				{
					label: "Move to Today",
					icon: "calendar-day",
					aliases: ["move", "today"],
					verb: "move",
					verbPast: "moved",
				},
				move_to_tomorrow:
				{
					label: "Move to Tomorrow",
					icon: "calendar-circle-plus",
					aliases: ["move", "tomorrow"],
					verb: "move",
					verbPast: "moved",
				},
				move_to_next_week:
				{
					label: "Move to Next Week",
					icon: "calendar-week",
					aliases: ["move", "next week"],
					verb: "move",
					verbPast: "moved",
				},
				move_7_days_out:
				{
					label: "Move 7 Days Out",
					icon: "calendar-week",
					aliases: ["move", "7 days out"],
					verb: "move",
					verbPast: "moved",
				},
				move_to_date:
				{
					label: "Move to Date...",
					icon: "calendar-days",
					aliases: ["move", "date", "today"],
					verb: "move",
					verbPast: "moved",
				},
				mirror_to_today:
				{
					label: "Mirror to Today",
					icon: "diamond-turn-right",
					aliases: ["mirror", "today"],
					verb: "mirror",
					verbPast: "mirrored",
				},
				mirror_to_date:
				{
					label: "Mirror to Date...",
					icon: "diamond-turn-right",
					aliases: ["mirror", "date"],
					verb: "mirror",
					verbPast: "mirrored",
				},
			},
		);
	});
});

describe("moveToDateDestination", () =>
{
	it("keeps the time of day for today, tomorrow, next week and 7 days out (week starts Sunday)", () =>
	{
		expect(
			(["move_to_today", "move_to_tomorrow", "move_to_next_week", "move_7_days_out"] as const).map((key) =>
				moveToDateDestination(key, FRIDAY, 0),
			),
		).toStrictEqual([
			new Date(2026, 9, 23, 7, 39),
			new Date(2026, 9, 24, 7, 39),
			new Date(2026, 9, 25, 7, 39),
			new Date(2026, 9, 30, 7, 39),
		]);
	});

	it("next week honours a Monday week start", () =>
	{
		expect(moveToDateDestination("move_to_next_week", FRIDAY, 1)).toStrictEqual(new Date(2026, 9, 26, 7, 39));
	});

	it("next week on the week's first day is 7 days ahead", () =>
	{
		expect(moveToDateDestination("move_to_next_week", SUNDAY, 0)).toStrictEqual(new Date(2026, 10, 1, 7, 39));
	});
});

describe("executeMoveToDate", () =>
{
	async function run({
		ensured =
		{
			ok: true,
		},
		defaultToBottom = false,
	}:
	{
		ensured?:
		{
			ok: boolean;
		};
		defaultToBottom?: boolean;
	} = {})
	{
		const log: string[] = [];
		const toasts:
		{
			text: string;
			timeout: number;
			actions: string[];
			shortcuts: (string | undefined)[];
		}[] = [];
		const fetched: string[] = [];
		const moved = await executeMoveToDate(
			{
				items: ["x"],
				date: new Date(2026, 9, 24, 7, 39),
				verb: MOVE_TO_DATE_COMMANDS.move_to_tomorrow,
				fetch: async (url, init) =>
				{
					fetched.push(`${init?.method ?? "GET"} ${url}`);
					if (url.endsWith("/ensure?createChild=false"))
					{
						return Promise.resolve(
							ensured.ok
								? Response.json(
										{
											dayId: "day",
											firstChildId: null,
										},
									)
								: new Response(
										"no",
										{
											status: 500,
										},
									),
						);
					}
					return Promise.resolve(
						new Response(
							"missing",
							{
								status: 404,
							},
						),
					);
				},
				commitEdit: () =>
				{
					log.push("commit");
				},
				clearSelection: () =>
				{
					log.push("clear");
				},
				notify: (message) =>
				{
					log.push(`notify ${message}`);
				},
				loadTarget: async (id) =>
				{
					log.push(`load ${id}`);
					return Promise.resolve(
						{
							target:
							{
								id,
								name: "Sat, Oct 24, 2026",
								defaultToBottom,
							},
							childCount: 3,
							parentOf: () => null,
						},
					);
				},
				leaveItem: () =>
				{
					log.push("leave");
				},
				moveNodes: (moves) =>
				{
					log.push(`move ${JSON.stringify(moves)}`);
				},
				showToast: ({text, timeout, actions}) =>
				{
					toasts.push(
						{
							text,
							timeout,
							actions: actions.map(({label}) => label),
							shortcuts: actions.map(({shortcut}) => shortcut),
						},
					);
				},
				view: () =>
				{
				},
				undo: () =>
				{
				},
				onMoved: () =>
				{
					log.push("moved");
				},
			},
		);
		return {
			moved,
			log,
			toasts,
			fetched,
		};
	}

	it("ensures the day without a child, moves the item to its top and toasts View and Undo", async () =>
	{
		await expect(run()).resolves.toStrictEqual(
			{
				moved: true,
				log: [
					"commit",
					"clear",
					"load day",
					"leave",
					'move [{"ids":["x"],"parentId":"day","index":0}]',
					"moved",
				],
				toasts: [
					{
						text: "moved to 'Sat, Oct 24, 2026'",
						timeout: 5000,
						actions: ["View", "Undo"],
						shortcuts: ["shift+return", undefined],
					},
				],
				fetched: [
					"GET /api/v1/calendar/day/20261024",
					"POST /api/v1/calendar/day/20261024/ensure?createChild=false",
				],
			},
		);
	});

	it("moves to the bottom when the day defaults to bottom", async () =>
	{
		expect(
			(
				await run(
					{
						defaultToBottom: true,
					},
				)
			).log,
		).toContain('move [{"ids":["x"],"parentId":"day","index":3}]');
	});

	it("notifies and moves nothing when the day cannot be ensured", async () =>
	{
		await expect(
			run(
				{
					ensured:
					{
						ok: false,
					},
				},
			),
		).resolves.toStrictEqual(
			{
				moved: false,
				log: ["commit", "clear", "notify No calendar page for 2026-10-24 yet"],
				toasts: [],
				fetched: [
					"GET /api/v1/calendar/day/20261024",
					"POST /api/v1/calendar/day/20261024/ensure?createChild=false",
				],
			},
		);
	});
});

describe("executeMirrorToDate", () =>
{
	async function run({defaultToBottom = false, mirrored = 1} = {})
	{
		const log: string[] = [];
		const toasts:
		{
			text: string;
			actions: string[];
		}[] = [];
		const result = await executeMirrorToDate(
			{
				items: ["x"],
				date: new Date(2026, 9, 23, 7, 39),
				fetch: async (url) =>
					Promise.resolve(
						url.endsWith("/ensure?createChild=false")
							? Response.json(
									{
										dayId: "day",
										firstChildId: null,
									},
								)
							: new Response(
									"missing",
									{
										status: 404,
									},
								),
					),
				commitEdit: () =>
				{
					log.push("commit");
				},
				clearSelection: () =>
				{
					log.push("clear");
				},
				notify: (message) =>
				{
					log.push(`notify ${message}`);
				},
				loadTarget: async (id) =>
					Promise.resolve(
						{
							target:
							{
								id,
								name: "Fri, Oct 23, 2026",
								defaultToBottom,
							},
							childCount: 3,
							parentOf: () => null,
						},
					),
				mirrorNodes: async (request) =>
				{
					log.push(`mirror ${JSON.stringify(request)}`);
					return Promise.resolve(mirrored);
				},
				showToast: ({text, actions}) =>
				{
					toasts.push(
						{
							text,
							actions: actions.map(({label}) => label),
						},
					);
				},
				view: () =>
				{
				},
				undo: () =>
				{
				},
				onMirrored: () =>
				{
					log.push("mirrored");
				},
			},
		);
		return {
			result,
			log,
			toasts,
		};
	}

	it("mirrors the item at the top of the ensured day and toasts View and Undo", async () =>
	{
		await expect(run()).resolves.toStrictEqual(
			{
				result: true,
				log: ["commit", "clear", 'mirror {"item_ids":["x"],"parent_id":"day","index":0}', "mirrored"],
				toasts: [
					{
						text: "mirrored to 'Fri, Oct 23, 2026'",
						actions: ["View", "Undo"],
					},
				],
			},
		);
	});

	it("mirrors at the bottom when the day defaults to bottom", async () =>
	{
		expect(
			(
				await run(
					{
						defaultToBottom: true,
					},
				)
			).log,
		).toContain('mirror {"item_ids":["x"],"parent_id":"day","index":3}');
	});

	it("toasts nothing when no mirror was made", async () =>
	{
		await expect(
			run(
				{
					mirrored: 0,
				},
			),
		).resolves.toStrictEqual(
			{
				result: false,
				log: ["commit", "clear", 'mirror {"item_ids":["x"],"parent_id":"day","index":0}'],
				toasts: [],
			},
		);
	});
});

describe("calendar_node flag", () =>
{
	it("moves and mirrors nothing when the account flag is off", async () =>
	{
		const calls: string[] = [];
		const common =
		{
			date: FRIDAY,
			fetch: async () =>
			{
				calls.push("fetch");
				return Promise.resolve(
					new Response(
						"no",
						{
							status: 500,
						},
					),
				);
			},
			commitEdit: () =>
			{
				calls.push("commit");
			},
			clearSelection: () =>
			{
				calls.push("clear");
			},
			notify: () =>
			{
				calls.push("notify");
			},
			loadTarget: async () => Promise.reject(new Error("unreachable")),
		};
		setAccountFeatures({});
		try
		{
			const moved = await executeMoveToDate(
				{
					...common,
					items: ["x"],
					verb: MOVE_TO_DATE_COMMANDS.move_to_today,
				} as never,
			);
			const mirrored = await executeMirrorToDate(
				{
					...common,
					items: ["x"],
				} as never,
			);
			expect(
				{
					moved,
					mirrored,
					calls,
				},
			).toStrictEqual(
				{
					moved: false,
					mirrored: false,
					calls: [],
				},
			);
		}
		finally
		{
			setAccountFeatures(null);
		}
	});
});
