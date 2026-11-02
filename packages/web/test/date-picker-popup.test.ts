import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {calendarDayContent, calendarPickerSettingsRows} from "../src/client/components/calendar-picker-settings.js";
import {DatePickerPopup} from "../src/client/components/date-picker-popup.js";
import type {DatePickerPopupProps} from "../src/client/components/date-picker-popup.js";
import {nextCalendarFocus} from "../src/client/components/date-picker-keyboard.js";
import type {CalendarFocusTarget} from "../src/client/components/date-picker-keyboard.js";

function render(props: Partial<DatePickerPopupProps> = {}): string
{
	return renderToStaticMarkup(
		createElement(
			DatePickerPopup,
			{
				selected: [],
				...props,
			},
		),
	);
}

/** Each day button's label and its `.date-picker-day-cell` class tokens. */
function dayCells(html: string):
{
	label: string;
	cell: string[];
}[]
{
	return [
		...html.matchAll(
			/<button[^>]*data-date-picker-day-button="true"[^>]*><div class="(date-picker-day-cell[^"]*)"><div[^>]*><div[^>]*>(\d+)<\/div>/gu,
		),
	].map((m) => (
	{
		label: m[2],
		cell: m[1].split(/\s+/u).filter(Boolean),
	}));
}

function hasTokens(tokens: string[], wanted: string[]): boolean
{
	return wanted.every((token) => tokens.includes(token));
}

function weekdayLabels(html: string): string[]
{
	const row = /<div class="grid grid-cols-7 justify-items-center text-tertiary[^"]*">(.*?)<\/div><\/header>/u.exec(
		html,
	);
	return [...(row?.[1] ?? "").matchAll(/<div class="text-center">([^<]*)<\/div>/gu)].map((m) => m[1]);
}

function headerButtons(html: string): string[]
{
	return [...html.matchAll(/<button data-date-picker-header-button="true"[^>]*>([^<]*)<\/button>/gu)].map(
		(m) => m[1],
	);
}

/** The visible text of each `a.menuItem` row, in order. */
function menuRows(html: string): string[]
{
	return [...html.matchAll(/<a [^>]*class="[^"]*menuItem[^"]*"[^>]*>(.*?)<\/a>/gsu)].map((m) =>
		m[1].replaceAll(/<[^>]*>/gu, ""),
	);
}

