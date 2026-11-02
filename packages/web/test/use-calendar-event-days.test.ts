import {QueryClient} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	adjacentMonths,
	calendarDaysKey,
	calendarDaysUrl,
	eventDayPredicate,
	prefetchCalendarDays,
} from "../src/client/hooks/use-calendar-event-days.js";

describe("eventDayPredicate", () =>
{
	it("marks the listed days of every loaded month, adjacent-month cells included", () =>
	{
		const hasEvent = eventDayPredicate(
			new Map([
				["2026-9", [28, 29]],
				["2026-10", [1, 2]],
			]),
		);

		expect(
			[new Date(2026, 8, 28), new Date(2026, 9, 2), new Date(2026, 8, 27), new Date(2026, 10, 1)].map(hasEvent),
		).toStrictEqual([true, true, false, false]);
	});

	it("marks nothing for months that have not loaded", () =>
	{
		expect(eventDayPredicate(new Map())(new Date(2026, 8, 28))).toBe(false);
	});
});

describe("calendarDaysUrl", () =>
{
	it("asks the server for one month", () =>
	{
		expect(
			calendarDaysUrl(
				{
					year: 2026,
					month: 9,
				},
			),
		).toBe("/api/v1/calendar/days?year=2026&month=9");
	});

	it("also asks for Found Dates days for the strip's picker", () =>
	{
		expect(
			calendarDaysUrl(
				{
					year: 2026,
					month: 9,
				},
				{
					found: true,
				},
			),
		).toBe("/api/v1/calendar/days?year=2026&month=9&found=1");
	});
});

describe("adjacentMonths", () =>
{
	it("lists the months before and after, across year boundaries", () =>
	{
		expect([
			adjacentMonths(
				{
					year: 2026,
					month: 10,
				},
			),
			adjacentMonths(
				{
					year: 2026,
					month: 1,
				},
			),
		]).toStrictEqual([
			[
				{
					year: 2026,
					month: 9,
				},
				{
					year: 2026,
					month: 11,
				},
			],
			[
				{
					year: 2025,
					month: 12,
				},
				{
					year: 2026,
					month: 2,
				},
			],
		]);
	});
});

describe("prefetchCalendarDays", () =>
{
	let urls: string[];

	beforeEach(() =>
	{
		urls = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input) =>
			{
				urls.push(input instanceof Request ? input.url : input.toString());
				return Promise.resolve(
					Response.json(
						{
							days: [1, 15],
						},
					),
				);
			}),
		);
	});

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("caches the month's days under the key the picker reads, fetching a fresh month once", async () =>
	{
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					queries:
					{
						staleTime: 60_000,
					},
				},
			},
		);
		const october =
		{
			year: 2026,
			month: 10,
		};

		await prefetchCalendarDays(
			queryClient,
			october,
			{
				found: true,
			},
		);
		await prefetchCalendarDays(
			queryClient,
			october,
			{
				found: true,
			},
		);

		expect(
			{
				urls,
				found: queryClient.getQueryData(
					calendarDaysKey(
						october,
						{
							found: true,
						},
					),
				),
				plain: queryClient.getQueryData(calendarDaysKey(october)),
			},
		).toStrictEqual(
			{
				urls: ["/api/v1/calendar/days?year=2026&month=10&found=1"],
				found: [1, 15],
				plain: undefined,
			},
		);
	});
});
