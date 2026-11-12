// Run: node --test plugins/gtd/scripts/asap-tiers.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import
{
	bottomTier,
	filingChoices,
	ladderCapacity,
	matchLadderHomes,
	parseTierLabel,
	planGroup,
	planInsertion,
	planRebalance,
	planRescue,
	readLadder,
	tierCapacity,
	tierLabel,
	tiersNeededFor,
} from "./asap-tiers.mts";
import {at} from "./test-helpers.mts";

const item = (id: string) => (
{
	id,
	name: `task ${id}`,
});
const fill = (tier: number, n: number) => (
{
	name: tierLabel(tier),
	id: `tier-${tier}`,
	children: Array.from(
		{
			length: n,
		},
		(_, i) => item(`t${tier}-${i}`),
	),
});

test("tierLabel produces English ordinals", () =>
{
	assert.deepStrictEqual([1, 2, 3, 4, 5, 11, 12, 13, 21, 22, 23, 101].map(tierLabel), [
		"1st",
		"2nd",
		"3rd",
		"4th",
		"5th",
		"11th",
		"12th",
		"13th",
		"21st",
		"22nd",
		"23rd",
		"101st",
	]);
});

test("parseTierLabel round-trips tier labels and rejects category names", () =>
{
	assert.strictEqual(parseTierLabel("1st"), 1);
	assert.strictEqual(parseTierLabel("  3rd  "), 3);
	assert.strictEqual(parseTierLabel("💻 Coding"), null);
	assert.strictEqual(parseTierLabel("Administrative"), null);
	assert.strictEqual(parseTierLabel("1th"), null);
	assert.strictEqual(parseTierLabel("0th"), null);
});

/**
 * The whole point of the ladder: each tier holds at most half the tier below it, so capacity is
 * 2^k. These are fixed, never derived from what the tier below currently holds -- a relative cap
 * would push items out of 1st every time something in 2nd got completed, punishing progress.
 */
test("tierCapacity is a fixed power of two per tier", () =>
{
	assert.deepStrictEqual([1, 2, 3, 4, 5].map(tierCapacity), [2, 4, 8, 16, 32]);
});

test("ladderCapacity sums the tiers and tiersNeededFor inverts it", () =>
{
	assert.deepStrictEqual([1, 2, 3, 4, 5].map(ladderCapacity), [2, 6, 14, 30, 62]);
	assert.strictEqual(tiersNeededFor(10), 3);
	assert.strictEqual(tiersNeededFor(14), 3);
	assert.strictEqual(tiersNeededFor(15), 4);
	assert.strictEqual(tiersNeededFor(34), 5);
	assert.strictEqual(tiersNeededFor(0), 1);
});

test("readLadder splits tier children from everything else in the bucket", () =>
{
	const ladder = readLadder(
		{
			id: "asap-uuid",
			children: [
				fill(1, 2),
				{
					name: "2nd",
					id: "tier-2",
					children: [
						item("a"),
						{
							id: "done",
							name: "x",
							completedAt: "2026-08-01",
						},
					],
				},
				{
					name: "💻 Coding",
					id: "cat-coding",
					children: [item("c1")],
				},
				item("loose-1"),
			],
		},
	);

	assert.deepStrictEqual(
		ladder.tiers.map((t) => [t.tier, t.label, t.id, t.capacity, t.items.length]),
		[
			[1, "1st", "tier-1", 2, 2],
			[2, "2nd", "tier-2", 4, 1],
		],
	);
	assert.deepStrictEqual(
		ladder.unfiled.map((n) => n.id),
		["cat-coding", "loose-1"],
	);
});

test("readLadder orders tiers by rank regardless of child order", () =>
{
	const ladder = readLadder(
		{
			id: "asap-uuid",
			children: [fill(3, 0), fill(1, 0), fill(2, 0)],
		},
	);
	assert.deepStrictEqual(
		ladder.tiers.map((t) => t.tier),
		[1, 2, 3],
	);
});

