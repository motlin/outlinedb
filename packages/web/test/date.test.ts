import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, afterEach, beforeEach, vi} from "vite-plus/test";
import {DateAutocompleteFlyout, dateAutocompleteKeyAction} from "../src/client/components/date-autocomplete.js";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock} from "./helpers/css-block.js";
import {calendarDayContent, calendarPickerSettingsRows} from "../src/client/components/calendar-picker-settings.js";
import {DatePickerPopup} from "../src/client/components/date-picker-popup.js";
import type {DatePickerPopupProps} from "../src/client/components/date-picker-popup.js";
import {nextCalendarFocus} from "../src/client/components/date-picker-keyboard.js";
import type {CalendarFocusTarget} from "../src/client/components/date-picker-keyboard.js";
import
{
	applyDatePhrase,
	datePhraseText,
	deleteDates,
	hasDates,
	deletePillAfterCaret,
	findDatePhraseAtCaret,
	deletePillBeforeCaret,
	planDateInsertion,
	planDeleteDates,
	renderDatePills,
	planPillReplacement,
	replacePill,
	serializeDatePills,
	shouldTriggerDatePopup,
	timeAttrsFromDates,
} from "../src/client/date-pills.js";
import {plainLength} from "../src/client/rich-text.js";
import {renderTags} from "../src/client/tag-render.js";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import
{
	DEFAULT_DATE_SETTINGS,
	dateFormatOptions,
	resolveDateSettings,
	timeFormatOptions,
	weekStartPatch,
} from "../src/client/date-settings.js";
import
{
	EMPTY_PREFERENCES,
	fetchPreferences,
	preferenceKeys,
	setPreferences,
	usePreferences,
} from "../src/client/hooks/use-preferences.js";
import type {Preferences, PreferencesState} from "../src/client/hooks/use-preferences.js";

describe("date autocomplete", () =>
{
	function noop(): void
	{
	}

	describe("DateAutocompleteFlyout", () =>
	{
		it("renders upstream's flyout: label, calendar and gear buttons, and the Tab hint", () =>
		{
			const html = renderToStaticMarkup(
				createElement(
					DateAutocompleteFlyout,
					{
						label: "2026-10-02 Fri",
						position:
						{
							left: 241,
							top: 230,
						},
						onApply: noop,
						onOpenPicker: noop,
						onOpenSettings: noop,
					},
				),
			);
			const shell = /^<div class="([^"]*)" style="([^"]*)">/u.exec(html);
			expect(
				{
					classes: shell?.[1]?.split(/\s+/u).filter(Boolean),
					style: shell?.[2],
					label: /<span>([^<]*)<\/span>/u.exec(html)?.[1],
					icons: [...html.matchAll(/data-icon="([^"]*)"/gu)].map((match) => match[1]),
					hint: /<p class="text-xs">(.*)<\/p>/u.exec(html)?.[1],
				},
			).toStrictEqual(
				{
					classes: [
						"wf-menu",
						"flex",
						"flex-col",
						"border",
						"border-solid",
						"border-primary",
						"font-normal",
						"text-xs",
						"rounded-md",
						"bg-primary",
						"shadow-md",
						"overflow-x-hidden",
						"[transition:200ms_opacity]",
						"print:hidden",
						"absolute",
						"flyout",
						"!pt-s",
						"!pb-m",
						"!px-m",
						"text-center",
						"gap-m",
					],
					style: "pointer-events:auto;z-index:300;max-width:240px;margin-top:4px;left:241px;top:250px",
					label: "2026-10-02 Fri",
					icons: ["calendar-days", "gear"],
					hint: 'Press <span class="tooltip-key">Tab</span> or click here',
				},
			);
		});
	});

	describe("DateAutocompleteFlyout icon buttons", () =>
	{
		it("spreads upstream's `icon` attribute instead of data-icon-name", () =>
		{
			const html = renderToStaticMarkup(
				createElement(
					DateAutocompleteFlyout,
					{
						label: "x",
						position:
						{
							left: 0,
							top: 0,
						},
						onApply: noop,
						onOpenPicker: noop,
						onOpenSettings: noop,
					},
				),
			);
			expect(
				{
					buttons: [...html.matchAll(/<div (role="button" tabindex="0" icon="[^"]*" class="[^"]*")>/gu)].map(
						(m) => m[1],
					),
					dataIconName: html.includes("data-icon-name"),
				},
			).toStrictEqual(
				{
					buttons: [
						'role="button" tabindex="0" icon="calendar-alt" class="iconButton md shape-square"',
						'role="button" tabindex="0" icon="gear" class="iconButton md shape-square"',
					],
					dataIconName: false,
				},
			);
		});
	});

	describe("dateAutocompleteKeyAction", () =>
	{
		it("applies on Tab and hides on any other key", () =>
		{
			expect(
				["Tab", "a", "Escape", "Enter", "Shift"].map((key) =>
					dateAutocompleteKeyAction(
						{
							key,
							shiftKey: false,
						},
					),
				),
			).toStrictEqual(["apply", "hide", "hide", "hide", "hide"]);
		});

		it("applies on Shift+Tab too, as upstream checks only the key", () =>
		{
			expect(
				dateAutocompleteKeyAction(
					{
						key: "Tab",
						shiftKey: true,
					},
				),
			).toBe("apply");
		});
	});
});

