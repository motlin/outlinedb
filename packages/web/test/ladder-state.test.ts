import {describe, expect, it} from "vite-plus/test";
import type {Ladder} from "../src/server/ladder-model.js";
import
{
	applyLadderEvent,
	ladderMoveSelection,
	moveWithin,
	selectLadderRange,
	stepBeforeId,
	tierOf,
} from "../src/client/ladder-state.js";

const ladder = (): Record<string, Ladder> => (
{
	work:
	{
		root: "work",
		bucketId: "wb",
		tiers: [
			{
				tier: 1,
				label: "1st",
				id: "w1",
				capacity: 2,
				state: "exact",
				items: [
					{
						id: "a",
						name: "A",
						children: [],
						descendantCount: 0,
					},
					{
						id: "b",
						name: "B",
						children: [],
						descendantCount: 0,
					},
				],
			},
			{
				tier: 2,
				label: "2nd",
				id: "w2",
				capacity: 4,
				state: "room",
				items: [],
			},
		],
	},
});

describe("moveWithin", () =>
{
	it("relocates the row and recomputes both tiers capacity state", () =>
	{
		const next = moveWithin(ladder(), "work", "a", "2nd");
		expect(next.work.tiers[0].items.map((i) => i.id)).toStrictEqual(["b"]);
		expect(next.work.tiers[0].state).toBe("room");
		expect(next.work.tiers[1].items.map((i) => i.id)).toStrictEqual(["a"]);
	});

	it("flags the destination as over once it passes its cap", () =>
	{
		const start = ladder();
		start.work.tiers[1] =
		{
			...start.work.tiers[1],
			capacity: 1,
			items: [
				{
					id: "c",
					name: "C",
					children: [],
					descendantCount: 0,
				},
			],
		};
		const next = moveWithin(start, "work", "a", "2nd");
		expect(next.work.tiers[1].state).toBe("over");
	});

	it("leaves the ladder untouched when the row is not on it", () =>
	{
		const start = ladder();
		expect(moveWithin(start, "work", "missing", "2nd")).toBe(start);
	});
});

describe("applyLadderEvent", () =>
{
	it("applies a move announced over the socket", () =>
	{
		const next = applyLadderEvent(
			ladder(),
			{
				verb: "move",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: "2nd",
				at: "T",
			},
		);
		expect(next.work.tiers[1].items.map((i) => i.id)).toStrictEqual(["a"]);
	});

	it("drops a completed row off the ladder", () =>
	{
		const next = applyLadderEvent(
			ladder(),
			{
				verb: "complete",
				nodeId: "a",
				name: "A",
				fromTier: "1st",
				toTier: null,
				at: "T",
			},
		);
		expect(next.work.tiers[0].items.map((i) => i.id)).toStrictEqual(["b"]);
		expect(next.work.tiers[0].state).toBe("room");
	});

	it("ignores an event for a node it has never seen rather than inventing a row", () =>
	{
		const start = ladder();
		expect(
			applyLadderEvent(
				start,
				{
					verb: "move",
					nodeId: "zz",
					name: "Z",
					fromTier: "1st",
					toTier: "2nd",
					at: "T",
				},
			),
		).toBe(start);
	});
});

describe("tierOf", () =>
{
	it("names the tier a row currently sits in", () =>
	{
		expect(tierOf(ladder(), "work", "b")).toBe("1st");
	});

	it("returns undefined for a row that is not on that ladder", () =>
	{
		expect(tierOf(ladder(), "work", "nope")).toBeUndefined();
		expect(tierOf(ladder(), "missing-root", "a")).toBeUndefined();
	});
});

describe("selectLadderRange", () =>
{
	it("includes both endpoints in either direction across tiers", () =>
	{
		const input = ladder().work;
		input.tiers[1].items = [
			{
				id: "c",
				name: "Charlie",
				children: [],
				descendantCount: 0,
			},
		];
		expect(selectLadderRange(input, "c", "a")).toStrictEqual(new Set(["a", "b", "c"]));
	});

	it("drops a stale selection anchor after a completion", () =>
	{
		expect(selectLadderRange(ladder().work, "completed", "b")).toStrictEqual(new Set(["b"]));
	});
});

