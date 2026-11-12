import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vite-plus/test";
import
{
	attachDragScroll,
	attachOutsideDismiss,
	calendarPageDate,
	monthCellTarget,
	runStripDrop,
	scrollDelta,
	scrollStripOnMount,
	stripAutoscrollSpeed,
	stripDropTarget,
	stripNav,
	stripPage,
} from "../src/client/calendar-strip-model.js";
import type {StripDropCell, StripLevel} from "../src/client/calendar-strip-model.js";
import type {MoveToToast} from "../src/client/move-to.js";
import type {CalendarTarget} from "../src/client/today.js";
import type {BlockMove} from "../src/client/tree-ops.js";
import {CalendarStripView} from "../src/client/components/calendar-strip-view.js";
import type {CalendarStripViewProps} from "../src/client/components/calendar-strip-view.js";

const NOW = new Date(2026, 9, 2, 10, 0);
const SEPARATOR = '<div class="h-[22px] border-l border-solid border-secondary"></div>';

function render(props: Partial<CalendarStripViewProps> = {}): string
{
	return renderToStaticMarkup(
		createElement(
			CalendarStripView,
			{
				level: "day",
				date: new Date(2026, 8, 30),
				now: NOW,
				weekStartDay: 0,
				dots: new Set<number>(),
				onNavigate: () =>
				{
				},
				...props,
			},
		),
	);
}

