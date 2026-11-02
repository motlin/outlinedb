import {describe, expect, it} from "vite-plus/test";
import {centeredScrollTop} from "../src/client/scroll-reveal.js";
import {focusCenters, focusCenterNext} from "../src/client/quiet-focus.js";

const view =
{
	rowHeight: 28,
	viewportHeight: 714,
	maxScroll: 517,
};

describe("centeredScrollTop", () =>
{
	it("centers a row below the fold", () =>
	{
		expect(
			centeredScrollTop(
				{
					...view,
					rowTop: 555,
					scrollY: 0,
				},
			),
		).toBe(212);
	});

	it("clamps to the top", () =>
	{
		expect(
			centeredScrollTop(
				{
					...view,
					rowTop: 144,
					scrollY: 0,
				},
			),
		).toBe(0);
	});

	it("centers relative to the current scroll", () =>
	{
		expect(
			centeredScrollTop(
				{
					...view,
					rowTop: 300,
					scrollY: 400,
				},
			),
		).toBe(357);
	});

	it("clamps to the bottom", () =>
	{
		expect(
			centeredScrollTop(
				{
					...view,
					rowTop: 680,
					scrollY: 500,
				},
			),
		).toBe(517);
	});
});

describe("focusCenterNext", () =>
{
	it("centers only the named row, once", () =>
	{
		focusCenterNext("a");
		expect([focusCenters("b"), focusCenters("a"), focusCenters("a")]).toStrictEqual([false, true, false]);
	});
});
