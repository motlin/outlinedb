import {describe, expect, it} from "vite-plus/test";
import {tierCapacity, toLadder, planTierMove} from "../src/server/ladder-model.js";
import type {RawNode} from "../src/server/ladder-model.js";

const node = (id: string, name: string, children: RawNode[] = []): RawNode => (
{
	id,
	name,
	children,
	completedAt: null,
});

describe("tierCapacity", () =>
{
	it("doubles with each tier, so 1st holds 2 and 6th holds 64", () =>
	{
		expect([1, 2, 3, 4, 5, 6].map(tierCapacity)).toStrictEqual([2, 4, 8, 16, 32, 64]);
	});
});

describe("toLadder", () =>
{
	const bucket =
	{
		id: "bucket",
		name: "📌 Tasks (asap) (work)",
		children: [
			node("t1", "1st", [node("a", "Task A"), node("b", "Task B")]),
			node("t2", "2nd", []),
			node("t3", "3rd", [node("c", "Task C")]),
		],
	};

	it("reads tiers in order with their capacities", () =>
	{
		const ladder = toLadder("work", bucket);
		expect(ladder.tiers.map((t) => [t.label, t.capacity, t.items.length])).toStrictEqual([
			["1st", 2, 2],
			["2nd", 4, 0],
			["3rd", 8, 1],
		]);
	});

	it("keeps an empty tier, because pulling an item up into one is the main repair", () =>
	{
		const ladder = toLadder("work", bucket);
		expect(ladder.tiers.find((t) => t.label === "2nd")?.items).toStrictEqual([]);
	});

	it("marks each tier over, exact or room so the client does not recompute it", () =>
	{
		const ladder = toLadder("work", bucket);
		expect(ladder.tiers.map((t) => t.state)).toStrictEqual(["exact", "room", "room"]);
	});

	it("drops completed tasks rather than showing work already done", () =>
	{
		const withDone =
		{
			...bucket,
			children: [
				{
					id: "t1",
					name: "1st",
					completedAt: null,
					children: [
						node("a", "Task A"),
						{
							id: "z",
							name: "Done",
							children: [],
							completedAt: "2026-09-01",
						},
					],
				},
			],
		};
		expect(toLadder("work", withDone).tiers[0].items.map((i) => i.id)).toStrictEqual(["a"]);
	});
});

describe("planTierMove", () =>
{
	const ladder = toLadder(
		"work",
		{
			id: "bucket",
			name: "📌",
			children: [node("t1", "1st", [node("a", "A")]), node("t2", "2nd", [node("b", "B")])],
		},
	);

	it("resolves a tier label to the parent id the move endpoint needs", () =>
	{
		expect(planTierMove(ladder, "a", "2nd")).toStrictEqual(
			{
				nodeId: "a",
				parentId: "t2",
				fromTier: "1st",
				toTier: "2nd",
			},
		);
	});

	it("refuses a tier that does not exist rather than guessing", () =>
	{
		expect(() => planTierMove(ladder, "a", "9th")).toThrow(/9th/u);
	});

	it("refuses a node that is not on this ladder", () =>
	{
		expect(() => planTierMove(ladder, "nope", "2nd")).toThrow(/nope/u);
	});
});

describe("toLadder subtrees", () =>
{
	const bucket: RawNode =
	{
		id: "bucket",
		name: "📌",
		children: [
			node("t1", "1st", [
				node("a", "Apply to magnet schools", [
					node("a1", "Request transcripts", [node("a1a", "Email the registrar")]),
					{
						id: "a2",
						name: "Old step",
						completedAt: "2026-09-01",
						children: [],
					},
					node("a3", "Book the tour"),
				]),
				node("b", "Plain row"),
			]),
		],
	};

	it("carries each row subtree, so the page can show it without another request", () =>
	{
		const [tier] = toLadder("work", bucket).tiers;
		const [withKids] = tier.items;
		expect(withKids.children.map((child) => child.name)).toStrictEqual(["Request transcripts", "Book the tour"]);
		expect(withKids.children[0].children.map((child) => child.name)).toStrictEqual(["Email the registrar"]);
	});

	it("leaves completed children out, the same as completed rows", () =>
	{
		const [tier] = toLadder("work", bucket).tiers;
		expect(tier.items[0].children.some((child) => child.name === "Old step")).toBe(false);
	});

	it("gives a childless row an empty list rather than undefined", () =>
	{
		const [tier] = toLadder("work", bucket).tiers;
		expect(tier.items[1].children).toStrictEqual([]);
	});

	it("counts the whole subtree, so a row can say how much is hidden under it", () =>
	{
		const [tier] = toLadder("work", bucket).tiers;
		expect(tier.items[0].descendantCount).toBe(3);
		expect(tier.items[1].descendantCount).toBe(0);
	});
});

it("keeps the tree affordance when a task has only completed descendants", () =>
{
	const ladder = toLadder(
		"personal",
		node("bucket", "Tasks", [
			node("tier", "1st", [
				node("alice", "Alice", [
					{
						id: "bob",
						name: "Bob",
						completedAt: "2000-01-01",
						children: [],
					},
				]),
			]),
		]),
	);
	expect(ladder.tiers[0].items).toStrictEqual([
		{
			id: "alice",
			name: "Alice",
			children: [],
			hasChildren: true,
			descendantCount: 0,
		},
	]);
});