describe("DatePickerPopup", () =>
{
	it("does not emit aria-selected on day buttons", () =>
	{
		const html = render(
			{
				selected: [new Date(2026, 9, 20)],
			},
		);
		expect(
			{
				ariaSelected: html.includes("aria-selected"),
				active: [
					...html.matchAll(
						/data-date-picker-active-button="true"[^>]*><div[^>]*><div[^>]*><div[^>]*>(\d+)</gu,
					),
				].map((m) => m[1]),
			},
		).toStrictEqual(
			{
				ariaSelected: false,
				active: ["20"],
			},
		);
	});

	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
			},
		);
		vi.setSystemTime(new Date(2026, 9, 1, 10, 0));
	});
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("headerText puts the section header first in the scroller and showControls=false drops Range and Format", () =>
	{
		const html = render(
			{
				headerText: "Move to Date...",
				showControls: false,
			},
		);
		expect(
			{
				header: /<div class="(py-m px-l[^"]*)"[^>]*>Move to Date\.\.\.<\/div>/u.exec(html)?.[1],
				headerFirst: html.indexOf("Move to Date...") < html.indexOf("Type date"),
				rows: menuRows(html),
				plainHasHeader: render().includes("menu-section-header"),
			},
		).toStrictEqual(
			{
				header: "py-m px-l text-tertiary text-xs uppercase bg-inherit mobile:bg-secondary menu-section-header mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right ",
				headerFirst: true,
				rows: ["Today", "Tomorrow", "Next week"],
				plainHasHeader: false,
			},
		);
	});

	it("renders the static 42-day October 2026 grid with today outlined", () =>
	{
		const html = render();
		const cells = dayCells(html);
		expect(
			{
				count: cells.length,
				first: cells[0]?.label,
				last: cells.at(-1)?.label,
				today: cells.filter((c) => hasTokens(c.cell, ["font-bold", "border-tint"])).map((c) => c.label),
				selected: cells.filter((c) => c.cell.includes("!bg-tint")).map((c) => c.label),
				weekdays: weekdayLabels(html),
				headers: headerButtons(html),
				rows: menuRows(html),
			},
		).toStrictEqual(
			{
				count: 42,
				first: "27",
				last: "7",
				today: ["1"],
				selected: [],
				weekdays: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
				headers: ["Oct", "2026"],
				rows: ["Today", "Tomorrow", "Next week", "Range", "Format"],
			},
		);
	});

	it("copies upstream's shell, input row and today cell markup", () =>
	{
		const html = render();
		expect(
			{
				shell: html.startsWith(
					'<div class="wf-menu flex flex-col\n      border border-solid border-primary font-normal text-xs\n      rounded-md bg-primary shadow-md\n      overflow-x-hidden\n      [transition:200ms_opacity]\n      print:hidden absolute flyout menu [&amp;.menu]:py-0" style="pointer-events:auto;z-index:300;min-width:0;max-width:240px;margin-top:4px">',
				),
				input: html.includes(
					'<div class="flex items-center px-l py-m bg-secondary"><input type="text" autofocus="" placeholder="Type date" class="date-popup-input bg-inherit w-full border-0 text-primary placeholder:text-tertiary" name="date-picker-input" value=""/></div>',
				),
				calendar: html.includes(
					'<div data-keyboard-focus-scope="true" class="flex flex-col w-[220px]"><section>',
				),
				icons: [...html.matchAll(/data-icon="([^"]*)"/gu)]
					.map((m) => m[1])
					.filter((icon, i, all) => all.indexOf(icon) === i),
				activeButtons: [...html.matchAll(/data-date-picker-active-button="true"/gu)].length,
				enterFromAfter: [...html.matchAll(/data-keyboard-focus-enter-from-after="true"/gu)].length,
			},
		).toStrictEqual(
			{
				shell: true,
				input: true,
				calendar: true,
				icons: ["sun-bright", "moon", "calendar-week", "chevron-left", "chevron-right", "circle-small", "gear"],
				activeButtons: 1,
				enterFromAfter: 1,
			},
		);
	});

	it("starts the week on Monday when weekStartDay is 1", () =>
	{
		const html = render(
			{
				weekStartDay: 1,
			},
		);
		const cells = dayCells(html);
		expect(
			{
				weekdays: weekdayLabels(html),
				first: cells[0]?.label,
				last: cells.at(-1)?.label,
			},
		).toStrictEqual(
			{
				weekdays: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
				first: "28",
				last: "8",
			},
		);
	});

	it("fills the selected day with the tint color", () =>
	{
		const html = render(
			{
				selected: [new Date(2026, 9, 15)],
			},
		);
		const selected = dayCells(html).filter((c) => hasTokens(c.cell, ["!text-on-color", "!bg-tint"]));
		expect(selected.map((c) => c.label)).toStrictEqual(["15"]);
	});

	it("drops the event dots and turns the Range toggle on in range mode", () =>
	{
		const html = render(
			{
				isRange: true,
			},
		);
		expect(
			{
				dots: html.includes("circle-small"),
				toggle: /<label class="(toggle \w+)/u.exec(html)?.[1],
				track: html.includes('bg-tint"><div class="w-[10px] h-[10px] rounded-circle bg-white'),
				knob: html.includes("translate-x-[10px] mobile:translate-x-[22px]"),
			},
		).toStrictEqual(
			{
				dots: false,
				toggle: "toggle on",
				track: true,
				knob: true,
			},
		);
	});

	it("shows the Range toggle off in single mode", () =>
	{
		expect(/<label class="(toggle \w+)/u.exec(render())?.[1]).toBe("toggle off");
	});

	it("adds Remove date as the last row when opened from a pill", () =>
	{
		expect(
			menuRows(
				render(
					{
						showNoDate: true,
					},
				),
			).at(-1),
		).toBe("Remove date");
	});

	it("keeps the visible Type date row but drops Range and Format for the day strip's calendar button (showControls false)", () =>
	{
		const html = render(
			{
				showControls: false,
			},
		);
		expect(
			{
				inputRow: html.includes(
					'<div class="flex items-center px-l py-m bg-secondary"><input type="text" autofocus="" placeholder="Type date" class="date-popup-input bg-inherit w-full border-0 text-primary placeholder:text-tertiary" name="date-picker-input" value=""/></div>',
				),
				hiddenInput: html.includes("absolute w-0 h-0 overflow-hidden"),
				rows: menuRows(html),
			},
		).toStrictEqual(
			{
				inputRow: true,
				hiddenInput: false,
				rows: ["Today", "Tomorrow", "Next week"],
			},
		);
	});

	it("renders the strip picker's calendar-mode day dots and its Found Dates / Friendly day names rows", () =>
	{
		const html = render(
			{
				showControls: false,
				selected: [new Date(2026, 9, 7)],
				renderDayContent: calendarDayContent(
					(date) => date.getMonth() === 9 && [1, 5, 7].includes(date.getDate()),
				),
				afterCalendar: calendarPickerSettingsRows(
					{
						foundDates: true,
						dayPrefix: false,
					},
					() => {},
					() => {},
				),
			},
		);
		expect(
			{
				rows: menuRows(html),
				dotted: [
					...html.matchAll(
						/>(\d+)<svg[^>]*data-icon="circle-small"[^>]*class="[^"]*absolute bottom-\[0px\] w-s h-s ([^"]*)"/gu,
					),
				].map((m) => [m[1], m[2]]),
				toggles: [...html.matchAll(/class="toggle (on|off) /gu)].map((m) => m[1]),
				rowClasses: [
					...html.matchAll(
						/class="[^"]*menuItem \[&amp;_\.menuItemIcon\]:w-\[26px\] mobile:\[&amp;_\.menuItemIcon\]:w-\[54px\] /gu,
					),
				].length,
			},
		).toStrictEqual(
			{
				rows: [
					"Today",
					"Tomorrow",
					"Next week",
					"Found DatesShows all matching dates",
					"Friendly day namesYesterday, Today, Tomorrow",
					"Calendar Layout",
				],
				dotted: [
					["1", "text-tint"],
					["5", "text-tertiary"],
					["7", "!text-on-color"],
				],
				toggles: ["on", "off"],
				rowClasses: 3,
			},
		);
	});

	it("replaces the whole body with `content` (upstream `renderContent`), input and calendar included", () =>
	{
		const html = render(
			{
				showControls: false,
				content: createElement(
					"p",
					{
						className: "replaced",
					},
					"Layout",
				),
			},
		);
		expect(
			{
				replaced: html.includes('<p class="replaced">Layout</p>'),
				input: html.includes("<input"),
				days: dayCells(html).length,
				rows: menuRows(html),
			},
		).toStrictEqual(
			{
				replaced: true,
				input: false,
				days: 0,
				rows: [],
			},
		);
	});

	it("labels the YEAR view with its decade window", () =>
	{
		const html = render(
			{
				initialView: "YEAR",
			},
		);
		expect(
			{
				header: /<strong class="flex-1 text-left[^"]*">([^<]*)<\/strong>/u.exec(html)?.[1],
				years: [...html.matchAll(/data-date-picker-grid-button="true"[^>]*>(\d{4})<\/button>/gu)].map(
					(m) => m[1],
				),
			},
		).toStrictEqual(
			{
				header: "2019 - 2030",
				years: ["2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026", "2027", "2028", "2029", "2030"],
			},
		);
	});

	it("lists the twelve short month names in the MONTH view", () =>
	{
		const html = render(
			{
				initialView: "MONTH",
			},
		);
		expect(
			{
				header: /<strong>(\d{4})<\/strong>/u.exec(html)?.[1],
				months: [...html.matchAll(/data-date-picker-grid-button="true"[^>]*>([A-Za-z]+)<\/button>/gu)].map(
					(m) => m[1],
				),
			},
		).toStrictEqual(
			{
				header: "2026",
				months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
			},
		);
	});
});

