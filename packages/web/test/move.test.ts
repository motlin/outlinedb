import {describe, expect, it} from "vite-plus/test";
import {movePaneItems} from "../src/client/components/move-pane-items.js";
import {setAccountFeatures} from "../src/client/features.js";
import
{
	MOVE_TO_DATE_COMMANDS,
	executeMirrorToDate,
	executeMoveToDate,
	moveToDateDestination,
} from "../src/client/move-to-date.js";
import
{
	canMoveUnder,
	canMoveUnderCalendar,
	executeMoveTo,
	moveToastText,
	planMoveTo,
	runMoveTo,
	viewMovedTarget,
} from "../src/client/move-to.js";
import type {MoveToToast} from "../src/client/move-to.js";
import type {BlockMove} from "../src/client/tree-ops.js";

describe("move pane items", () =>
{
	const A = "AAAAAAAAAAA";
	const B = "BBBBBBBBBBB";

	function rows(
		panes:
		{
			id: string;
		}[],
		paneId: string,
	)
	{
		const moves: string[] = [];
		const items = movePaneItems(
			{
				panes,
			},
			paneId,
			(id, index) =>
			{
				moves.push(`${id}:${index}`);
			},
		);
		for (const item of items)
		{
			if (item.disabled !== true)
			{
				item.onSelect();
			}
		}
		return {
			rows: items.map((item) => `${item.label}${item.disabled === true ? " (disabled)" : ""}`),
			moves,
		};
	}

	describe("movePaneItems", () =>
	{
		it("is hidden with no pane open", () =>
		{
			expect(rows([], "main")).toStrictEqual(
				{
					rows: [],
					moves: [],
				},
			);
		});

		it("disables the direction the pane cannot move and moves the menu's own pane one place", () =>
		{
			expect(
				{
					main: rows(
						[
							{
								id: A,
							},
							{
								id: B,
							},
						],
						"main",
					),
					middle: rows(
						[
							{
								id: A,
							},
							{
								id: B,
							},
						],
						A,
					),
					last: rows(
						[
							{
								id: A,
							},
							{
								id: B,
							},
						],
						B,
					),
				},
			).toStrictEqual(
				{
					main:
					{
						rows: ["Move pane left (disabled)", "Move pane right"],
						moves: ["main:1"],
					},
					middle:
					{
						rows: ["Move pane left", "Move pane right"],
						moves: [`${A}:0`, `${A}:2`],
					},
					last:
					{
						rows: ["Move pane left", "Move pane right (disabled)"],
						moves: [`${B}:1`],
					},
				},
			);
		});
	});
});

describe("move to date", () =>
{
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
});

