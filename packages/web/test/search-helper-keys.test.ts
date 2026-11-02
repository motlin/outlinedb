import {describe, expect, it} from "vite-plus/test";
import {NO_HELPER_SELECTION, chipNeighbor, helperKey} from "../src/client/search/helper-keys.js";
import type {ChipGeometry, HelperLayout, HelperSelection} from "../src/client/search/helper-keys.js";

// The DATES tab's 13 chip wrappers measured on the local app (identical upstream): [label, left, top, width, height].
const WRAPPERS: [string, number, number, number, number][] = [
	["date:", 611, 69.64, 43.98, 28],
	["date-before:", 654.98, 69.64, 88.21, 28],
	["date-after:", 743.19, 69.64, 77.73, 28],
	["day-of-week:", 611, 97.64, 92.8, 28],
	["today", 703.8, 97.64, 47.09, 28],
	["tomorrow", 750.88, 97.64, 70.63, 28],
	["yesterday", 821.52, 97.64, 71.67, 28],
	["this week", 611, 125.64, 69.75, 28],
	["next week", 680.75, 125.64, 73.55, 28],
	["last week", 754.3, 125.64, 69.3, 28],
	["this month", 611, 153.64, 76.73, 28],
	["next month", 687.73, 153.64, 80.52, 28],
	["last month", 768.25, 153.64, 76.27, 28],
];
const TOPS = [4, 4, 4, 32, 32, 32, 32, 60, 60, 60, 88, 88, 88];
const CONTAINER_BOTTOM = 181.64;

const CHIPS: ChipGeometry[] = WRAPPERS.map(([, left, top, width, height], index) =>
{
	const wrapper =
	{
		left,
		top,
		width,
		height,
	};
	return {
		wrapper,
		item:
		{
			left: left + 1,
			top: top + 4,
			width: width - 2,
			height: height - 8,
		},
		offsetTop: TOPS[index] ?? 0,
	};
});

const labelOf = (index: number | null): string => (index === null ? "null" : (WRAPPERS[index]?.[0] ?? "?"));

const UPSTREAM_UP_DOWN: Record<string, [string, string]> =
{
	"date:": ["null", "day-of-week:"],
	"date-before:": ["null", "day-of-week:"],
	"date-after:": ["null", "tomorrow"],
	"day-of-week:": ["date:", "this week"],
	today: ["date-before:", "next week"],
	tomorrow: ["date-after:", "last week"],
	yesterday: ["null", "last week"],
	"this week": ["day-of-week:", "this month"],
	"next week": ["day-of-week:", "next month"],
	"last week": ["tomorrow", "last month"],
	"this month": ["this week", "null"],
	"next month": ["next week", "null"],
	"last month": ["last week", "null"],
};

describe("chipNeighbor", () =>
{
	it("matches upstream's geometric Up and Down for every DATES chip", () =>
	{
		const actual = Object.fromEntries(
			WRAPPERS.map(([label], index) => [
				label,
				[
					labelOf(chipNeighbor(CHIPS, CONTAINER_BOTTOM, index, "up")),
					labelOf(chipNeighbor(CHIPS, CONTAINER_BOTTOM, index, "down")),
				],
			]),
		);

		expect(actual).toStrictEqual(UPSTREAM_UP_DOWN);
	});
});

const layout: HelperLayout =
{
	tabCount: 7,
	hasChips: (tab) => tab > 0,
	chipCount: 13,
	neighbor: (chip, dir) =>
	{
		const label = WRAPPERS[chip]?.[0] ?? "";
		const target = UPSTREAM_UP_DOWN[label]?.[dir === "up" ? 0 : 1];
		const index = WRAPPERS.findIndex(([name]) => name === target);
		return index === -1 ? null : index;
	},
};

function key(sel: HelperSelection, code: string, ctrl = false)
{
	return helperKey(
		sel,
		{
			code,
			ctrl,
		},
		layout,
	);
}

