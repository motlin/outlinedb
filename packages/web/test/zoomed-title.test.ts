import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {CalendarInfo, NodeResponse} from "../src/node-types.js";

const ancestorsState:
{
	data: Pick<NodeResponse, "id" | "calendar">[] | undefined;
} =
{
	data: undefined,
};
const requested: (string | null)[] = [];

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useAncestors: (nodeId: string | null) =>
	{
		requested.push(nodeId);
		return ancestorsState;
	},
}));

const {DayTitlePrefix} = await import("../src/client/components/day-title-prefix.js");
const {CALENDAR_SETTINGS_KEY} = await import("../src/client/hooks/use-calendar-settings.js");

const PREFIX_CLASS =
	"flex h-[var(--line-height)] whitespace-nowrap items-center pr-m pt-[--wf-content-padding-top] pb-[--wf-content-padding-bottom]";

function rootInfo(dayPrefix: boolean | null): CalendarInfo
{
	return {
		level: null,
		dateId: null,
		root: true,
		foundDates: true,
		dayPrefix,
		restorableUniqueNode: false,
	};
}

function dayNode(dateId: number): Pick<NodeResponse, "id" | "calendar">
{
	return {
		id: `d${dateId}`,
		calendar:
		{
			level: "day",
			dateId,
			root: false,
			foundDates: null,
			dayPrefix: null,
			restorableUniqueNode: false,
		},
	};
}

/** Render inside a client whose calendar settings cache holds `cached`, or nothing when undefined. */
function renderWith(
	node: Pick<NodeResponse, "id" | "calendar">,
	cached?:
	{
		foundDates: boolean;
		dayPrefix: boolean;
	},
)
{
	const queryClient = new QueryClient();
	if (cached !== undefined)
	{
		queryClient.setQueryData(CALENDAR_SETTINGS_KEY, cached);
	}
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: queryClient,
			},
			createElement(
				DayTitlePrefix,
				{
					node,
				},
			),
		),
	);
}

function render(node: Pick<NodeResponse, "id" | "calendar">, dayPrefix: boolean | null = true): string
{
	ancestorsState.data = [
		{
			id: "cal",
			calendar: rootInfo(dayPrefix),
		},
		node,
	];
	return renderWith(node);
}

describe("DayTitlePrefix", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 9, 2, 10, 0));
		requested.length = 0;
	});
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("renders upstream's friendly day name span on yesterday, today and tomorrow", () =>
	{
		expect([render(dayNode(20_261_001)), render(dayNode(20_261_002)), render(dayNode(20_261_003))]).toStrictEqual([
			`<span class="${PREFIX_CLASS}">Yesterday,</span>`,
			`<span class="${PREFIX_CLASS}">Today,</span>`,
			`<span class="${PREFIX_CLASS}">Tomorrow,</span>`,
		]);
	});

	it("renders nothing on other days, non-date nodes, or when the root turns Friendly day names off", () =>
	{
		expect(
			{
				otherDay: render(dayNode(20_261_005)),
				plain: render(
					{
						id: "plain",
						calendar: null,
					},
				),
				month: render(
					{
						id: "m10",
						calendar:
						{
							level: "month",
							dateId: 20_261_000,
							root: false,
							foundDates: null,
							dayPrefix: null,
							restorableUniqueNode: false,
						},
					},
				),
				off: render(dayNode(20_261_002), false),
				unset: render(dayNode(20_261_002), null),
			},
		).toStrictEqual(
			{
				otherDay: "",
				plain: "",
				month: "",
				off: "",
				unset: `<span class="${PREFIX_CLASS}">Today,</span>`,
			},
		);
	});

	it("waits for the ancestors before rendering, and only fetches them for day nodes", () =>
	{
		ancestorsState.data = undefined;
		const node = dayNode(20_261_002);

		expect(
			{
				html: renderWith(node),
				plain: renderWith(
					{
						id: "plain",
						calendar: null,
					},
				),
				requested,
			},
		).toStrictEqual(
			{
				html: "",
				plain: "",
				requested: ["d20261002", null],
			},
		);
	});

	it("follows the cached calendar setting over the ancestors' root value, so a toggle shows before the refetch", () =>
	{
		ancestorsState.data = [
			{
				id: "cal",
				calendar: rootInfo(true),
			},
			dayNode(20_261_002),
		];
		const offWhileAncestorsSayOn = renderWith(
			dayNode(20_261_002),
			{
				foundDates: true,
				dayPrefix: false,
			},
		);
		ancestorsState.data = [
			{
				id: "cal",
				calendar: rootInfo(false),
			},
			dayNode(20_261_002),
		];
		const onWhileAncestorsSayOff = renderWith(
			dayNode(20_261_002),
			{
				foundDates: true,
				dayPrefix: true,
			},
		);

		expect(
			{
				offWhileAncestorsSayOn,
				onWhileAncestorsSayOff,
			},
		).toStrictEqual(
			{
				offWhileAncestorsSayOn: "",
				onWhileAncestorsSayOff: `<span class="${PREFIX_CLASS}">Today,</span>`,
			},
		);
	});
});