describe("date picker css", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

	describe("date picker calendar button styles", () =>
	{
		it("gives the calendar's buttons upstream's bare `button` base at element specificity, so no browser border shows", () =>
		{
			expect(
				{
					base: cssBlock(styles, ":where([data-keyboard-focus-scope]) button"),
					hover: cssBlock(
						styles,
						":where([data-keyboard-focus-scope]) button:focus, :where([data-keyboard-focus-scope]) button:hover, :where([data-keyboard-focus-scope]) button:active",
					),
				},
			).toStrictEqual(
				{
					base:
					{
						display: "inline-block",
						position: "relative",
						"-webkit-appearance": "none",
						appearance: "none",
						border: "none",
						outline: "none",
						"box-sizing": "border-box",
						"border-radius": "var(--wf-radius-pill)",
						padding: "var(--wf-space-s) var(--wf-space-l)",
						"font-weight": "var(--wf-font-weight-regular)",
						"line-height": "var(--wf-line-height-s)",
						"font-family": "inherit",
						"font-size": "var(--wf-font-size-s)",
						background: "var(--wf-background-tertiary)",
						"text-align": "center",
						"text-decoration": "none",
						color: "var(--wf-text-primary)",
						cursor: "pointer",
						"-webkit-tap-highlight-color": "transparent",
					},
					hover:
					{
						"text-decoration": "none",
						"background-color": "color-mix(in srgb, var(--wf-background-quaternary) 85%, black)",
					},
				},
			);
		});

		it("lets `h-s` size the 6px found-date dot over FA's 1em", () =>
		{
			expect(
				{
					dot: cssBlock(styles, ".svg-inline--fa.h-s"),
				},
			).toStrictEqual(
				{
					dot:
					{
						height: "0.375rem",
					},
				},
			);
		});
	});

	describe("date surface resets", () =>
	{
		it("styles .tooltip-key like upstream's wf-base rule", () =>
		{
			expect(cssBlock(styles, ".tooltip-key")).toStrictEqual(
				{
					padding: "var(--wf-space-xs)",
					"border-radius": "var(--wf-radius-xs)",
					border: "var(--wf-border-width-s) solid var(--wf-border-primary)",
				},
			);
		});

		it("removes the focus ring from the date input like css_reset's :focus{outline:0}", () =>
		{
			expect(cssBlock(styles, ".date-popup-input:focus")).toStrictEqual(
				{
					outline: "0",
				},
			);
		});

		it("resets the autocomplete flyout paragraph margin and line height", () =>
		{
			expect(cssBlock(styles, ".wf-menu.flyout.text-center > p.text-xs")).toStrictEqual(
				{
					margin: "0",
					"line-height": "1",
				},
			);
		});
	});
});

describe("date picker popup", () =>
{
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
		const row =
			/<div class="grid grid-cols-7 justify-items-center text-tertiary[^"]*">(.*?)<\/div><\/header>/u.exec(html);
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
					icons: [
						"sun-bright",
						"moon",
						"calendar-week",
						"chevron-left",
						"chevron-right",
						"circle-small",
						"gear",
					],
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
					years: [
						"2019",
						"2020",
						"2021",
						"2022",
						"2023",
						"2024",
						"2025",
						"2026",
						"2027",
						"2028",
						"2029",
						"2030",
					],
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
});