test("bottomTier is the deepest tier, or null on a bucket with no ladder", () =>
{
	assert.strictEqual(
		bottomTier(
			readLadder(
				{
					id: "a",
					children: [fill(1, 0), fill(2, 0)],
				},
			),
		)?.tier,
		2,
	);
	assert.strictEqual(
		bottomTier(
			readLadder(
				{
					id: "a",
					children: [],
				},
			),
		),
		null,
	);
});

test("planInsertion into a tier with room plans only the target", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 1), fill(2, 0)],
		},
	);
	assert.deepStrictEqual(
		planInsertion(ladder, 1),
		{
			targetTier: 1,
			targetId: "tier-1",
			createTiers: [],
		},
	);
});

/**
 * Filing into a full tier never moves anything else. The tier simply runs over its cap, and the
 * user rebalances it later on the ladder page.
 */
test("planInsertion into a full tier moves nothing else", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 1)],
		},
	);
	assert.deepStrictEqual(
		planInsertion(ladder, 1),
		{
			targetTier: 1,
			targetId: "tier-1",
			createTiers: [],
		},
	);
});

test("planInsertion into consecutive full tiers moves nothing else", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 4), fill(3, 3)],
		},
	);
	assert.deepStrictEqual(
		planInsertion(ladder, 1),
		{
			targetTier: 1,
			targetId: "tier-1",
			createTiers: [],
		},
	);
});

test("planInsertion lets the bottom tier run over its cap", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 9)],
		},
	);
	assert.deepStrictEqual(
		planInsertion(ladder, 2),
		{
			targetTier: 2,
			targetId: "tier-2",
			createTiers: [],
		},
	);
});

test("planInsertion creates every missing tier down to the target", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [],
		},
	);
	assert.deepStrictEqual(
		planInsertion(ladder, 3),
		{
			targetTier: 3,
			targetId: null,
			createTiers: [
				{
					tier: 1,
					label: "1st",
				},
				{
					tier: 2,
					label: "2nd",
				},
				{
					tier: 3,
					label: "3rd",
				},
			],
		},
	);
});

test("planInsertion rejects a target that is not a positive tier rank", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 0)],
		},
	);
	assert.throws(() => planInsertion(ladder, 0), /tier rank/u);
	assert.throws(() => planInsertion(ladder, 1.5), /tier rank/u);
});

/**
 * planRebalance reads a ladder that is already out of shape. Insertion never moves other items,
 * so a ladder that drifted over cap needs a separate pass that proposes -- never applies -- the
 * push-downs, pull-ups, and the extension of the bottom tier.
 */
test("planRebalance on a balanced ladder proposes nothing and surfaces tiers 1-2 as the day plan", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 3), fill(3, 5), fill(4, 9)],
		},
	);
	const plan = planRebalance(ladder);
	assert.deepStrictEqual(plan.pushDowns, []);
	assert.deepStrictEqual(plan.pullUps, []);
	assert.strictEqual(plan.extend, null);
	assert.deepStrictEqual(
		plan.dayPlan.map((t) => [t.tier, t.label, t.id, t.items.map((i) => i.id)]),
		[
			[1, "1st", "tier-1", ["t1-0", "t1-1"]],
			[2, "2nd", "tier-2", ["t2-0", "t2-1", "t2-2"]],
		],
	);
});

/**
 * An over-cap tier lists every occupant and the minimum number that has to leave. It never picks
 * a victim: which items are lowest priority is the user's call, not the bottom-most position.
 */
test("planRebalance lists every occupant of an over-cap tier and the minimum to demote, without choosing", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 3), fill(2, 6), fill(3, 8), fill(4, 4)],
		},
	);
	const plan = planRebalance(ladder);
	assert.deepStrictEqual(
		plan.pushDowns.map((p) => [
			p.tier,
			p.label,
			p.id,
			p.count,
			p.capacity,
			p.excess,
			p.toTier,
			p.toId,
			p.items.length,
		]),
		[
			[1, "1st", "tier-1", 3, 2, 1, 2, "tier-2", 3],
			[2, "2nd", "tier-2", 6, 4, 2, 3, "tier-3", 6],
		],
	);
	assert.deepStrictEqual(
		at(plan.pushDowns, 0).items.map((i) => i.id),
		["t1-0", "t1-1", "t1-2"],
	);
	assert.ok(!("nodeId" in at(plan.pushDowns, 0)), "no default victim");
	assert.strictEqual(plan.extend, null);
});

