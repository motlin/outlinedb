import {describe, expect, it} from "vite-plus/test";
import {focusKeepsScroll} from "../src/client/quiet-focus.js";

describe("focusKeepsScroll", () =>
{
	it.each([
		[
			{
				top: 707,
				bottom: 735,
			},
			true,
		],
		[
			{
				top: -10,
				bottom: 5,
			},
			true,
		],
		[
			{
				top: 735,
				bottom: 763,
			},
			false,
		],
		[
			{
				top: -40,
				bottom: 0,
			},
			false,
		],
	])("rect %j at viewport height 714 -> %s", (rect, expected) =>
	{
		expect(focusKeepsScroll(rect, 714)).toBe(expected);
	});
});
