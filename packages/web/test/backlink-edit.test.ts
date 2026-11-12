import {describe, expect, it} from "vite-plus/test";
import {backlinkEditFallback} from "../src/client/backlink-edit.js";

describe("backlinkEditFallback", () =>
{
	it("puts the caret at the end of the previous row", () =>
	{
		expect(backlinkEditFallback(["T", "R", "B1", "B2"], "B2")).toStrictEqual(
			{
				id: "B1",
				offset: "end",
			},
		);
	});

	it("falls back to the references row for the first backlink row", () =>
	{
		expect(backlinkEditFallback(["T", "R", "B1"], "B1")).toStrictEqual(
			{
				id: "R",
				offset: "end",
			},
		);
	});

	it("takes the start of the next row when the row was first", () =>
	{
		expect(backlinkEditFallback(["B1", "X"], "B1")).toStrictEqual(
			{
				id: "X",
				offset: 0,
			},
		);
	});

	it("goes Home when the backlink item was zoomed", () =>
	{
		expect(backlinkEditFallback(["B1", "X"], "B1", "B1")).toStrictEqual(
			{
				home: true,
			},
		);
	});
});
