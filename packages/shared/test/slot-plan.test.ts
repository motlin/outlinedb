import {describe, expect, it} from "vite-plus/test";

import {planBlockSlot, planSlot} from "../src/cache/slot-plan.js";

describe("planSlot", () =>
{
	it("rotates the shorter side: a slot near the top moves the siblings above it to the top", () =>
	{
		expect(planSlot(["a", "b", "c", "d"], "new", 1)).toStrictEqual(
			{
				position: "top",
				siblingIds: ["a"],
			},
		);
	});

	it("rotates the siblings below a slot near the bottom to the bottom", () =>
	{
		expect(planSlot(["a", "b", "c", "d"], "new", 3)).toStrictEqual(
			{
				position: "bottom",
				siblingIds: ["d"],
			},
		);
	});

	it("is a no-op when the node already sits at the slot", () =>
	{
		expect(planSlot(["a", "b", "c"], "b", 1)).toBeNull();
	});

	it("clamps a slot past the end to the bottom", () =>
	{
		expect(planSlot(["a", "b", "c"], "a", 9)).toStrictEqual(
			{
				position: "bottom",
				siblingIds: [],
			},
		);
	});

	it("moves the siblings above to the top in reverse so they keep their order", () =>
	{
		expect(planSlot(["a", "b", "c", "d", "e"], "new", 2)).toStrictEqual(
			{
				position: "top",
				siblingIds: ["b", "a"],
			},
		);
	});
});

describe("planBlockSlot", () =>
{
	it("plans a block as the other siblings around one insertion point", () =>
	{
		expect(planBlockSlot(["a", "b", "c", "d"], ["a", "b"], 1)).toStrictEqual(
			{
				position: "top",
				siblingIds: ["c"],
			},
		);
	});
});