/**
 * The bottom tier has no tier below it to push down into, so it grows. The threshold is exact:
 * 2^k is fine, 2^k + 1 needs a new tier. The user picks which items move into it.
 */
test("planRebalance extends the ladder only when the bottom tier passes 2^k exactly", () =>
{
	const atCap = planRebalance(
		readLadder(
			{
				id: "a",
				children: [fill(1, 1), fill(2, 4)],
			},
		),
	);
	assert.strictEqual(atCap.extend, null);
	assert.deepStrictEqual(atCap.pushDowns, []);

	const over = planRebalance(
		readLadder(
			{
				id: "a",
				children: [fill(1, 1), fill(2, 5)],
			},
		),
	);
	assert.deepStrictEqual(over.pushDowns, []);
	assert.ok(over.extend);
	assert.deepStrictEqual(
		[
			over.extend.tier,
			over.extend.label,
			over.extend.id,
			over.extend.count,
			over.extend.capacity,
			over.extend.newTier,
			over.extend.newLabel,
			over.extend.minimumToMove,
			over.extend.items.length,
		],
		[2, "2nd", "tier-2", 5, 4, 3, "3rd", 1, 5],
	);
});

test("planRebalance pulls up into an empty 2nd from the tier below it", () =>
{
	const plan = planRebalance(
		readLadder(
			{
				id: "a",
				children: [fill(1, 1), fill(2, 0), fill(3, 3)],
			},
		),
	);
	assert.deepStrictEqual(
		plan.pullUps.map((p) => [
			p.toTier,
			p.toLabel,
			p.toId,
			p.fromTier,
			p.fromLabel,
			p.fromId,
			p.candidates.map((c) => c.id),
		]),
		[[2, "2nd", "tier-2", 3, "3rd", "tier-3", ["t3-0", "t3-1", "t3-2"]]],
	);
});

test("planRebalance pulls up into every empty tier of a run, all from the first non-empty tier below", () =>
{
	const plan = planRebalance(
		readLadder(
			{
				id: "a",
				children: [fill(1, 0), fill(2, 0), fill(3, 0), fill(4, 2)],
			},
		),
	);
	assert.deepStrictEqual(
		plan.pullUps.map((p) => [p.toTier, p.fromTier, p.candidates.length]),
		[
			[2, 4, 2],
			[3, 4, 2],
		],
	);
});

/** Tier 1 is the special case: two things the user would drop everything else for, or nothing. */
test("planRebalance never pulls up into 1st on its own", () =>
{
	const plan = planRebalance(
		readLadder(
			{
				id: "a",
				children: [fill(1, 0), fill(2, 3), fill(3, 1)],
			},
		),
	);
	assert.deepStrictEqual(plan.pullUps, []);
});

test("planRebalance proposes no pull-up when nothing below the empty tiers can be pulled", () =>
{
	const plan = planRebalance(
		readLadder(
			{
				id: "a",
				children: [fill(1, 1), fill(2, 0), fill(3, 0)],
			},
		),
	);
	assert.deepStrictEqual(plan.pullUps, []);
});

test("planRebalance treats a missing tier as empty with no id, so the walk knows to create it", () =>
{
	const plan = planRebalance(
		readLadder(
			{
				id: "a",
				children: [fill(1, 1), fill(3, 2)],
			},
		),
	);
	assert.deepStrictEqual(
		plan.pullUps.map((p) => [p.toTier, p.toId, p.fromTier]),
		[[2, null, 3]],
	);
	assert.deepStrictEqual(
		plan.dayPlan.map((t) => [t.tier, t.id, t.items.length]),
		[
			[1, "tier-1", 1],
			[2, null, 0],
		],
	);
});