describe("date pills", () =>
{
	const SETTINGS =
	{
		dateFormat: "YYYY-MM-DD ddd",
		timeFormat: "HH:mm",
		weekStartDay: 0,
	};
	const NOW = new Date(2026, 9, 1);
	const BOM = "﻿";
	const PILL_OPEN =
		'<time data-monolith="true" contenteditable="false" class="explosive monolith-pill" title="⌥click to search"';

	describe("renderDatePills", () =>
	{
		it("renders a stored <time> as upstream's monolith pill", () =>
		{
			expect(
				renderDatePills(
					'dpSingle <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> tail',
					SETTINGS,
					NOW,
				),
			).toBe(
				`dpSingle ${PILL_OPEN} startyear="2026" startmonth="10" startday="1">${BOM}<span class="content-wrapper">2026-10-01 Thu</span>${BOM}</time> tail`,
			);
		});

		it("adds no outer U+FEFF guard itself (addMonolithGuards does)", () =>
		{
			expect(
				renderDatePills(
					'end <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>',
					SETTINGS,
					NOW,
				),
			).toBe(
				`end ${PILL_OPEN} startyear="2026" startmonth="10" startday="1">${BOM}<span class="content-wrapper">2026-10-01 Thu</span>${BOM}</time>`,
			);
		});

		it("keeps the interleaved attribute order of a range", () =>
		{
			expect(
				renderDatePills(
					'r <time startYear="2026" endYear="2026" startMonth="10" endMonth="10" startDay="1" endDay="3">Thu, Oct 1, 2026 - Sat, Oct 3, 2026</time> x',
					SETTINGS,
					NOW,
				),
			).toBe(
				`r ${PILL_OPEN} startyear="2026" endyear="2026" startmonth="10" endmonth="10" startday="1" endday="3">${BOM}<span class="content-wrapper">2026-10-01 Thu - 2026-10-03 Sat</span>${BOM}</time> x`,
			);
		});

		it("leaves text without <time> unchanged", () =>
		{
			expect(renderDatePills("plain #tag text", SETTINGS, NOW)).toBe("plain #tag text");
		});

		it("survives tag wrapping unchanged", () =>
		{
			const pills = renderDatePills(
				'dpSingle <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> tail',
				SETTINGS,
				NOW,
			);
			expect(renderTags(pills)).toBe(pills);
		});
	});

	const SINGLE = 'dpSingle <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> tail';
	const HOURS =
		'dpHours <time startYear="2026" startMonth="10" startDay="1" startHour="14" startMinute="30">Thu, Oct 1, 2026 at 2:30pm</time>';
	const RANGE =
		'r <time startYear="2026" endYear="2026" startMonth="10" endMonth="10" startDay="1" endDay="3">Thu, Oct 1, 2026 - Sat, Oct 3, 2026</time> x';

	describe("serializeDatePills", () =>
	{
		it("round-trips rendered pills back to the stored markup", () =>
		{
			expect(
				[SINGLE, HOURS, RANGE].map((stored) => serializeDatePills(renderDatePills(stored, SETTINGS, NOW))),
			).toStrictEqual([SINGLE, HOURS, RANGE]);
		});

		it("writes camelCase attributes and markup-format inner text", () =>
		{
			expect(serializeDatePills('a <time startyear="2026" startmonth="10" startday="2">garbage</time>')).toBe(
				'a <time startYear="2026" startMonth="10" startDay="2">Fri, Oct 2, 2026</time>',
			);
		});

		it("drops the U+FEFF caret guards typed text can land beside", () =>
		{
			expect(serializeDatePills(`x${BOM}y`)).toBe("xy");
		});

		it("keeps a <time> without a start date as written, with camelCase attributes", () =>
		{
			expect(serializeDatePills('<time startyear="2026">odd</time>')).toBe('<time startYear="2026">odd</time>');
		});
	});

	describe("deletePillBeforeCaret", () =>
	{
		it("deletes the whole pill when the caret is right after it", () =>
		{
			expect(deletePillBeforeCaret(SINGLE, 10)).toBe("dpSingle  tail");
		});

		it("leaves text alone when no pill is right before the caret", () =>
		{
			expect([deletePillBeforeCaret(SINGLE, 9), deletePillBeforeCaret(SINGLE, 0)]).toStrictEqual([null, null]);
		});
	});

	describe("deleting mentions", () =>
	{
		it("Backspace after a mention and Delete before one remove it whole", () =>
		{
			expect([
				deletePillBeforeCaret('MP a <mention id="0" by="1" ts="1"> </mention> end', 6),
				deletePillAfterCaret('MP unknown <mention id="42" by="1" ts="1"> </mention> x', 11),
			]).toStrictEqual(["MP a  end", "MP unknown  x"]);
		});
	});

	describe("deletePillAfterCaret", () =>
	{
		it("deletes the whole pill when the caret is right before it", () =>
		{
			expect(deletePillAfterCaret(SINGLE, 9)).toBe("dpSingle  tail");
		});

		it("leaves text alone when no pill is right after the caret", () =>
		{
			expect([deletePillAfterCaret(SINGLE, 10), deletePillAfterCaret(SINGLE, 99)]).toStrictEqual([null, null]);
		});
	});

	describe("date pill styles", () =>
	{
		const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
		const normalized = styles
			.replaceAll(/\/\*[\s\S]*?\*\//gu, "")
			.replaceAll(/\s*([{};:>,])\s*/gu, "$1")
			.replaceAll(";}", "}")
			.replaceAll(/([:\s(,])0\.(\d)/gu, "$1.$2");

		it("carries upstream's monolith-pill rules verbatim", () =>
		{
			const rules = [
				".monolith-pill{cursor:pointer;font-size:inherit;position:relative;white-space:nowrap;display:inline;margin-right:1px;margin-left:1px}",
				".monolith-pill .content-wrapper{font-size:.8em;line-height:1.5;display:inline-block;color:var(--wf-text-primary);border-radius:16px;background:var(--wf-background-tertiary);padding:0 var(--wf-space-m)}",
				".monolith-pill:hover .content-wrapper{text-decoration:underline}",
				".notes .monolith-pill .content-wrapper{line-height:15px}",
				".done>.name>.content .monolith-pill .content-wrapper{text-decoration:line-through}",
				".content time{cursor:pointer}",
			];
			expect(rules.filter((rule) => !normalized.includes(rule))).toStrictEqual([]);
		});

		it("drops the old local time badge rule", () =>
		{
			expect(normalized.includes(".innerContentContainer time{")).toBe(false);
		});
	});

	describe("shouldTriggerDatePopup", () =>
	{
		it("opens on !! preceded by whitespace and followed by the end or whitespace", () =>
		{
			expect([
				shouldTriggerDatePopup("dpEmpty !!", 10),
				shouldTriggerDatePopup("!!", 2),
				shouldTriggerDatePopup("a !! b", 4),
				shouldTriggerDatePopup("a ！！", 4),
				shouldTriggerDatePopup("a !！", 4),
			]).toStrictEqual([true, true, true, true, true]);
		});

		it("stays literal when !! touches text on either side", () =>
		{
			expect([
				shouldTriggerDatePopup("dpEmpty!!", 9),
				shouldTriggerDatePopup("a !!b", 4),
				shouldTriggerDatePopup("a x!", 4),
				shouldTriggerDatePopup("!", 1),
			]).toStrictEqual([false, false, false, false]);
		});
	});

	describe("timeAttrsFromDates", () =>
	{
		it("builds single and sorted range attributes with 1-based months", () =>
		{
			expect([
				timeAttrsFromDates([new Date(2026, 9, 15)]),
				timeAttrsFromDates([new Date(2026, 9, 16), new Date(2026, 9, 12)]),
			]).toStrictEqual([
				{
					startYear: 2026,
					startMonth: 10,
					startDay: 15,
				},
				{
					startYear: 2026,
					startMonth: 10,
					startDay: 12,
					endYear: 2026,
					endMonth: 10,
					endDay: 16,
				},
			]);
		});
	});

	describe("planDateInsertion", () =>
	{
		const OCT_15 =
		{
			startYear: 2026,
			startMonth: 10,
			startDay: 15,
		};

		it("inserts the pill plus one space at the end and puts the caret after the space", () =>
		{
			const plan = planDateInsertion("dpPlain text row ", 17, OCT_15);
			// Caret offsets count a pill as one unit (caret-dom), so the caret sits after the 17 chars, the pill and the space.
			expect(plan).toStrictEqual(
				{
					html: 'dpPlain text row <time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time> ',
					caretOffset: plainLength("dpPlain text row ") + 1 + 1,
				},
			);
		});

		it("adds no space when text follows the caret", () =>
		{
			expect(planDateInsertion("a  tail", 2, OCT_15)).toStrictEqual(
				{
					html: 'a <time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time> tail',
					caretOffset: 3,
				},
			);
		});

		it("counts an existing pill before the caret as one unit", () =>
		{
			expect(planDateInsertion(`${SINGLE} `, 16, OCT_15)).toStrictEqual(
				{
					html: `${SINGLE} <time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time> `,
					caretOffset: 18,
				},
			);
		});

		it("adds a space before the pill when addSpaceBefore and the previous char is not whitespace", () =>
		{
			expect(
				planDateInsertion(
					"abc",
					3,
					OCT_15,
					{
						addSpaceBefore: true,
					},
				),
			).toStrictEqual(
				{
					html: 'abc <time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time> ',
					caretOffset: 6,
				},
			);
		});

		it("adds no space before the pill when the previous char is a space or there is none", () =>
		{
			expect(
				planDateInsertion(
					"abc ",
					4,
					OCT_15,
					{
						addSpaceBefore: true,
					},
				),
			).toStrictEqual(
				{
					html: 'abc <time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time> ',
					caretOffset: 6,
				},
			);
			expect(
				planDateInsertion(
					"",
					0,
					OCT_15,
					{
						addSpaceBefore: true,
					},
				),
			).toStrictEqual(
				{
					html: '<time startYear="2026" startMonth="10" startDay="15">Thu, Oct 15, 2026</time> ',
					caretOffset: 2,
				},
			);
		});
	});

	describe("deleteDates", () =>
	{
		it("removes a range pill and one preceding space, keeping the trailing space", () =>
		{
			expect(
				deleteDates(
					'dpEmpty <time startYear="2026" startMonth="10" startDay="1" endYear="2026" endMonth="10" endDay="3">Thu, Oct 1, 2026 - Sat, Oct 3, 2026</time> ',
				),
			).toBe("dpEmpty ");
		});

		it("removes a leading pill with no preceding space", () =>
		{
			expect(deleteDates('<time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> x')).toBe(
				" x",
			);
		});

		it("removes every pill, each with only one preceding space", () =>
		{
			expect(deleteDates("a <time/> b <time/>")).toBe("a b");
			expect(deleteDates("a  <time>x</time>")).toBe("a ");
		});

		it("leaves text without dates unchanged", () =>
		{
			expect(deleteDates("plain <b>text</b>")).toBe("plain <b>text</b>");
		});
	});

	describe("hasDates", () =>
	{
		it("is true only when the html holds a time element", () =>
		{
			expect([hasDates(SINGLE), hasDates("a <time/>"), hasDates("plain"), hasDates("")]).toStrictEqual([
				true,
				true,
				false,
				false,
			]);
		});
	});

	describe("replacePill", () =>
	{
		it("replaces only the indexed pill, adding no space", () =>
		{
			expect(
				replacePill(
					'dpSingle <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> tail',
					0,
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 5,
					},
				),
			).toBe('dpSingle <time startYear="2026" startMonth="10" startDay="5">Mon, Oct 5, 2026</time> tail');
		});

		it("removes the pill and keeps the space before it", () =>
		{
			expect(
				replacePill(
					'dpOtherYear <time startYear="2025" startMonth="3" startDay="14">Fri, Mar 14, 2025</time>',
					0,
					null,
				),
			).toBe("dpOtherYear ");
		});

		it("drops the replaced pill's hours and minutes", () =>
		{
			expect(
				replacePill(
					'dpHours <time startYear="2026" startMonth="10" startDay="2" startHour="14" startMinute="30">14:30 on Fri, Oct 2, 2026</time>',
					0,
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 2,
					},
				),
			).toBe('dpHours <time startYear="2026" startMonth="10" startDay="2">Fri, Oct 2, 2026</time>');
		});

		it("leaves every other pill as written", () =>
		{
			const first = '<time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>';
			const second = '<time startYear="2026" startMonth="10" startDay="2">Fri, Oct 2, 2026</time>';
			expect(replacePill(`${first} and ${second}`, 1, null)).toBe(`${first} and `);
		});
	});

	describe("planPillReplacement", () =>
	{
		const first = '<time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>';
		const second = '<time startYear="2026" startMonth="10" startDay="2">Fri, Oct 2, 2026</time>';

		it("replaces the indexed pill and puts the caret right after it", () =>
		{
			expect(
				planPillReplacement(
					`a ${first} b ${second} c`,
					1,
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 5,
					},
				),
			).toStrictEqual(
				{
					html: `a ${first} b <time startYear="2026" startMonth="10" startDay="5">Mon, Oct 5, 2026</time> c`,
					caretOffset: 7,
				},
			);
		});

		it("removes the indexed pill and puts the caret where it was", () =>
		{
			expect(planPillReplacement(`a&amp; ${first} b`, 0, null)).toStrictEqual(
				{
					html: "a&amp;  b",
					caretOffset: 3,
				},
			);
		});

		it("leaves html unchanged with the caret at the end when no pill has that index", () =>
		{
			expect(planPillReplacement(`a ${first}`, 3, null)).toStrictEqual(
				{
					html: `a ${first}`,
					caretOffset: 3,
				},
			);
		});
	});

	describe("findDatePhraseAtCaret", () =>
	{
		const OCT_2 =
		{
			startYear: 2026,
			startMonth: 10,
			startDay: 2,
		};

		it("finds the phrase ending at the caret", () =>
		{
			expect(findDatePhraseAtCaret("meet tomorrow", 13, NOW)).toStrictEqual(
				{
					start: 5,
					end: 13,
					attrs: OCT_2,
				},
			);
		});

		it("finds nothing when the caret is past the phrase", () =>
		{
			expect(findDatePhraseAtCaret("meet tomorrow x", 15, NOW)).toBeUndefined();
		});

		it("ignores phrases of three characters or fewer", () =>
		{
			expect(findDatePhraseAtCaret("meet fri", 8, NOW)).toBeUndefined();
		});

		it("makes a trailing dash a one-day range ending at the caret", () =>
		{
			expect(findDatePhraseAtCaret("tomorrow -", 10, NOW)).toStrictEqual(
				{
					start: 0,
					end: 10,
					attrs:
					{
						...OCT_2,
						endYear: 2026,
						endMonth: 10,
						endDay: 3,
					},
				},
			);
		});

		it("makes a trailing ' to ' a one-day range ending at the caret", () =>
		{
			expect(findDatePhraseAtCaret("tomorrow to ", 12, NOW)).toStrictEqual(
				{
					start: 0,
					end: 12,
					attrs:
					{
						...OCT_2,
						endYear: 2026,
						endMonth: 10,
						endDay: 3,
					},
				},
			);
		});

		it("finds an explicit dash range", () =>
		{
			expect(findDatePhraseAtCaret("trip oct 5 - oct 7", 18, NOW)).toStrictEqual(
				{
					start: 5,
					end: 18,
					attrs:
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 5,
						endYear: 2026,
						endMonth: 10,
						endDay: 7,
					},
				},
			);
		});

		it("searches only the text after the last pill before the caret", () =>
		{
			expect(findDatePhraseAtCaret("\uFFFC tomorrow", 10, NOW)).toStrictEqual(
				{
					start: 2,
					end: 10,
					attrs: OCT_2,
				},
			);
		});
	});

	describe("datePhraseText", () =>
	{
		it("is plain text with each pill as U+FFFC and entities decoded", () =>
		{
			expect(datePhraseText(`a ${SINGLE} &amp; <b>b</b>`)).toBe("a dpSingle \uFFFC tail & b");
		});
	});

	describe("applyDatePhrase", () =>
	{
		it("replaces the phrase with a pill plus one space and puts the caret after the space", () =>
		{
			expect(
				applyDatePhrase(
					"meet tomorrow",
					{
						start: 5,
						end: 13,
						attrs:
						{
							startYear: 2026,
							startMonth: 10,
							startDay: 2,
						},
					},
				),
			).toStrictEqual(
				{
					html: 'meet <time startYear="2026" startMonth="10" startDay="2">Fri, Oct 2, 2026</time> ',
					caretOffset: 7,
				},
			);
		});

		it("keeps the text after the phrase", () =>
		{
			expect(
				applyDatePhrase(
					"<b>meet tomorrow</b> x",
					{
						start: 5,
						end: 13,
						attrs:
						{
							startYear: 2026,
							startMonth: 10,
							startDay: 2,
						},
					},
				),
			).toStrictEqual(
				{
					html: '<b>meet </b><time startYear="2026" startMonth="10" startDay="2">Fri, Oct 2, 2026</time>  x',
					caretOffset: 7,
				},
			);
		});
	});

	describe("renderDatePills with malformed <time>", () =>
	{
		it("renders a month-only date from the implied day instead of throwing", () =>
		{
			const html = renderDatePills(
				"x <time startYear='2026' startMonth='10'>y</time>",
				SETTINGS,
				new Date(2026, 9, 23, 10),
			);
			expect(html).toContain('<span class="content-wrapper">2026-10-23 Fri</span>');
		});
	});

	describe("renderDatePills guards and canonical attributes", () =>
	{
		it("puts one U+FEFF between adjacent pills", () =>
		{
			const html = renderDatePills(
				'a <time startYear="2026" startMonth="10" startDay="23">x</time><time startYear="2026" startMonth="10" startDay="24">y</time> end',
				SETTINGS,
				NOW,
			);
			expect(html).toContain(`</time>${BOM}<time `);
			expect(html).not.toContain(`</time><time`);
		});

		it("emits canonical lowercase attributes in interleaved order and drops unknown ones", () =>
		{
			const html = renderDatePills(
				'<time foo="bar" startDay="25" startMonth="10" startYear="2026">x</time> t',
				SETTINGS,
				NOW,
			);
			expect(html).toContain('title="\u2325click to search" startyear="2026" startmonth="10" startday="25">');
			expect(html).not.toContain("foo");
		});
	});

	describe("planDeleteDates", () =>
	{
		it("strips dates from names and notes, only for changed values", () =>
		{
			expect(
				planDeleteDates([
					{
						id: "a",
						name: 'x <time startYear="2026" startMonth="10" startDay="1">Oct 1</time>',
						note: "",
					},
					{
						id: "b",
						name: "plain",
						note: "",
					},
					{
						id: "c",
						name: "n",
						note: 'y <time startYear="2026" startMonth="10" startDay="1">Oct 1</time>',
					},
				]),
			).toStrictEqual([
				{
					id: "a",
					name: "x",
				},
				{
					id: "c",
					note: "y",
				},
			]);
		});
	});
});

