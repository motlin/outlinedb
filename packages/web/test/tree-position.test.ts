import {describe, expect, it} from "vite-plus/test";
import {sortByPriority} from "../src/client/tree-position.js";

describe("sortByPriority", () =>
{
	it("sorts ascending without mutating the input", () =>
	{
		const input = [
			{
				id: "c",
				priority: 200,
			},
			{
				id: "a",
				priority: 0,
			},
			{
				id: "b",
				priority: 100,
			},
		];
		const sorted = sortByPriority(input);
		expect(sorted.map((s) => s.id)).toStrictEqual(["a", "b", "c"]);
		expect(input[0].id).toBe("c"); // original untouched
	});
});