/** Each `[data-ts]` cell: its timestamp, label text, card class tokens and card text. */
function cells(html: string)
{
	return [
		...html.matchAll(
			/<div data-ts="(\d+)" class="[^"]*"><div class="h-\[18px\] flex items-start justify-center">(?:<span class="text-2xs uppercase">([^<]*)<\/span>)?<\/div><div class="([^"]*)"(?: data-strip-drop="\w+")?>(.*?)<\/div><\/div>(?=<div data-ts|<div class="flex-shrink-0"|<div><div|<\/div><\/div><\/div>$)/gu,
		),
	].map((m) => (
	{
		ts: Number(m[1]),
		label: m.at(2) ?? null,
		card: m[3].split(/\s+/u).filter(Boolean),
		text: m[4].replaceAll(/<[^>]*>/gu, ""),
		dot: /opacity-1/u.test(m[4]),
	}));
}

describe("CalendarStripView", () =>
{
	it("renders upstream's day page strip: 31 day cells from the zoomed date, a separator, then 12 month cells", () =>
	{
		const html = render(
			{
				dots: new Set([20_260_930, 20_261_005]),
			},
		);
		const all = cells(html);
		const days = all.slice(0, 31);
		const months = all.slice(31);

		expect(
			{
				outer: html.startsWith(
					'<div class="flex items-center pb-l"><div class="desktop:-ml-[1px] mobile:-ml-[7px] mr-s">',
				),
				count: all.length,
				first: days[0],
				second:
				{
					label: days[1]?.label,
					text: days[1]?.text,
				},
				today: days[2]?.card,
				dotted: days.filter((day) => day.dot).map((day) => day.text),
				lastDay: days[30]?.text,
				separator: html.includes(SEPARATOR),
				months: months.map((month) => [month.label, month.text]),
				monthCard: months[0]?.card,
				icons: [...html.matchAll(/data-icon="([^"]*)"/gu)].map((m) => m[1]).slice(0, 3),
			},
		).toStrictEqual(
			{
				outer: true,
				count: 43,
				first:
				{
					ts: new Date(2026, 8, 30).getTime(),
					label: "Sep",
					card: [
						"!bg-secondary",
						"hover:!bg-tertiary",
						"w-[28px]",
						"mobile:w-[32px]",
						"h-[38px]",
						"mobile:h-[44px]",
						"py-2xs",
						"box-border",
						"rounded-s",
						"flex",
						"flex-col",
						"justify-center",
						"items-center",
						"cursor-pointer",
						"transition-transform",
					],
					text: "We30",
					dot: true,
				},
				second:
				{
					label: "Oct",
					text: "Th1",
				},
				today: [
					"bg-tertiary",
					"hover:bg-quaternary",
					"w-[28px]",
					"mobile:w-[32px]",
					"h-[38px]",
					"mobile:h-[44px]",
					"py-2xs",
					"box-border",
					"rounded-s",
					"flex",
					"flex-col",
					"justify-center",
					"items-center",
					"cursor-pointer",
					"transition-transform",
				],
				dotted: ["We30", "Mo5"],
				lastDay: "Fr30",
				separator: true,
				months: [
					["2026", "Oct"],
					[null, "Nov"],
					[null, "Dec"],
					["2027", "Jan"],
					[null, "Feb"],
					[null, "Mar"],
					[null, "Apr"],
					[null, "May"],
					[null, "Jun"],
					[null, "Jul"],
					[null, "Aug"],
					[null, "Sep"],
				],
				monthCard: [
					"bg-primary",
					"hover:bg-secondary",
					"box-border",
					"rounded-s",
					"px-s",
					"min-w-[28px]",
					"mobile:min-w-[32px]",
					"h-[38px]",
					"mobile:h-[44px]",
					"flex",
					"justify-center",
					"items-center",
					"cursor-pointer",
					"transition-transform",
				],
				icons: ["chevron-left", "calendar-days", "chevron-right"],
			},
		);
	});

	it("prepends a Today card and its separator when the strip starts after today", () =>
	{
		const html = render(
			{
				date: new Date(2026, 9, 10),
				todayDot: true,
			},
		);
		const [today, first] = cells(html);

		expect(
			{
				today,
				first: first.ts,
				separatorAfterToday: html.includes(
					`</div></div></div><div class="flex-shrink-0"><div class="h-[18px] flex items-center"></div><div class="h-[38px] mobile:h-[44px] flex justify-center items-center">${SEPARATOR}`,
				),
			},
		).toStrictEqual(
			{
				today:
				{
					ts: new Date(2026, 9, 2).getTime(),
					label: "Today",
					card: [
						"bg-tertiary",
						"hover:bg-quaternary",
						"w-[28px]",
						"mobile:w-[32px]",
						"h-[38px]",
						"mobile:h-[44px]",
						"py-2xs",
						"box-border",
						"rounded-s",
						"flex",
						"flex-col",
						"justify-center",
						"items-center",
						"cursor-pointer",
						"transition-transform",
					],
					text: "Fr2",
					dot: true,
				},
				first: new Date(2026, 9, 10).getTime(),
				separatorAfterToday: true,
			},
		);
	});

	it("shows only the year's twelve months, without a separator, on a year page", () =>
	{
		const html = render(
			{
				level: "year",
				date: new Date(2026, 0, 1),
			},
		);

		expect(
			{
				months: cells(html).map((cell) => [cell.label, cell.text]),
				separator: html.includes(SEPARATOR),
			},
		).toStrictEqual(
			{
				months: [
					["2026", "Jan"],
					[null, "Feb"],
					[null, "Mar"],
					[null, "Apr"],
					[null, "May"],
					[null, "Jun"],
					[null, "Jul"],
					[null, "Aug"],
					[null, "Sep"],
					[null, "Oct"],
					[null, "Nov"],
					[null, "Dec"],
				],
				separator: false,
			},
		);
	});
});

describe("calendar strip navigation", () =>
{
	it("gives the arrows upstream's tooltips and the adjacent page at the zoomed level", () =>
	{
		expect([
			stripNav("day", new Date(2026, 8, 30), NOW, 0),
			stripNav("day", new Date(2026, 9, 1), NOW, 0),
			stripNav("month", new Date(2026, 9, 1), NOW, 0),
			stripNav("week", new Date(2026, 9, 11), NOW, 0),
		]).toStrictEqual([
			{
				prev:
				{
					tooltip: "Previous day",
					target:
					{
						date: new Date(2026, 8, 29),
						level: "day",
					},
				},
				next:
				{
					tooltip: "Next day",
					target:
					{
						date: new Date(2026, 9, 1),
						level: "day",
					},
				},
			},
			{
				prev:
				{
					tooltip: "Previous day",
					target:
					{
						date: new Date(2026, 8, 30),
						level: "day",
					},
				},
				next:
				{
					tooltip: "Today",
					target:
					{
						date: new Date(2026, 9, 2),
						level: "day",
					},
				},
			},
			{
				prev:
				{
					tooltip: "Previous month",
					target:
					{
						date: new Date(2026, 8, 1),
						level: "month",
					},
				},
				next:
				{
					tooltip: "Next month",
					target:
					{
						date: new Date(2026, 10, 1),
						level: "month",
					},
				},
			},
			{
				prev:
				{
					tooltip: "Previous week",
					target:
					{
						date: new Date(2026, 9, 4),
						level: "week",
					},
				},
				next:
				{
					tooltip: "Next week",
					target:
					{
						date: new Date(2026, 9, 18),
						level: "week",
					},
				},
			},
		]);
	});

	it("sends a month cell to that month node on month and year pages, else to its first day", () =>
	{
		const nov = new Date(2026, 10, 1);
		expect([
			monthCellTarget("day", nov),
			monthCellTarget("month", nov),
			monthCellTarget("year", nov),
			monthCellTarget("week", nov),
		]).toStrictEqual([
			{
				date: nov,
			},
			{
				date: nov,
				level: "month",
				createChild: false,
			},
			{
				date: nov,
				level: "month",
				createChild: false,
			},
			{
				date: nov,
				level: "month",
				createChild: false,
			},
		]);
	});

	it("reads a page's date from its day, month or year dateId", () =>
	{
		expect([
			calendarPageDate(20_260_930),
			calendarPageDate(20_261_000),
			calendarPageDate(20_260_000),
		]).toStrictEqual([new Date(2026, 8, 30), new Date(2026, 9, 1), new Date(2026, 0, 1)]);
	});

	it("shows a strip on day, week, month and year pages only, starting at the page's first day", () =>
	{
		expect([
			stripPage(
				{
					level: "week",
					dateId: 20_261_011,
				},
			),
			stripPage(
				{
					level: "month",
					dateId: 20_261_000,
				},
			),
			stripPage(
				{
					level: "root",
					dateId: null,
				},
			),
			stripPage(
				{
					level: "day",
					dateId: null,
				},
			),
			stripPage(undefined),
		]).toStrictEqual([
			{
				level: "week",
				date: new Date(2026, 9, 11),
			},
			{
				level: "month",
				date: new Date(2026, 9, 1),
			},
			null,
			null,
			null,
		]);
	});

	it("scrolls by the offset of the cell from the scroller's left edge", () =>
	{
		const cell =
		{
			getBoundingClientRect: () => (
			{
				left: 340,
			}),
		};
		const scroller =
		{
			getBoundingClientRect: () => (
			{
				left: 100,
			}),
			querySelector: (selector: string) => (selector === '[data-ts="5"]' ? cell : null),
		};
		expect([scrollDelta(scroller, 5), scrollDelta(scroller, 6)]).toStrictEqual([240, null]);
	});
});

/** A strip scroller at viewport x 100 whose `[data-ts]` cells sit at the given content offsets. */
function stripScroller(offsets: Partial<Record<number, number>>, scrollLeft = 0)
{
	const scroller =
	{
		scrollLeft,
		getBoundingClientRect: () => (
		{
			left: 100,
		}),
		querySelector: (selector: string) =>
		{
			const ts = Number(/data-ts="(\d+)"/u.exec(selector)?.[1]);
			const offset = offsets[ts];
			return offset === undefined
				? null
				:
					{
						getBoundingClientRect: () => (
						{
							left: 100 + offset - scroller.scrollLeft,
						}),
					};
		},
	};
	return scroller;
}

describe("scrollStripOnMount", () =>
{
	it("puts a month page's own first day at the left edge wherever the scroller starts", () =>
	{
		const month = stripScroller(
			{
				1: 0,
				11: 400,
			},
			400,
		);
		scrollStripOnMount(
			month,
			{
				level: "month",
				pageTs: 1,
				todayTs: 99,
			},
		);
		const day = stripScroller(
			{
				5: 240,
			},
			30,
		);
		scrollStripOnMount(
			day,
			{
				level: "day",
				pageTs: 5,
				todayTs: 99,
			},
		);
		const missing = stripScroller({}, 70);
		scrollStripOnMount(
			missing,
			{
				level: "week",
				pageTs: 5,
				todayTs: 99,
			},
		);
		expect([month.scrollLeft, day.scrollLeft, missing.scrollLeft]).toStrictEqual([0, 240, 0]);
	});

	it("scrolls a year page home, then to today's cell when the strip has one", () =>
	{
		const year = stripScroller(
			{
				1: 0,
				9: 400,
			},
			400,
		);
		scrollStripOnMount(
			year,
			{
				level: "year",
				pageTs: 1,
				todayTs: 99,
			},
		);
		const withToday = stripScroller(
			{
				1: 0,
				99: 300,
			},
			50,
		);
		scrollStripOnMount(
			withToday,
			{
				level: "year",
				pageTs: 1,
				todayTs: 99,
			},
		);
		expect([year.scrollLeft, withToday.scrollLeft]).toStrictEqual([0, 300]);
	});
});

class FakeScroller extends EventTarget
{
	scrollLeft = 50;
	style =
	{
		cursor: "",
	};
}

function mouse(type: string, clientX: number, button = 0): Event
{
	return Object.assign(
		new Event(
			type,
			{
				cancelable: true,
			},
		),
		{
			clientX,
			button,
		},
	);
}

describe("attachDragScroll", () =>
{
	it("scrolls with a left-button drag past 4px, shows grabbing, and swallows the one click that follows", () =>
	{
		const scroller = new FakeScroller();
		const doc = new EventTarget();
		attachDragScroll(scroller, doc);

		scroller.dispatchEvent(mouse("mousedown", 100));
		doc.dispatchEvent(mouse("mousemove", 97));
		const small =
		{
			scrollLeft: scroller.scrollLeft,
			cursor: scroller.style.cursor,
		};
		doc.dispatchEvent(mouse("mousemove", 90));
		const dragging =
		{
			scrollLeft: scroller.scrollLeft,
			cursor: scroller.style.cursor,
		};
		doc.dispatchEvent(mouse("mouseup", 90));
		const swallowed = mouse("click", 90);
		scroller.dispatchEvent(swallowed);
		const next = mouse("click", 90);
		scroller.dispatchEvent(next);

		expect(
			{
				small,
				dragging,
				cursorAfter: scroller.style.cursor,
				swallowed: swallowed.defaultPrevented,
				next: next.defaultPrevented,
			},
		).toStrictEqual(
			{
				small:
				{
					scrollLeft: 50,
					cursor: "",
				},
				dragging:
				{
					scrollLeft: 60,
					cursor: "grabbing",
				},
				cursorAfter: "",
				swallowed: true,
				next: false,
			},
		);
	});

	it("leaves plain clicks and other buttons alone, and detaches on cleanup", () =>
	{
		const scroller = new FakeScroller();
		const doc = new EventTarget();
		const detach = attachDragScroll(scroller, doc);

		scroller.dispatchEvent(mouse("mousedown", 100));
		doc.dispatchEvent(mouse("mouseup", 100));
		const plain = mouse("click", 100);
		scroller.dispatchEvent(plain);
		scroller.dispatchEvent(mouse("mousedown", 100, 2));
		doc.dispatchEvent(mouse("mousemove", 50));
		const rightDrag = scroller.scrollLeft;
		doc.dispatchEvent(mouse("mouseup", 50));
		detach();
		scroller.dispatchEvent(mouse("mousedown", 100));
		doc.dispatchEvent(mouse("mousemove", 50));

		expect(
			{
				plain: plain.defaultPrevented,
				rightDrag,
				detached: scroller.scrollLeft,
			},
		).toStrictEqual(
			{
				plain: false,
				rightDrag: 50,
				detached: 50,
			},
		);
	});
});

describe("attachOutsideDismiss", () =>
{
	function pointerDownOn(target: EventTarget): Event
	{
		const event = new Event("pointerdown");
		Object.defineProperty(
			event,
			"target",
			{
				value: target,
			},
		);
		return event;
	}

	it("dismisses on a pointerdown outside the popup and its button, and detaches on cleanup", () =>
	{
		const doc = new EventTarget();
		const popup = new EventTarget();
		const button = new EventTarget();
		const outside = new EventTarget();
		const dismissals: string[] = [];
		let current = "";
		const detach = attachOutsideDismiss(
			doc,
			(target) => target === popup || target === button,
			() =>
			{
				dismissals.push(current);
			},
		);

		for (const [name, target] of [
			["popup", popup],
			["button", button],
			["outside", outside],
		] as const)
		{
			current = name;
			doc.dispatchEvent(pointerDownOn(target));
		}
		detach();
		current = "after detach";
		doc.dispatchEvent(pointerDownOn(outside));

		expect(dismissals).toStrictEqual(["outside"]);
	});
});

describe("strip drag-and-drop", () =>
{
	const RECT =
	{
		left: 100,
		right: 500,
	};

	it("autoscrolls 2-10px per frame within 80px of either edge, and not in the middle", () =>
	{
		expect([
			stripAutoscrollSpeed(100, RECT),
			stripAutoscrollSpeed(140, RECT),
			stripAutoscrollSpeed(180, RECT),
			stripAutoscrollSpeed(300, RECT),
			stripAutoscrollSpeed(420, RECT),
			stripAutoscrollSpeed(460, RECT),
			stripAutoscrollSpeed(500, RECT),
			stripAutoscrollSpeed(40, RECT),
		]).toStrictEqual([-10, -6, 0, 0, 0, 6, 10, -10]);
	});

	it("drops on a day cell into that day, and on a month cell into that month on month and year pages, else its 1st", () =>
	{
		const day = new Date(2026, 9, 5).getTime();
		const month = new Date(2026, 10, 1).getTime();
		expect([
			stripDropTarget(
				"day",
				{
					kind: "day",
					ts: day,
				},
			),
			stripDropTarget(
				"month",
				{
					kind: "day",
					ts: day,
				},
			),
			stripDropTarget(
				"day",
				{
					kind: "month",
					ts: month,
				},
			),
			stripDropTarget(
				"month",
				{
					kind: "month",
					ts: month,
				},
			),
			stripDropTarget(
				"year",
				{
					kind: "month",
					ts: month,
				},
			),
		]).toStrictEqual([
			{
				date: new Date(day),
				level: "day",
				createChild: false,
			},
			{
				date: new Date(day),
				level: "day",
				createChild: false,
			},
			{
				date: new Date(month),
				level: "day",
				createChild: false,
			},
			{
				date: new Date(month),
				level: "month",
				createChild: false,
			},
			{
				date: new Date(month),
				level: "month",
				createChild: false,
			},
		]);
	});

	interface DropRecord
	{
		ensured: CalendarTarget[];
		moves: BlockMove[][];
		toasts: MoveToToast[];
		cleared: number;
		views: string[];
		undos: number;
	}

	interface DropInput
	{
		level?: StripLevel;
		cell?: StripDropCell;
		items?: string[];
		ensured?:
		{
			id: string;
			childCount: number;
		} | null;
	}

	async function drop({
		level = "day",
		cell =
		{
			kind: "day",
			ts: new Date(2026, 9, 5).getTime(),
		},
		items = ["a", "b"],
		ensured =
		{
			id: "day-5",
			childCount: 3,
		},
	}: DropInput = {}): Promise<
		DropRecord &
		{
			moved: boolean;
		}
	>
	{
		const record: DropRecord =
		{
			ensured: [],
			moves: [],
			toasts: [],
			cleared: 0,
			views: [],
			undos: 0,
		};
		const moved = await runStripDrop(
			{
				items,
				level,
				cell,
				dayName: (date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} day`,
				ensure: async (target) =>
				{
					record.ensured.push(target);
					return Promise.resolve(ensured);
				},
				clearSelection: () =>
				{
					record.cleared++;
				},
				moveNodes: (moves) =>
				{
					record.moves.push(moves);
				},
				showToast: (toast) =>
				{
					record.toasts.push(toast);
				},
				view: (id) =>
				{
					record.views.push(id);
				},
				undo: () =>
				{
					record.undos++;
				},
			},
		);
		for (const action of record.toasts[0]?.actions ?? [])
		{
			action.run();
		}
		return {
			...record,
			moved,
		};
	}

	it("moves the dragged items to the end of the ensured day, clears the selection, and toasts View and Undo", async () =>
	{
		const result = await drop();
		expect(
			{
				...result,
				toasts: result.toasts.map(({text, timeout, actions}) => (
				{
					text,
					timeout,
					actions: actions.map(({label, shortcut}) => (
					{
						label,
						shortcut,
					})),
				})),
			},
		).toStrictEqual(
			{
				moved: true,
				ensured: [
					{
						date: new Date(2026, 9, 5),
						level: "day",
						createChild: false,
					},
				],
				moves: [
					[
						{
							ids: ["a", "b"],
							parentId: "day-5",
							index: 3,
						},
					],
				],
				cleared: 1,
				toasts: [
					{
						text: "moved to '2026-10-5 day'",
						timeout: 5000,
						actions: [
							{
								label: "View",
								shortcut: "shift+return",
							},
							{
								label: "Undo",
								shortcut: undefined,
							},
						],
					},
				],
				views: ["day-5"],
				undos: 1,
			},
		);
	});

	it("names a month node `Oct 2026` in the toast", async () =>
	{
		const result = await drop(
			{
				level: "year",
				cell:
				{
					kind: "month",
					ts: new Date(2026, 9, 1).getTime(),
				},
				ensured:
				{
					id: "oct",
					childCount: 0,
				},
			},
		);
		expect(
			{
				moves: result.moves,
				text: result.toasts.map((toast) => toast.text),
			},
		).toStrictEqual(
			{
				moves: [
					[
						{
							ids: ["a", "b"],
							parentId: "oct",
							index: 0,
						},
					],
				],
				text: ["Moved to Oct 2026"],
			},
		);
	});

	it("moves nothing when the page cannot be found or created, or when it is one of the dragged items", async () =>
	{
		const missing = await drop(
			{
				ensured: null,
			},
		);
		const self = await drop(
			{
				items: ["day-5"],
			},
		);
		expect(
			[missing, self].map(({moved, moves, cleared, toasts}) => (
			{
				moved,
				moves,
				cleared,
				toasts,
			})),
		).toStrictEqual([
			{
				moved: false,
				moves: [],
				cleared: 0,
				toasts: [],
			},
			{
				moved: false,
				moves: [],
				cleared: 0,
				toasts: [
					{
						text: "Can't move to '2026-10-5 day'",
						timeout: 5000,
						actions: [],
						type: "failure",
					},
				],
			},
		]);
	});

	it("marks day and month cards as drop targets and highlights the hovered one", () =>
	{
		const day = new Date(2026, 8, 30).getTime();
		const html = render(
			{
				level: "day",
				dragging: true,
				dropHoverKey: `day:${day}`,
			},
		);
		const all = cells(html);
		const hovered = all.find((cell) => cell.ts === day);
		const firstMonth = all.find((cell) => cell.card.includes("px-s"));
		expect(
			{
				dayDrops: (html.match(/data-strip-drop="day"/gu) ?? []).length,
				monthDrops: (html.match(/data-strip-drop="month"/gu) ?? []).length,
				hovered: ["bg-tertiary", "border", "border-solid", "border-strong"].every((c) =>
					hovered?.card.includes(c),
				),
				hoveredPlain: hovered?.card.includes("!bg-secondary"),
				monthWhileDragging: ["bg-secondary", "hover:bg-tertiary"].every((c) => firstMonth?.card.includes(c)),
			},
		).toStrictEqual(
			{
				dayDrops: 31,
				monthDrops: 12,
				hovered: true,
				hoveredPlain: false,
				monthWhileDragging: true,
			},
		);
	});
});