test("planRebalance on a bucket with no ladder proposes nothing", () =>
{
	assert.deepStrictEqual(
		planRebalance(
			readLadder(
				{
					id: "a",
					children: [],
				},
			),
		),
		{
			dayPlan: [],
			pushDowns: [],
			pullUps: [],
			extend: null,
		},
	);
});

/**
 * The inbox walk files every refined item on the bottom tier, but the user often promotes one a
 * tier. filingChoices gives the walk the bottom tier (Accept), the tier directly above it as a
 * one-click Promote option, and a one-line ladder summary for the question text.
 */
test("filingChoices offers the tier directly above the bottom as the promotion, even when it is full", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 3), fill(3, 8), fill(4, 12)],
		},
	);
	assert.deepStrictEqual(
		filingChoices(ladder),
		{
			summary: "1st 2/2 · 2nd 3/4 · 3rd 8/8 · 4th 12 (bottom)",
			bottom:
			{
				tier: 4,
				label: "4th",
				id: "tier-4",
			},
			promote:
			{
				tier: 3,
				label: "3rd",
				id: "tier-3",
			},
		},
	);
});

test("filingChoices has no promotion on a one-tier ladder and nothing on a bucket with no ladder", () =>
{
	assert.deepStrictEqual(
		filingChoices(
			readLadder(
				{
					id: "a",
					children: [fill(1, 1)],
				},
			),
		),
		{
			summary: "1st 1 (bottom)",
			bottom:
			{
				tier: 1,
				label: "1st",
				id: "tier-1",
			},
			promote: null,
		},
	);
	assert.deepStrictEqual(
		filingChoices(
			readLadder(
				{
					id: "a",
					children: [],
				},
			),
		),
		{
			summary: "",
			bottom: null,
			promote: null,
		},
	);
});

/**
 * Grouping pulls related tasks under one parent. A new group lands in the highest tier any member
 * came from, and its children keep the rank they had: ordered by former tier, ladder order within a
 * tier, off-ladder members last.
 */
test("planGroup orders members by former tier and keeps ladder order within a tier", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 1), fill(2, 3), fill(3, 2)],
		},
	);
	assert.deepStrictEqual(
		planGroup(ladder, ["t3-1", "off-ladder", "t2-2", "t1-0", "t2-0"]),
		{
			members: [
				{
					nodeId: "t1-0",
					name: "task t1-0",
					fromTier: 1,
				},
				{
					nodeId: "t2-0",
					name: "task t2-0",
					fromTier: 2,
				},
				{
					nodeId: "t2-2",
					name: "task t2-2",
					fromTier: 2,
				},
				{
					nodeId: "t3-1",
					name: "task t3-1",
					fromTier: 3,
				},
				{
					nodeId: "off-ladder",
					name: null,
					fromTier: null,
				},
			],
			insertion:
			{
				targetTier: 1,
				targetId: "tier-1",
				createTiers: [],
			},
		},
	);
});

test("planGroup files a new group in the highest tier its members came from", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 4), fill(3, 8), fill(4, 3), fill(5, 20)],
		},
	);
	assert.deepStrictEqual(
		planGroup(ladder, ["t5-7", "t3-2"]),
		{
			members: [
				{
					nodeId: "t3-2",
					name: "task t3-2",
					fromTier: 3,
				},
				{
					nodeId: "t5-7",
					name: "task t5-7",
					fromTier: 5,
				},
			],
			insertion:
			{
				targetTier: 3,
				targetId: "tier-3",
				createTiers: [],
			},
		},
	);
});

test("planGroup files in an explicitly chosen tier instead of the default", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 1), fill(2, 3), fill(3, 5)],
		},
	);
	assert.deepStrictEqual(
		planGroup(ladder, ["t3-0", "t3-4"], 2).insertion,
		{
			targetTier: 2,
			targetId: "tier-2",
			createTiers: [],
		},
	);
});

