import {describe, expect, it} from "vite-plus/test";
import {bodyTokens} from "../src/client/decision-tokens.js";

describe("bodyTokens", () =>
{
	it("splits out dates, durations and counts, leaving the rest as plain text", () =>
	{
		expect(bodyTokens("skipped 1 runs since 2026-10-24, every 3w or 16 days")).toStrictEqual([
			{
				text: "skipped ",
				kind: null,
			},
			{
				text: "1",
				kind: "count",
			},
			{
				text: " runs since ",
				kind: null,
			},
			{
				text: "2026-10-24",
				kind: "date",
			},
			{
				text: ", every ",
				kind: null,
			},
			{
				text: "3w",
				kind: "duration",
			},
			{
				text: " or ",
				kind: null,
			},
			{
				text: "16",
				kind: "count",
			},
			{
				text: " days",
				kind: null,
			},
		]);
	});

	it("marks the numbers on an overdue line as warnings, but not its dates", () =>
	{
		expect(bodyTokens("Overdue 13d (due 2026-10-17)")).toStrictEqual([
			{
				text: "Overdue ",
				kind: null,
			},
			{
				text: "13d",
				kind: "overdue",
			},
			{
				text: " (due ",
				kind: null,
			},
			{
				text: "2026-10-17",
				kind: "date",
			},
			{
				text: ")",
				kind: null,
			},
		]);
	});

	it("warns only on an overdue line's first number, so later counts keep their own color", () =>
	{
		expect(bodyTokens("overdue 7d, skipped 1 runs")).toStrictEqual([
			{
				text: "overdue ",
				kind: null,
			},
			{
				text: "7d",
				kind: "overdue",
			},
			{
				text: ", skipped ",
				kind: null,
			},
			{
				text: "1",
				kind: "count",
			},
			{
				text: " runs",
				kind: null,
			},
		]);
	});

	it("leaves digits inside words, ids and versions alone", () =>
	{
		expect(bodyTokens("Q3 plan v2 for abc123 and x-9")).toStrictEqual([
			{
				text: "Q3 plan v2 for abc123 and x-9",
				kind: null,
			},
		]);
	});

	it("returns a line without numbers as one plain token, and nothing for an empty line", () =>
	{
		expect(
			{
				plain: bodyTokens("<b>not html</b>"),
				empty: bodyTokens(""),
			},
		).toStrictEqual(
			{
				plain: [
					{
						text: "<b>not html</b>",
						kind: null,
					},
				],
				empty: [],
			},
		);
	});
});
