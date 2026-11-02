import {describe, expect, it} from "vite-plus/test";
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