/**
 * Members leave their tiers before the group lands, so a member sitting in a full tier frees the
 * slot the group takes.
 */
test("planGroup plans the insertion after the members have left their tiers", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 4), fill(3, 1)],
		},
	);
	assert.deepStrictEqual(
		planGroup(ladder, ["t1-0", "t3-0"]).insertion,
		{
			targetTier: 1,
			targetId: "tier-1",
			createTiers: [],
		},
	);
});

test("planGroup into a full tier moves nothing else", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 4), fill(3, 5)],
		},
	);
	assert.deepStrictEqual(
		planGroup(ladder, ["t3-0", "t3-4"], 1).insertion,
		{
			targetTier: 1,
			targetId: "tier-1",
			createTiers: [],
		},
	);
});

test("planGroup files in the members' highest tier when it is full without moving anything else", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 5), fill(3, 7), fill(4, 1)],
		},
	);
	assert.deepStrictEqual(
		planGroup(ladder, ["t2-4", "t4-0"]).insertion,
		{
			targetTier: 2,
			targetId: "tier-2",
			createTiers: [],
		},
	);
});

/**
 * Rescuing an off-ladder project moves the whole project node, open tasks and all, onto the ladder.
 * It lands on the bottom tier by default: the project was out of sight, so nothing says it outranks
 * anything already filed.
 */
test("planRescue files a project on the bottom tier by default", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 4), fill(3, 11)],
		},
	);
	assert.deepStrictEqual(
		planRescue(ladder),
		{
			targetTier: 3,
			targetId: "tier-3",
			createTiers: [],
		},
	);
});

test("planRescue files in an explicitly chosen full tier without moving anything else", () =>
{
	const ladder = readLadder(
		{
			id: "a",
			children: [fill(1, 2), fill(2, 4), fill(3, 3)],
		},
	);
	assert.deepStrictEqual(
		planRescue(ladder, 2),
		{
			targetTier: 2,
			targetId: "tier-2",
			createTiers: [],
		},
	);
});

test("planRescue creates 1st on a bucket with no ladder yet", () =>
{
	assert.deepStrictEqual(
		planRescue(
			readLadder(
				{
					id: "a",
					children: [],
				},
			),
		),
		{
			targetTier: 1,
			targetId: null,
			createTiers: [
				{
					tier: 1,
					label: "1st",
				},
			],
		},
	);
});

test("matchLadderHomes finds on-ladder nodes sharing tags, people, or key nouns", () =>
{
	const ladder = readLadder(
		{
			id: "bucket",
			children: [
				{
					name: "1st",
					id: "tier-1",
					children: [
						{
							id: "a",
							name: "Factorio bullets #games",
							children: [],
						},
						{
							id: "b",
							name: "Renew passport",
						},
					],
				},
				{
					name: "2nd",
					id: "tier-2",
					children: [
						{
							id: "c",
							name: "<b>BCA</b> application stuff",
						},
						{
							id: "d",
							name: "Agenda for @Alice #agenda",
						},
						{
							id: "e",
							name: "Done thing about factorio",
							completedAt: "2026-01-01",
						},
					],
				},
			],
		},
	);
	assert.deepStrictEqual(matchLadderHomes(ladder, "Try the new factorio mod #games"), [
		{
			id: "a",
			name: "Factorio bullets #games",
			tier: 1,
			label: "1st",
			shared: ["#games", "factorio"],
		},
	]);
	assert.deepStrictEqual(matchLadderHomes(ladder, "Submit BCA application form"), [
		{
			id: "c",
			name: "<b>BCA</b> application stuff",
			tier: 2,
			label: "2nd",
			shared: ["application"],
		},
	]);
	assert.deepStrictEqual(
		matchLadderHomes(ladder, "Ask @alice about the thing #agenda").map((m) => m.id),
		["d"],
	);
	assert.deepStrictEqual(matchLadderHomes(ladder, "Buy milk"), []);
});
