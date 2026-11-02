import {describe, expect, it} from "vite-plus/test";
import
{
	DEFAULT_PANE_WIDTH,
	MIN_PANE_WIDTH,
	PANE_GUTTER,
	availablePaneWidth,
	beginDividerResize,
	cancelledDivider,
	minimumPaneWidth,
	paneWidth,
	resizedDivider,
	resolveWidths,
} from "../src/client/pane-widths.js";

describe("pane width constants", () =>
{
	it("uses upstream's 350px pane minimum, 8px gutter and 380px fallback width", () =>
	{
		expect(
			{
				min: MIN_PANE_WIDTH,
				gutter: PANE_GUTTER,
				fallback: DEFAULT_PANE_WIDTH,
			},
		).toStrictEqual(
			{
				min: 350,
				gutter: 8,
				fallback: 380,
			},
		);
	});
});

describe("availablePaneWidth", () =>
{
	it("is the measured workspace width when there is one", () =>
	{
		expect(availablePaneWidth(1416, 1680, 264)).toBe(1416);
	});

	it("falls back to the window beside the left bar and the gutter, never negative", () =>
	{
		expect([availablePaneWidth(null, 1680, 256), availablePaneWidth(null, 100, 256)]).toStrictEqual([1416, 0]);
	});
});

describe("paneWidth", () =>
{
	it("floors finite widths at the minimum and falls back to 380 for anything else, like upstream's normalize", () =>
	{
		expect([paneWidth(500), paneWidth(100), paneWidth(Number.NaN), paneWidth(undefined)]).toStrictEqual([
			500, 350, 380, 380,
		]);
	});
});

describe("minimumPaneWidth", () =>
{
	it("is 350 for every pane but the last, which must leave the workspace filled", () =>
	{
		expect([
			minimumPaneWidth([716, 716], 0, 1416),
			minimumPaneWidth([716, 716], 1, 1416),
			minimumPaneWidth([638, 0], 1, 1360),
			minimumPaneWidth([1500, 1500], 1, 1416),
		]).toStrictEqual([350, 700, 722, 350]);
	});
});

describe("resolveWidths", () =>
{
	it("gives a new pane an equal share of the workspace and keeps the others while they fill it", () =>
	{
		expect(resolveWidths([716, 716, 0], [2], 1416, false)).toStrictEqual([716, 716, 472]);
	});

	it("leaves the widths alone when the panes already overfill and the workspace is not being refit", () =>
	{
		expect(resolveWidths([350, 1010], [], 1360, false)).toStrictEqual([350, 1010]);
	});

	it("scales panes up in proportion when they no longer fill the workspace, like closing a pane", () =>
	{
		expect(resolveWidths([716, 472], [], 1416, false)).toStrictEqual([853.4141414141413, 562.5858585858585]);
	});

	it("rescales panes that overfill when asked to fit the workspace", () =>
	{
		expect(resolveWidths([800, 800], [], 1000, true)).toStrictEqual([500, 500]);
	});

	it("splits the workspace equally among all-new panes", () =>
	{
		expect(resolveWidths([0, 0, 0], [0, 1, 2], 1200, false)).toStrictEqual([400, 400, 400]);
	});

	it("never takes a pane under the minimum", () =>
	{
		expect(resolveWidths([0, 0, 0], [0, 1, 2], 600, false)).toStrictEqual([350, 350, 350]);
	});

	it("returns nothing for no panes", () =>
	{
		expect(resolveWidths([], [], 1000, false)).toStrictEqual([]);
	});
});

describe("divider resize", () =>
{
	const available = 1416;

	it("begins on a pane with its right neighbour's width, and refuses an unknown pane", () =>
	{
		expect([
			beginDividerResize([716, 716], 0),
			beginDividerResize([716, 716], 1),
			beginDividerResize([716, 716], 2),
		]).toStrictEqual([
			{
				index: 0,
				width: 716,
				rightWidth: 716,
			},
			{
				index: 1,
				width: 716,
				rightWidth: null,
			},
			null,
		]);
	});

	it("shrinks the pane and grows the right neighbour to keep the row filling the workspace", () =>
	{
		const first = resizedDivider(
			[716, 716],
			{
				index: 0,
				width: 716,
				rightWidth: 716,
			},
			-10,
			available,
		);
		const second = resizedDivider(
			first,
			{
				index: 0,
				width: 706,
				rightWidth: 716,
			},
			-50,
			available,
		);
		expect(
			{
				first,
				second,
			},
		).toStrictEqual(
			{
				first: [706, 716],
				second: [656, 760],
			},
		);
	});

	it("grows the pane without shrinking its right neighbour, so the workspace overflows", () =>
	{
		expect(
			resizedDivider(
				[656, 760],
				{
					index: 0,
					width: 656,
					rightWidth: 760,
				},
				50,
				available,
			),
		).toStrictEqual([706, 760]);
	});

	it("stops at the pane's minimum", () =>
	{
		expect(
			resizedDivider(
				[706, 760],
				{
					index: 0,
					width: 706,
					rightWidth: 760,
				},
				350 - 706,
				available,
			),
		).toStrictEqual([350, 1066]);
		expect(
			resizedDivider(
				[350, 1066],
				{
					index: 1,
					width: 1066,
					rightWidth: null,
				},
				-10,
				available,
			),
		).toStrictEqual([350, 1066]);
		expect(
			resizedDivider(
				[350, 1066],
				{
					index: 1,
					width: 1066,
					rightWidth: null,
				},
				50,
				available,
			),
		).toStrictEqual([350, 1116]);
	});

	it("ignores a non-finite delta", () =>
	{
		expect(
			resizedDivider(
				[716, 716],
				{
					index: 0,
					width: 716,
					rightWidth: 716,
				},
				Number.NaN,
				available,
			),
		).toStrictEqual([716, 716]);
	});

	it("restores both start widths when cancelled", () =>
	{
		expect(
			cancelledDivider(
				[350, 1066, 400],
				{
					index: 0,
					width: 716,
					rightWidth: 716,
				},
			),
		).toStrictEqual([716, 716, 400]);
		expect(
			cancelledDivider(
				[350, 1066],
				{
					index: 1,
					width: 900,
					rightWidth: null,
				},
			),
		).toStrictEqual([350, 900]);
	});
});
