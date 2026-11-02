import {describe, expect, it} from "vite-plus/test";
import {stripPickerSelection} from "../src/client/components/calendar-picker-settings.js";

describe("stripPickerSelection", () =>
{
	const page = new Date(2026, 9, 21);

	it("keeps the page day for an empty or blank term", () =>
	{
		expect([stripPickerSelection("", page, []), stripPickerSelection("  ", page, [])]).toStrictEqual([
			[page],
			[page],
		]);
	});

	it("previews the parsed date, and clears the selection for an unparseable term", () =>
	{
		expect([
			stripPickerSelection("oct 19", page, [new Date(2027, 9, 19)]),
			stripPickerSelection("zzzz", page, []),
		]).toStrictEqual([[new Date(2027, 9, 19)], []]);
	});
});