describe("date settings", () =>
{
	const NOT_CONFIGURED = "Workflowy internal API is not configured";

	let requests:
	{
		url: string;
		method: string;
		body: string | undefined;
	}[];
	let responses: Response[];

	beforeEach(() =>
	{
		requests = [];
		responses = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
		{
			requests.push(
				{
					url,
					method: init?.method ?? "GET",
					body: typeof init?.body === "string" ? init.body : undefined,
				},
			);
			return Promise.resolve(responses.shift() ?? Response.json(EMPTY_PREFERENCES));
		});
	});

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	const ACCOUNT: Preferences =
	{
		...EMPTY_PREFERENCES,
		dateFormat: "YYYY-MM-DD ddd",
		timeFormat: "HH:mm",
		weekStartDay: 1,
	};

	function seeded(preferences: Preferences = EMPTY_PREFERENCES): QueryClient
	{
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					mutations:
					{
						retry: false,
					},
					queries:
					{
						retry: false,
					},
				},
			},
		);
		queryClient.setQueryData<PreferencesState>(
			preferenceKeys.all,
			{
				preferences,
				available: true,
				error: null,
			},
		);
		return queryClient;
	}

	function captureState(queryClient: QueryClient): ReturnType<typeof usePreferences>
	{
		const captured: ReturnType<typeof usePreferences>[] = [];
		function Probe()
		{
			captured.push(usePreferences());
			return null;
		}
		renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(Probe),
			),
		);
		const state = captured.at(0);
		if (state === undefined)
		{
			throw new Error("state not captured");
		}
		return state;
	}

	describe("resolveDateSettings", () =>
	{
		it("falls back to upstream defaults for unset preferences", () =>
		{
			expect(
				resolveDateSettings(
					{
						dateFormat: null,
						timeFormat: null,
						weekStartDay: null,
					},
				),
			).toStrictEqual(
				{
					dateFormat: "ddd, MMM D",
					timeFormat: "h:mma",
					weekStartDay: 0,
				},
			);
		});

		it("treats empty stored formats as unset", () =>
		{
			expect(
				resolveDateSettings(
					{
						dateFormat: "",
						timeFormat: "",
						weekStartDay: null,
					},
				),
			).toStrictEqual(
				{
					dateFormat: "ddd, MMM D",
					timeFormat: "h:mma",
					weekStartDay: 0,
				},
			);
		});

		it("passes stored preferences through", () =>
		{
			expect(
				resolveDateSettings(
					{
						dateFormat: "YYYY-MM-DD ddd",
						timeFormat: "HH:mm",
						weekStartDay: 1,
					},
				),
			).toStrictEqual(
				{
					dateFormat: "YYYY-MM-DD ddd",
					timeFormat: "HH:mm",
					weekStartDay: 1,
				},
			);
		});

		it("exposes the upstream defaults", () =>
		{
			expect(DEFAULT_DATE_SETTINGS).toStrictEqual(
				{
					dateFormat: "ddd, MMM D",
					timeFormat: "h:mma",
					weekStartDay: 0,
				},
			);
		});
	});

	describe("Settings > Dates options", () =>
	{
		const now = new Date(2026, 9, 1, 14, 40);

		it("labels each short date format with today rendered in it", () =>
		{
			expect(dateFormatOptions(now)).toStrictEqual([
				{
					value: "ddd, MMM D",
					label: "Thu, Oct 1",
				},
				{
					value: "ddd, MMM D, YYYY",
					label: "Thu, Oct 1, 2026",
				},
				{
					value: "dddd, MMMM Do",
					label: "Thursday, October 1st",
				},
				{
					value: "dddd [the] Do [of] MMMM",
					label: "Thursday the 1st of October",
				},
				{
					value: "Do [of] MMMM",
					label: "1st of October",
				},
				{
					value: "MMMM Do, YYYY",
					label: "October 1st, 2026",
				},
				{
					value: "MM/DD/YYYY",
					label: "10/01/2026",
				},
				{
					value: "DD/MM/YYYY",
					label: "01/10/2026",
				},
				{
					value: "DD.MM.YYYY",
					label: "01.10.2026",
				},
				{
					value: "YYYY-MM-DD",
					label: "2026-10-01",
				},
			]);
		});

		it("labels each time format with the current time", () =>
		{
			expect(timeFormatOptions(now)).toStrictEqual([
				{
					value: "h:mma",
					label: "2:40pm",
				},
				{
					value: "HH:mm",
					label: "14:40",
				},
			]);
		});

		it("removes weekStartDay for Sunday and sets 1 for Monday", () =>
		{
			expect(
				{
					sunday: weekStartPatch(0),
					monday: weekStartPatch(1),
				},
			).toStrictEqual(
				{
					sunday:
					{
						weekStartDay: null,
					},
					monday:
					{
						weekStartDay: 1,
					},
				},
			);
		});
	});

	describe("preferences hook", () =>
	{
		it("issues one PATCH with only the changed key", async () =>
		{
			const queryClient = seeded();
			responses.push(
				Response.json(
					{
						...EMPTY_PREFERENCES,
						dateFormat: "YYYY-MM-DD ddd",
					},
				),
			);
			await captureState(queryClient).setPreferences(
				{
					dateFormat: "YYYY-MM-DD ddd",
				},
			);
			expect(requests).toStrictEqual([
				{
					url: "/api/v1/preferences",
					method: "PATCH",
					body: '{"dateFormat":"YYYY-MM-DD ddd"}',
				},
			]);
		});

		it("sends weekStartDay null when Sunday is chosen", async () =>
		{
			const queryClient = seeded(ACCOUNT);
			responses.push(
				Response.json(
					{
						...ACCOUNT,
						weekStartDay: null,
					},
				),
			);
			await setPreferences(queryClient, weekStartPatch(0));
			expect(
				{
					requests,
					cache: queryClient.getQueryData(preferenceKeys.all),
				},
			).toStrictEqual(
				{
					requests: [
						{
							url: "/api/v1/preferences",
							method: "PATCH",
							body: '{"weekStartDay":null}',
						},
					],
					cache:
					{
						preferences:
						{
							...ACCOUNT,
							weekStartDay: null,
						},
						available: true,
						error: null,
					},
				},
			);
		});

		it("applies the change optimistically before the server answers", async () =>
		{
			const queryClient = seeded(ACCOUNT);
			let seen: unknown;
			vi.stubGlobal("fetch", async () =>
			{
				seen = queryClient.getQueryData(preferenceKeys.all);
				return Promise.resolve(
					Response.json(
						{
							...ACCOUNT,
							timeFormat: "h:mma",
						},
					),
				);
			});
			await setPreferences(
				queryClient,
				{
					timeFormat: "h:mma",
				},
			);
			expect(seen).toStrictEqual(
				{
					preferences:
					{
						...ACCOUNT,
						timeFormat: "h:mma",
					},
					available: true,
					error: null,
				},
			);
		});

		it("rolls back a failed PATCH", async () =>
		{
			const queryClient = seeded(ACCOUNT);
			responses.push(
				new Response(
					null,
					{
						status: 500,
					},
				),
			);
			await expect(
				setPreferences(
					queryClient,
					{
						timeFormat: "h:mma",
					},
				),
			).rejects.toThrow("Failed to update preferences: 500");
			expect(queryClient.getQueryData(preferenceKeys.all)).toStrictEqual(
				{
					preferences: ACCOUNT,
					available: true,
					error: null,
				},
			);
		});

		it("reads the account's date settings", () =>
		{
			const state = captureState(seeded(ACCOUNT));
			expect(
				{
					available: state.available,
					settings: state.dateSettings,
				},
			).toStrictEqual(
				{
					available: true,
					settings:
					{
						dateFormat: "YYYY-MM-DD ddd",
						timeFormat: "HH:mm",
						weekStartDay: 1,
					},
				},
			);
		});

		it("yields the defaults and available: false on a 503 GET", async () =>
		{
			responses.push(
				Response.json(
					{
						error: NOT_CONFIGURED,
					},
					{
						status: 503,
					},
				),
			);
			const queryClient = new QueryClient();
			queryClient.setQueryData(preferenceKeys.all, await fetchPreferences());
			const state = captureState(queryClient);
			expect(
				{
					available: state.available,
					error: state.error,
					settings: state.dateSettings,
				},
			).toStrictEqual(
				{
					available: false,
					error: NOT_CONFIGURED,
					settings: DEFAULT_DATE_SETTINGS,
				},
			);
		});
	});
});
