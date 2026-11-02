import {describe, expect, it} from "vite-plus/test";
import {formatMenuTimestamp} from "../src/client/menu-timestamp.js";

function localSeconds(year: number, month: number, day: number, hour: number, minute: number): number
{
	return new Date(year, month - 1, day, hour, minute).getTime() / 1000;
}

const now = new Date(2026, 9, 23, 3, 44);
const defaults =
{
	dateFormat: "ddd, MMM D",
	timeFormat: "h:mma",
};
const isoStyle =
{
	dateFormat: "YYYY-MM-DD ddd",
	timeFormat: "HH:mm",
};

const stamps = (formats: {dateFormat: string; timeFormat: string}) => [
	formatMenuTimestamp(localSeconds(2026, 10, 23, 3, 44), now, formats),
	formatMenuTimestamp(localSeconds(2026, 10, 21, 21, 25), now, formats),
	formatMenuTimestamp(localSeconds(2025, 3, 5, 9, 7), now, formats),
];

describe("formatMenuTimestamp", () =>
{
	it("formats today, an earlier day this year and a day in another year with the account formats", () =>
	{
		expect(stamps(isoStyle)).toStrictEqual([
			"Today at 03:44",
			"2026-10-21 Wed at 21:25",
			"2025-03-05 Wed at 09:07",
		]);
	});

	it("uses the default formats, adding the year only for another year", () =>
	{
		expect(stamps(defaults)).toStrictEqual([
			"Today at 3:44am",
			"Wed, Oct 21 at 9:25pm",
			"Wed, Mar 5, 2025 at 9:07am",
		]);
	});

	it("keeps midnight on the same day as Today", () =>
	{
		expect(formatMenuTimestamp(localSeconds(2026, 10, 23, 0, 0), now, isoStyle)).toBe("Today at 00:00");
	});
});
