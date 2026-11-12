import {describe, expect, it} from "vite-plus/test";
import {planSwapOrigin, swapMoveOps} from "../src/swap-origin.js";

describe("planSwapOrigin", () =>
{
	it("moves the mirror next to the original, then the original into the mirror's old slot, across parents", () =>
	{
		const plan = planSwapOrigin(
			new Map([
				["P1", ["M"]],
				["P2", ["x", "O"]],
			]),
			{
				id: "M",
				parentId: "P1",
			},
			{
				id: "O",
				parentId: "P2",
			},
		);

		expect(plan).toStrictEqual([
			{
				id: "M",
				parentId: "P2",
				index: 1,
			},
			{
				id: "O",
				parentId: "P1",
				index: 0,
			},
		]);
	});

	it("lets the two exchange slots inside one parent, whichever comes first", () =>
	{
		const orders = new Map([["P", ["O", "a", "M"]]]);
		const after = new Map([["P", ["M", "a", "O"]]]);
		const forward = planSwapOrigin(
			orders,
			{
				id: "M",
				parentId: "P",
			},
			{
				id: "O",
				parentId: "P",
			},
		);
		const backward = planSwapOrigin(
			after,
			{
				id: "O",
				parentId: "P",
			},
			{
				id: "M",
				parentId: "P",
			},
		);

		expect(
			{
				forward,
				backward,
			},
		).toStrictEqual(
			{
				forward: [
					{
						id: "M",
						parentId: "P",
						index: 0,
					},
					{
						id: "O",
						parentId: "P",
						index: 3,
					},
				],
				backward: [
					{
						id: "O",
						parentId: "P",
						index: 0,
					},
					{
						id: "M",
						parentId: "P",
						index: 3,
					},
				],
			},
		);
	});

	it("applies to the same final order when run through the moves", () =>
	{
		const apply = (list: string[], id: string, slot: number): string[] =>
		{
			const from = list.indexOf(id);
			const rest = list.filter((entry) => entry !== id);
			return [...rest.slice(0, slot - (from < slot ? 1 : 0)), id, ...rest.slice(slot - (from < slot ? 1 : 0))];
		};
		const plan = planSwapOrigin(
			new Map([["P", ["a", "O", "b", "M", "c"]]]),
			{
				id: "M",
				parentId: "P",
			},
			{
				id: "O",
				parentId: "P",
			},
		);

		const final = plan.reduce((list, step) => apply(list, step.id, step.index), ["a", "O", "b", "M", "c"]);

		expect(final).toStrictEqual(["a", "M", "b", "O", "c"]);
	});
});

describe("swapMoveOps", () =>
{
	it("records each move with the slot that puts the mover back", () =>
	{
		const across = swapMoveOps(
			new Map([
				["P1", ["M"]],
				["P2", ["x", "O"]],
			]),
			{
				id: "M",
				parentId: "P1",
			},
			{
				id: "O",
				parentId: "P2",
			},
		);
		const within = swapMoveOps(
			new Map([["P", ["O", "a", "M"]]]),
			{
				id: "M",
				parentId: "P",
			},
			{
				id: "O",
				parentId: "P",
			},
		);

		expect(
			{
				across,
				within,
			},
		).toStrictEqual(
			{
				across: [
					{
						kind: "move",
						nodeId: "M",
						from:
						{
							parentId: "P1",
							index: 0,
						},
						to:
						{
							parentId: "P2",
							index: 1,
						},
					},
					{
						kind: "move",
						nodeId: "O",
						from:
						{
							parentId: "P2",
							index: 2,
						},
						to:
						{
							parentId: "P1",
							index: 0,
						},
					},
				],
				within: [
					{
						kind: "move",
						nodeId: "M",
						from:
						{
							parentId: "P",
							index: 3,
						},
						to:
						{
							parentId: "P",
							index: 0,
						},
					},
					{
						kind: "move",
						nodeId: "O",
						from:
						{
							parentId: "P",
							index: 1,
						},
						to:
						{
							parentId: "P",
							index: 3,
						},
					},
				],
			},
		);
	});
});
