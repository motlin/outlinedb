import {describe, expect, it} from "vite-plus/test";
import {initialBreakpoint, resizedBreakpoint} from "../src/client/hooks/use-breakpoint.js";

describe("useBreakpoint helpers", () =>
{
	it("subtracts a 15px scrollbar allowance from innerWidth at load", () =>
	{
		expect(
			{
				a: initialBreakpoint(
					{
						innerWidth: 1010,
					},
					1000,
				),
				b: initialBreakpoint(
					{
						innerWidth: 1015,
					},
					1000,
				),
				c: initialBreakpoint(
					{
						innerWidth: 715,
					},
					701,
				),
				d: initialBreakpoint(
					{
						innerWidth: 716,
					},
					701,
				),
			},
		).toStrictEqual(
			{
				a: false,
				b: true,
				c: false,
				d: true,
			},
		);
	});

	it("compares body.clientWidth after a resize", () =>
	{
		expect(
			{
				a: resizedBreakpoint(
					{
						clientWidth: 1003,
					},
					1000,
				),
				b: resizedBreakpoint(
					{
						clientWidth: 998,
					},
					1000,
				),
			},
		).toStrictEqual(
			{
				a: true,
				b: false,
			},
		);
	});
});
