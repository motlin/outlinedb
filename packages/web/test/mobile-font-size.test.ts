// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	DEFAULT_FONT_SIZE,
	FONT_SIZE_STORAGE_KEY,
	clampFontSize,
	getFontSize,
	mobileRowMetrics,
	resetFontSizeForTests,
	setFontSize,
	stepFontSize,
	subscribeFontSize,
} from "../src/client/mobile-font-size.js";

beforeEach(() =>
{
	localStorage.clear();
	resetFontSizeForTests();
});

afterEach(() =>
{
	vi.restoreAllMocks();
});

describe("font size setting", () =>
{
	it("defaults to 19 and clamps steps to 12..28", () =>
	{
		expect(
			{
				initial: getFontSize(),
				up: stepFontSize(19, 1),
				down: stepFontSize(19, -1),
				floor: stepFontSize(12, -1),
				ceiling: stepFontSize(28, 1),
				clampLow: clampFontSize(3),
				clampHigh: clampFontSize(99),
				defaultConst: DEFAULT_FONT_SIZE,
			},
		).toStrictEqual(
			{
				initial: 19,
				up: 20,
				down: 18,
				floor: 12,
				ceiling: 28,
				clampLow: 12,
				clampHigh: 28,
				defaultConst: 19,
			},
		);
	});

	it("persists per browser in localStorage and tells subscribers", () =>
	{
		const seen: number[] = [];
		const unsubscribe = subscribeFontSize(() =>
		{
			seen.push(getFontSize());
		});
		setFontSize(22);
		unsubscribe();
		setFontSize(23);
		expect(
			{
				stored: localStorage.getItem(FONT_SIZE_STORAGE_KEY),
				seen,
				current: getFontSize(),
			},
		).toStrictEqual(
			{
				stored: "23",
				seen: [22],
				current: 23,
			},
		);
	});

	it("reads a stored size on first use and ignores junk", () =>
	{
		localStorage.setItem(FONT_SIZE_STORAGE_KEY, "24");
		resetFontSizeForTests();
		const stored = getFontSize();
		localStorage.setItem(FONT_SIZE_STORAGE_KEY, "huge");
		resetFontSizeForTests();
		expect(
			{
				stored,
				junk: getFontSize(),
			},
		).toStrictEqual(
			{
				stored: 24,
				junk: 19,
			},
		);
	});

	it("still works when storage throws", () =>
	{
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() =>
		{
			throw new Error("blocked");
		});
		setFontSize(21);
		expect(getFontSize()).toBe(21);
	});
});

describe("mobileRowMetrics", () =>
{
	it("matches upstream's measured row at the default size", () =>
	{
		expect(mobileRowMetrics(19)).toStrictEqual(
			{
				namePaddingLeft: 30,
				bulletSize: 26,
				bulletLeft: -2,
			},
		);
	});

	it("scales with the font size", () =>
	{
		expect(mobileRowMetrics(28)).toStrictEqual(
			{
				namePaddingLeft: 48 / 1.3,
				bulletSize: 39,
				bulletLeft: -8,
			},
		);
	});
});