describe("nextCalendarFocus", () =>
{
	const counts =
	{
		headers: 4,
		grid: 42,
		days: 42,
	};
	const cases: [string, Parameters<typeof nextCalendarFocus>, CalendarFocusTarget | undefined][] = [
		[
			"header ArrowDown goes to the first grid button",
			["header", 0, "ArrowDown", counts],
			{
				kind: "grid",
				index: 0,
			},
		],
		[
			"header ArrowLeft wraps to the last header",
			["header", 0, "ArrowLeft", counts],
			{
				kind: "header",
				index: 3,
			},
		],
		[
			"header ArrowRight wraps to the first header",
			["header", 3, "ArrowRight", counts],
			{
				kind: "header",
				index: 0,
			},
		],
		["header ArrowUp is left to the menu", ["header", 1, "ArrowUp", counts], undefined],
		[
			"day ArrowDown moves one week later",
			["day", 0, "ArrowDown", counts],
			{
				kind: "grid",
				index: 7,
			},
		],
		[
			"day ArrowUp moves one week earlier",
			["day", 10, "ArrowUp", counts],
			{
				kind: "grid",
				index: 3,
			},
		],
		[
			"day ArrowUp past the first row goes to the first header",
			["day", 3, "ArrowUp", counts],
			{
				kind: "header",
				index: 0,
			},
		],
		["day ArrowDown past the last row is left to the menu", ["day", 38, "ArrowDown", counts], undefined],
		["day ArrowLeft does not wrap", ["day", 0, "ArrowLeft", counts], undefined],
		["day ArrowRight does not wrap", ["day", 41, "ArrowRight", counts], undefined],
		[
			"day ArrowRight moves to the next day",
			["day", 6, "ArrowRight", counts],
			{
				kind: "grid",
				index: 7,
			},
		],
		[
			"focus elsewhere in the calendar: ArrowDown goes to the first header",
			["other", 0, "ArrowDown", counts],
			{
				kind: "header",
				index: 0,
			},
		],
		[
			"focus elsewhere in the calendar: ArrowUp goes to the last grid button",
			["other", 0, "ArrowUp", counts],
			{
				kind: "grid",
				index: 41,
			},
		],
	];
	it.each(cases)("%s", (_name, args, expected) =>
	{
		expect(nextCalendarFocus(...args)).toStrictEqual(expected);
	});

	// Two columns of month buttons, 30px apart vertically: Jan Feb / Mar Apr / May Jun.
	const months = [0, 1, 2, 3, 4, 5].map((i) => (
	{
		top: Math.floor(i / 2) * 30,
		centerX: i % 2 === 0 ? 50 : 150,
	}));
	const gridCounts =
	{
		headers: 1,
		grid: 6,
		days: 0,
	};
	it.each([
		[
			"month ArrowDown goes to the button straight below",
			1,
			"ArrowDown",
			{
				kind: "grid",
				index: 3,
			},
		],
		[
			"month ArrowUp goes to the button straight above",
			4,
			"ArrowUp",
			{
				kind: "grid",
				index: 2,
			},
		],
		[
			"month ArrowUp in the top row goes to the first header",
			0,
			"ArrowUp",
			{
				kind: "header",
				index: 0,
			},
		],
		["month ArrowDown in the bottom row stays put", 5, "ArrowDown", undefined],
		[
			"month ArrowLeft goes to the previous button",
			3,
			"ArrowLeft",
			{
				kind: "grid",
				index: 2,
			},
		],
	] as const)("%s", (_name, index, key, expected) =>
	{
		expect(nextCalendarFocus("grid", index, key, gridCounts, months)).toStrictEqual(expected);
	});

	it("keeps tabindex 0 on every day, month and year button like upstream's bundled datepicker", () =>
	{
		const tabindexes = (html: string, attr: string) =>
			[...html.matchAll(new RegExp(`<button[^>]*${attr}="true"[^>]*>`, "gu"))].map(
				(m) => /tabindex="(-?\d+)"/u.exec(m[0])?.[1],
			);
		const date = tabindexes(
			render(
				{
					selected: [new Date(2026, 9, 15)],
				},
			),
			"data-date-picker-day-button",
		);
		const month = tabindexes(
			render(
				{
					initialView: "MONTH",
				},
			),
			"data-date-picker-grid-button",
		);
		const year = tabindexes(
			render(
				{
					initialView: "YEAR",
				},
			),
			"data-date-picker-grid-button",
		);
		expect(
			{
				date: [date.length, new Set(date)],
				month: [month.length, new Set(month)],
				year: [year.length, new Set(year)],
			},
		).toStrictEqual(
			{
				date: [42, new Set(["0"])],
				month: [12, new Set(["0"])],
				year: [12, new Set(["0"])],
			},
		);
	});
});