describe("ladderMoveSelection", () =>
{
	it("uses display order and drops completed rows from a selected group", () =>
	{
		expect(ladderMoveSelection(ladder().work, new Set(["b", "completed", "a"]), "b")).toStrictEqual(["a", "b"]);
	});
	it("moves only the dragged row when it is outside the selection", () =>
	{
		expect(ladderMoveSelection(ladder().work, new Set(["b"]), "a")).toStrictEqual(["a"]);
	});
});

describe("precise row placement", () =>
{
	it("reorders within a tier and applies the confirming event idempotently", () =>
	{
		const moved = moveWithin(ladder(), "work", "b", "1st", "a");
		const event =
		{
			verb: "move" as const,
			nodeId: "b",
			name: "B",
			fromTier: "1st",
			toTier: "1st",
			beforeNodeId: "a",
			at: "2000-01-01T00:00:00.000Z",
		};
		expect(moved.work.tiers.map((tier) => tier.items.map((item) => item.id))).toStrictEqual([["b", "a"], []]);
		expect(applyLadderEvent(moved, event)).toStrictEqual(moved);
	});

	it("appends within the same tier when dropped after its last row", () =>
	{
		const moved = moveWithin(ladder(), "work", "a", "1st", "");
		expect(moved.work.tiers.map((tier) => tier.items.map((item) => item.id))).toStrictEqual([["b", "a"], []]);
	});
});

describe("stepBeforeId", () =>
{
	const three = (): Record<string, Ladder> => (
	{
		work:
		{
			root: "work",
			bucketId: "wb",
			tiers: [
				{
					tier: 1,
					label: "1st",
					id: "w1",
					capacity: 2,
					state: "exact",
					items: [
						{
							id: "a",
							name: "A",
							children: [],
							descendantCount: 0,
						},
						{
							id: "b",
							name: "B",
							children: [],
							descendantCount: 0,
						},
					],
				},
				{
					tier: 2,
					label: "2nd",
					id: "w2",
					capacity: 4,
					state: "room",
					items: [
						{
							id: "c",
							name: "C",
							children: [],
							descendantCount: 0,
						},
						{
							id: "d",
							name: "D",
							children: [],
							descendantCount: 0,
						},
					],
				},
				{
					tier: 3,
					label: "3rd",
					id: "w3",
					capacity: 8,
					state: "room",
					items: [],
				},
			],
		},
	});
	const step = (ladders: Record<string, Ladder>, ids: string[], toTier: string, direction: "up" | "down") =>
	{
		const before = stepBeforeId(ladders.work, toTier, direction, ids);
		return ids.reduce((current, id) => moveWithin(current, "work", id, toTier, before), ladders);
	};
	const order = (ladders: Record<string, Ladder>) =>
		ladders.work.tiers.map((tier) => tier.items.map((item) => item.id));

	it("lands a row stepped down at the top of the next tier", () =>
	{
		expect(stepBeforeId(three().work, "2nd", "down", ["b"])).toBe("c");
		expect(order(step(three(), ["b"], "2nd", "down"))).toStrictEqual([["a"], ["b", "c", "d"], []]);
	});

	it("lands a row stepped up at the bottom of the previous tier", () =>
	{
		expect(stepBeforeId(three().work, "1st", "up", ["c"])).toBeUndefined();
		expect(order(step(three(), ["c"], "1st", "up"))).toStrictEqual([["a", "b", "c"], ["d"], []]);
	});

	it("appends when stepping down into an empty tier", () =>
	{
		expect(stepBeforeId(three().work, "3rd", "down", ["c"])).toBeUndefined();
		expect(order(step(three(), ["c"], "3rd", "down"))).toStrictEqual([["a", "b"], ["d"], ["c"]]);
	});

	it("keeps a multi-row selection in display order in both directions", () =>
	{
		expect(order(step(three(), ["a", "b"], "2nd", "down"))).toStrictEqual([[], ["a", "b", "c", "d"], []]);
		expect(order(step(three(), ["c", "d"], "1st", "up"))).toStrictEqual([["a", "b", "c", "d"], [], []]);
	});

	it("skips selected rows already in the destination when picking the anchor", () =>
	{
		expect(stepBeforeId(three().work, "2nd", "down", ["b", "c"])).toBe("d");
	});
});
