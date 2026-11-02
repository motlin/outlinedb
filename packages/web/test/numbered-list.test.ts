import {describe, expect, it} from "vite-plus/test";
import {renderedNumbers, siblingNumber} from "../src/client/numbered-list.js";

const n = (id: string, numberedStart?: number) => (
{
	id,
	layoutMode: "numbered",
	numberedStart,
});
const bullet = (id: string) => (
{
	id,
	layoutMode: null,
});

describe("renderedNumbers", () =>
{
	it("counts a run of numbered rows and restarts after a non-numbered row", () =>
	{
		expect(renderedNumbers([n("a"), n("b"), bullet("c"), n("d"), n("e")])).toStrictEqual(
			new Map([
				["a", 1],
				["b", 2],
				["d", 1],
				["e", 2],
			]),
		);
	});

	it("starts a run at the first row's numberedStart", () =>
	{
		expect(renderedNumbers([n("a", 5), n("b"), n("c")])).toStrictEqual(
			new Map([
				["a", 5],
				["b", 6],
				["c", 7],
			]),
		);
	});

	it("ignores a mid-run numberedStart in the outline", () =>
	{
		expect(renderedNumbers([n("a"), n("b", 5), n("c")])).toStrictEqual(
			new Map([
				["a", 1],
				["b", 2],
				["c", 3],
			]),
		);
	});

	it("keeps counting across a completed row the caller filtered out", () =>
	{
		const rows = [n("a"), n("x"), n("b")].filter((row) => row.id !== "x");
		expect(renderedNumbers(rows).get("b")).toBe(2);
	});
});

describe("siblingNumber", () =>
{
	it("walks back over numbered siblings and stops at a sibling with a start", () =>
	{
		const siblings = [n("a"), n("b", 4), n("c")];
		expect([
			siblingNumber(siblings, "a"),
			siblingNumber(siblings, "b"),
			siblingNumber(siblings, "c"),
		]).toStrictEqual([1, 4, 5]);
	});

	it("uses the true sibling position where the outline ignores a mid-run start", () =>
	{
		const siblings = [n("a"), n("b", 5), n("c")];
		expect([siblingNumber(siblings, "b"), siblingNumber(siblings, "c")]).toStrictEqual([5, 6]);
	});

	it("gives a non-numbered or unknown row 0", () =>
	{
		expect([siblingNumber([bullet("a")], "a"), siblingNumber([], "zz")]).toStrictEqual([0, 0]);
	});

	it("breaks the walk at a non-numbered sibling", () =>
	{
		expect(siblingNumber([n("a"), bullet("b"), n("c")], "c")).toBe(1);
	});
});
