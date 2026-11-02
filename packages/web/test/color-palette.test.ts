import {describe, expect, it} from "vite-plus/test";
import {COLOR_ORDER, COLOR_VALUE, colorFromCss} from "../src/color-palette.js";

describe("colorFromCss", () =>
{
	it("maps exact palette shades from rgb() and hex, case-insensitively", () =>
	{
		expect([
			colorFromCss("rgb(224, 36, 36)"),
			colorFromCss("#fce96a"),
			colorFromCss("#F98080"),
			colorFromCss("rgb(1,2,3)"),
			colorFromCss("#E02425"),
			colorFromCss("red"),
		]).toStrictEqual(["red", "yellow", "red", undefined, undefined, undefined]);
	});
});

describe("COLOR_VALUE", () =>
{
	it("holds upstream's numeric values and display order", () =>
	{
		expect(
			{
				values: COLOR_ORDER.map((color) => COLOR_VALUE[color]),
			},
		).toStrictEqual(
			{
				values: [0, 1, 2, 3, 7, 8, 4, 5, 9, 6],
			},
		);
	});
});