describe("helperKey", () =>
{
	it("arms tab-row mode with ArrowUp, then ArrowRight picks the first tab and ArrowUp disarms", () =>
	{
		const armed = key(NO_HELPER_SELECTION, "ArrowUp");
		const right = key(armed.sel, "ArrowRight");
		const up = key(right.sel, "ArrowUp");

		expect(
			{
				armed,
				right: right.sel,
				up: up.sel,
			},
		).toStrictEqual(
			{
				armed:
				{
					sel:
					{
						tab: -1,
						chip: -1,
						rowMode: true,
					},
					preventDefault: true,
					stopPropagation: false,
					select: null,
				},
				right:
				{
					tab: 0,
					chip: -1,
					rowMode: true,
				},
				up: NO_HELPER_SELECTION,
			},
		);
	});

	it("steps tabs with Ctrl+N and Ctrl+P only from nothing or tab-row mode", () =>
	{
		expect(
			{
				fromNothing: key(NO_HELPER_SELECTION, "KeyN", true),
				backOff: key(
					{
						tab: 0,
						chip: -1,
						rowMode: true,
					},
					"KeyP",
					true,
				).sel,
				hovered: key(
					{
						tab: 3,
						chip: -1,
						rowMode: false,
					},
					"KeyN",
					true,
				),
			},
		).toStrictEqual(
			{
				fromNothing:
				{
					sel:
					{
						tab: 0,
						chip: -1,
						rowMode: false,
					},
					preventDefault: true,
					stopPropagation: false,
					select: null,
				},
				backOff:
				{
					tab: -1,
					chip: -1,
					rowMode: true,
				},
				hovered:
				{
					sel:
					{
						tab: 3,
						chip: -1,
						rowMode: false,
					},
					preventDefault: false,
					stopPropagation: false,
					select: null,
				},
			},
		);
	});

	it("enters the chips from a hovered tab with Left (last chip) and Right (first chip)", () =>
	{
		const hovered: HelperSelection =
		{
			tab: 3,
			chip: -1,
			rowMode: false,
		};

		expect(
			{
				left: key(hovered, "ArrowLeft").sel,
				right: key(hovered, "ArrowRight").sel,
			},
		).toStrictEqual(
			{
				left:
				{
					tab: 3,
					chip: 12,
					rowMode: false,
				},
				right:
				{
					tab: 3,
					chip: 0,
					rowMode: false,
				},
			},
		);
	});

	it("arms tab-row mode with ArrowUp on a hovered tab", () =>
	{
		expect(
			key(
				{
					tab: 3,
					chip: -1,
					rowMode: false,
				},
				"ArrowUp",
			).sel,
		).toStrictEqual(
			{
				tab: 3,
				chip: -1,
				rowMode: true,
			},
		);
	});

	it("swallows Space and Tab on a chip tab, and selects the highlighted chip", () =>
	{
		expect(
			{
				space: key(
					{
						tab: 1,
						chip: -1,
						rowMode: false,
					},
					"Space",
				),
				tab: key(
					{
						tab: 1,
						chip: -1,
						rowMode: false,
					},
					"Tab",
				),
				enter: key(
					{
						tab: 1,
						chip: 2,
						rowMode: false,
					},
					"Enter",
				),
			},
		).toStrictEqual(
			{
				space:
				{
					sel:
					{
						tab: 1,
						chip: -1,
						rowMode: false,
					},
					preventDefault: true,
					stopPropagation: false,
					select: null,
				},
				tab:
				{
					sel:
					{
						tab: 1,
						chip: -1,
						rowMode: false,
					},
					preventDefault: true,
					stopPropagation: true,
					select: null,
				},
				enter:
				{
					sel:
					{
						tab: 1,
						chip: 2,
						rowMode: false,
					},
					preventDefault: true,
					stopPropagation: false,
					select: 2,
				},
			},
		);
	});

	it("leaves the tab row for the chips on ArrowDown", () =>
	{
		expect(
			key(
				{
					tab: 3,
					chip: -1,
					rowMode: true,
				},
				"ArrowDown",
			).sel,
		).toStrictEqual(
			{
				tab: 3,
				chip: 0,
				rowMode: false,
			},
		);
	});

	it("lets ArrowLeft on the first tab move the caret", () =>
	{
		expect(
			key(
				{
					tab: 0,
					chip: -1,
					rowMode: true,
				},
				"ArrowLeft",
			),
		).toStrictEqual(
			{
				sel:
				{
					tab: 0,
					chip: -1,
					rowMode: true,
				},
				preventDefault: false,
				stopPropagation: false,
				select: null,
			},
		);
	});

	it("moves between chips by geometry and returns to the tab row from the first chip row", () =>
	{
		const downFromBefore = key(
			{
				tab: 3,
				chip: 1,
				rowMode: false,
			},
			"ArrowDown",
		).sel;
		const upFromYesterday = key(
			{
				tab: 3,
				chip: 6,
				rowMode: false,
			},
			"ArrowUp",
		);

		expect(
			{
				down: downFromBefore.chip,
				up: upFromYesterday.sel,
				stop: upFromYesterday.stopPropagation,
			},
		).toStrictEqual(
			{
				down: 3,
				up:
				{
					tab: 3,
					chip: -1,
					rowMode: true,
				},
				stop: true,
			},
		);
	});

	it("keeps the tab at -1 while the autocomplete hides the helper flyout, but still arms tab-row mode", () =>
	{
		const hidden =
		{
			...layout,
			hidden: true,
		};

		expect(
			helperKey(
				NO_HELPER_SELECTION,
				{
					code: "ArrowDown",
					ctrl: false,
				},
				hidden,
			).sel,
		).toStrictEqual(
			{
				tab: -1,
				chip: -1,
				rowMode: true,
			},
		);
	});

	it("ignores other keys", () =>
	{
		expect(
			key(
				{
					tab: 2,
					chip: -1,
					rowMode: false,
				},
				"KeyA",
			),
		).toStrictEqual(
			{
				sel:
				{
					tab: 2,
					chip: -1,
					rowMode: false,
				},
				preventDefault: false,
				stopPropagation: false,
				select: null,
			},
		);
	});
});