describe("move to", () =>
{
	// home > grandpa > {dad > {item > {child > {grandchild}}}, uncle}
	const MOVE =
	{
		verb: "move",
		verbPast: "moved",
	} as const;
	const MIRROR =
	{
		verb: "mirror",
		verbPast: "mirrored",
	} as const;

	const PARENTS: Record<string, string | null> =
	{
		grandpa: null,
		dad: "grandpa",
		uncle: "grandpa",
		item: "dad",
		child: "item",
		grandchild: "child",
	};
	const parentOf = (id: string): string | null => PARENTS[id] ?? null;

	describe("canMoveUnder", () =>
	{
		it("is false for the item itself", () =>
		{
			expect(canMoveUnder(parentOf, "item", "item")).toBe(false);
		});

		it("is false for a descendant of the item", () =>
		{
			expect(canMoveUnder(parentOf, "item", "grandchild")).toBe(false);
		});

		it("is true for an uncle", () =>
		{
			expect(canMoveUnder(parentOf, "item", "uncle")).toBe(true);
		});
	});

	describe("planMoveTo", () =>
	{
		it("lands the items as one block at the top of the target by default", () =>
		{
			expect(
				planMoveTo(
					{
						items: ["a2", "a4"],
						target:
						{
							id: "bravo",
							defaultToBottom: false,
						},
						childCount: 2,
					},
				),
			).toStrictEqual(
				{
					ids: ["a2", "a4"],
					parentId: "bravo",
					index: 0,
				},
			);
		});

		it("lands at the bottom when the target defaults to bottom", () =>
		{
			expect(
				planMoveTo(
					{
						items: ["a2"],
						target:
						{
							id: "bravo",
							defaultToBottom: true,
						},
						childCount: 2,
					},
				),
			).toStrictEqual(
				{
					ids: ["a2"],
					parentId: "bravo",
					index: 2,
				},
			);
		});
	});

	describe("moveToastText", () =>
	{
		it("names the target", () =>
		{
			expect(moveToastText("ok", MOVE, "Charlie")).toBe("moved to 'Charlie'");
			expect(moveToastText("cant", MOVE, "Charlie")).toBe("Can't move to 'Charlie'");
			expect(moveToastText("ok", MIRROR, "Charlie")).toBe("mirrored to 'Charlie'");
			expect(moveToastText("cant", MIRROR, "Charlie")).toBe("Can't mirror to 'Charlie'");
		});
	});

	interface Recorded
	{
		moves: BlockMove[][];
		toasts: MoveToToast[];
		views: string[];
		undos: string[];
	}

	function run(
		targetId: string,
		{
			defaultToBottom = false,
			items = ["item"],
		}:
		{
			defaultToBottom?: boolean;
			items?: string[];
		} = {},
	): Recorded &
	{
		moved: boolean;
	}
	{
		const recorded: Recorded =
		{
			moves: [],
			toasts: [],
			views: [],
			undos: [],
		};
		const moved = runMoveTo(
			{
				items,
				target:
				{
					id: targetId,
					name: "Uncle",
					defaultToBottom,
				},
				childCount: 4,
				parentOf,
				moveNodes: (moves) =>
				{
					recorded.moves.push(moves);
				},
				showToast: (toast) =>
				{
					recorded.toasts.push(toast);
				},
				view: (id) =>
				{
					recorded.views.push(id);
				},
				undo: () =>
				{
					recorded.undos.push("undo");
				},
			},
		);
		return {
			...recorded,
			moved,
		};
	}

	describe("runMoveTo", () =>
	{
		it("moves the item to the target's default slot and toasts View and Undo for 5s", () =>
		{
			const result = run("uncle");
			expect(
				{
					moved: result.moved,
					moves: result.moves,
					toasts: result.toasts.map(({text, timeout, actions}) => (
					{
						text,
						timeout,
						actions: actions.map(({label, shortcut}) => (
						{
							label,
							shortcut,
						})),
					})),
				},
			).toStrictEqual(
				{
					moved: true,
					moves: [
						[
							{
								ids: ["item"],
								parentId: "uncle",
								index: 0,
							},
						],
					],
					toasts: [
						{
							text: "moved to 'Uncle'",
							timeout: 5000,
							actions: [
								{
									label: "View",
									shortcut: "shift+return",
								},
								{
									label: "Undo",
									shortcut: undefined,
								},
							],
						},
					],
				},
			);
		});

		it("uses the bottom slot for a defaultToBottom target", () =>
		{
			expect(
				run(
					"uncle",
					{
						defaultToBottom: true,
					},
				).moves,
			).toStrictEqual([
				[
					{
						ids: ["item"],
						parentId: "uncle",
						index: 4,
					},
				],
			]);
		});

		it("View zooms to the target and Undo pops the undo stack, as upstream's WF.Undo.undo", () =>
		{
			const result = run("uncle");
			for (const action of result.toasts[0]?.actions ?? [])
			{
				action.run();
			}
			expect(
				{
					views: result.views,
					undos: result.undos,
					moves: result.moves,
				},
			).toStrictEqual(
				{
					views: ["uncle"],
					undos: ["undo"],
					moves: [
						[
							{
								ids: ["item"],
								parentId: "uncle",
								index: 0,
							},
						],
					],
				},
			);
		});

		it("moves a multi-selection as one block in document order", () =>
		{
			const result = run(
				"grandpa",
				{
					items: ["item", "sibling", "nephew"],
				},
			);
			expect(
				{
					moved: result.moved,
					moves: result.moves,
				},
			).toStrictEqual(
				{
					moved: true,
					moves: [
						[
							{
								ids: ["item", "sibling", "nephew"],
								parentId: "grandpa",
								index: 0,
							},
						],
					],
				},
			);
		});

		it("refuses a descendant target: no move, a Can't move toast", () =>
		{
			const result = run("grandchild");
			expect(
				{
					moved: result.moved,
					moves: result.moves,
					toasts: result.toasts,
				},
			).toStrictEqual(
				{
					moved: false,
					moves: [],
					toasts: [
						{
							text: "Can't move to 'Uncle'",
							timeout: 5000,
							actions: [],
							type: "failure",
						},
					],
				},
			);
		});

		it("refuses the whole selection when the target is under any selected item", () =>
		{
			const result = run(
				"child",
				{
					items: ["sibling", "item"],
				},
			);
			expect(
				{
					moved: result.moved,
					moves: result.moves,
					toasts: result.toasts,
				},
			).toStrictEqual(
				{
					moved: false,
					moves: [],
					toasts: [
						{
							text: "Can't move to 'Uncle'",
							timeout: 5000,
							actions: [],
							type: "failure",
						},
					],
				},
			);
		});
	});

	async function execute(
		picked:
			|
			  {
					id: string;
			  }
			|
			  {
					createdId: string;
			  }
			| undefined,
	)
	{
		const log: string[] = [];
		const moved = await executeMoveTo(
			{
				items: ["item"],
				pick: async () => Promise.resolve(picked),
				loadTarget: async (id) =>
				{
					log.push(`load ${id}`);
					return Promise.resolve(
						{
							target:
							{
								id,
								name: "Uncle",
							},
							childCount: 2,
							parentOf,
						},
					);
				},
				leaveItem: () =>
				{
					log.push("leave");
				},
				moveNodes: (moves) =>
				{
					for (const move of moves)
					{
						log.push(`move ${move.ids.join(",")} ${String(move.parentId)} ${String(move.index)}`);
					}
				},
				showToast: (toast) =>
				{
					log.push(`toast ${toast.text}`);
				},
				view: () =>
				{
				},
				undo: () =>
				{
				},
			},
		);
		return {
			moved,
			log,
		};
	}
	describe("executeMoveTo", () =>
	{
		it("does nothing when the picker closes without a choice", async () =>
		{
			await expect(execute(undefined)).resolves.toStrictEqual(
				{
					moved: false,
					log: [],
				},
			);
		});

		it("loads the chosen location, leaves the item's row, then moves it and toasts", async () =>
		{
			await expect(
				execute(
					{
						id: "uncle",
					},
				),
			).resolves.toStrictEqual(
				{
					moved: true,
					log: ["load uncle", "leave", "move item uncle 0", "toast moved to 'Uncle'"],
				},
			);
		});

		it("moves into a location the picker just created", async () =>
		{
			expect(
				(
					await execute(
						{
							createdId: "fresh",
						},
					)
				).log,
			).toStrictEqual(["load fresh", "leave", "move item fresh 0", "toast moved to 'Uncle'"]);
		});

		it("keeps the caret on the item when the location is under it", async () =>
		{
			await expect(
				execute(
					{
						id: "grandchild",
					},
				),
			).resolves.toStrictEqual(
				{
					moved: false,
					log: ["load grandchild", "toast Can't move to 'Uncle'"],
				},
			);
		});
	});

	describe("viewMovedTarget", () =>
	{
		const record = (paneId: string | null): string[][] =>
		{
			const calls: string[][] = [];
			viewMovedTarget(
				"charlie",
				paneId,
				{
					zoomPane: (pane, target) =>
					{
						calls.push(["zoomPane", pane, target]);
					},
					zoomMain: (target) =>
					{
						calls.push(["zoomMain", target]);
					},
				},
			);
			return calls;
		};

		it("zooms the pane Move To ran in", () =>
		{
			expect(record("pane-2")).toStrictEqual([["zoomPane", "pane-2", "charlie"]]);
		});

		it("zooms the main outline when Move To ran there", () =>
		{
			expect(record(null)).toStrictEqual([["zoomMain", "charlie"]]);
		});
	});

	describe("canMoveUnderCalendar", () =>
	{
		const levels =
		{
			year: true,
			month: true,
			week: false,
			day: true,
		};
		const tag = (level: string, dateId: number, restorableUniqueNode = true) => (
		{
			calendar:
			{
				level,
				dateId,
				root: false,
				foundDates: null,
				dayPrefix: null,
				restorableUniqueNode,
			},
		});
		const day = tag("day", 20_261_005);
		const month = (dateId: number) => (
		{
			calendar: tag("month", dateId).calendar,
		});
		const root =
		{
			calendar:
			{
				level: null,
				dateId: null,
				root: true,
				foundDates: null,
				dayPrefix: null,
				restorableUniqueNode: false,
			},
		};
		const plain =
		{
			calendar: null,
		};

		it("lets a restorable day move only under its own month", () =>
		{
			expect([
				canMoveUnderCalendar(
					{
						...day,
						isMirror: false,
					},
					month(20_261_000),
					levels,
				),
				canMoveUnderCalendar(
					{
						...day,
						isMirror: false,
					},
					month(20_261_100),
					levels,
				),
				canMoveUnderCalendar(
					{
						...day,
						isMirror: false,
					},
					tag("year", 20_260_000),
					levels,
				),
				canMoveUnderCalendar(
					{
						...day,
						isMirror: false,
					},
					plain,
					levels,
				),
			]).toStrictEqual([true, false, false, false]);
		});

		it("lets a restorable year move only under the calendar root", () =>
		{
			const year = tag("year", 20_260_000);

			expect([
				canMoveUnderCalendar(
					{
						...year,
						isMirror: false,
					},
					root,
					levels,
				),
				canMoveUnderCalendar(
					{
						...year,
						isMirror: false,
					},
					month(20_261_000),
					levels,
				),
				canMoveUnderCalendar(
					{
						...year,
						isMirror: false,
					},
					plain,
					levels,
				),
			]).toStrictEqual([true, false, false]);
		});

		it("moves an adopted day, a mirror and a plain row freely", () =>
		{
			expect([
				canMoveUnderCalendar(
					{
						...tag("day", 20_261_005, false),
						isMirror: false,
					},
					plain,
					levels,
				),
				canMoveUnderCalendar(
					{
						...day,
						isMirror: true,
					},
					plain,
					levels,
				),
				canMoveUnderCalendar(
					{
						calendar: null,
						isMirror: false,
					},
					plain,
					levels,
				),
			]).toStrictEqual([true, true, true]);
		});
	});
});
