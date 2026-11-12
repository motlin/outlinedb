import {describe, expect, it} from "vite-plus/test";
import {editorChrono, searchChrono} from "../src/dates/chrono-v1.js";
import type {ChronoV1Components, ChronoV1Result} from "../src/dates/chrono-v1.js";
import {readFileSync} from "node:fs";
import {join} from "node:path";

const fixture: unknown = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures/chrono-v1-upstream-2026-10-23.json"), "utf8"),
);
const now = new Date(2026, 9, 23, 20, 30, 22);
const UNITS = ["year", "month", "day", "hour", "minute", "weekday"];

const pad = (value: number) => String(value).padStart(2, "0");

function format(components: ChronoV1Components): string
{
	const date = components.date();
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function known(components: ChronoV1Components): string[]
{
	return UNITS.filter((unit) => components.isCertain(unit));
}

function summarize(result: ChronoV1Result)
{
	return {
		index: result.index,
		text: result.text,
		start: format(result.start),
		end: result.end ? format(result.end) : null,
		known: known(result.start),
	};
}

function day(components: ChronoV1Components | null | undefined): string | undefined
{
	return components ? format(components).slice(0, 10) : undefined;
}

interface Row
{
	phrase: string;
	guess: ReturnType<typeof summarize>[];
	search:
	{
		start: string;
		end: string;
		known: string[];
	} | null;
}

/** Upstream's search bare-date gate (`Fa1`) rejects these before `$r` ever runs; the gate is covered in the search operator tests. */
const REJECTED_BY_SEARCH_GATE = new Set(["mañana", "(oct 15)", "a1"]);

describe("chrono v1 instances against upstream fixture", () =>
{
	const editor = editorChrono(
		{
			now,
			weekStartDay: 0,
			dateFormat: "MM/DD/YYYY",
		},
	);
	const search = searchChrono(
		{
			now,
			weekStartDay: 0,
			dateFormat: "MM/DD/YYYY",
		},
	);
	const rows = fixture as Row[];

	it.each(rows.map((row) => [row.phrase, row] as const))("editor %s", (_phrase, row) =>
	{
		expect(editor(row.phrase).map(summarize)).toStrictEqual(row.guess);
	});

	it.each(rows.filter((row) => !REJECTED_BY_SEARCH_GATE.has(row.phrase)).map((row) => [row.phrase, row] as const))(
		"search %s",
		(_phrase, row) =>
		{
			const [result] = search(row.phrase);
			expect(
				result &&
				{
					start: format(result.start),
					end: format(result.end ?? result.start),
					known: known(result.start),
				},
			).toStrictEqual(row.search ?? undefined);
		},
	);
});

describe("chrono v1 spot checks", () =>
{
	const editor = editorChrono(
		{
			now,
		},
	);
	const search = searchChrono(
		{
			now,
		},
	);

	it("resolves last friday to the previous week", () =>
	{
		expect(day(editor("last friday")[0]?.start)).toBe("2026-10-16");
	});

	it("treats a bare weekday matching today as today", () =>
	{
		expect(day(editor("friday")[0]?.start)).toBe("2026-10-23");
	});

	it("does not forward-date time-only phrases", () =>
	{
		expect(format(editor("at 3pm")[0]!.start)).toBe("2026-10-23 15:00");
	});

	it("drops short phrases from the editor instance but not from search", () =>
	{
		expect(editor("fri")).toStrictEqual([]);
		expect(search("fri")).toHaveLength(1);
	});

	it("keeps casual-time words", () =>
	{
		expect(format(editor("this morning")[0]!.start)).toBe("2026-10-23 06:00");
	});

	it("parses French casual words", () =>
	{
		expect(day(editor("demain")[0]?.start)).toBe("2026-10-24");
	});

	it("has no weekend parser", () =>
	{
		expect(editor("weekend")).toStrictEqual([]);
	});

	it("swaps reversed ranges", () =>
	{
		const [result] = editor("oct 20 - oct 15");
		expect([day(result?.start), day(result?.end)]).toStrictEqual(["2027-10-15", "2027-10-20"]);
	});

	it("searches the whole next week with certain year, month and day", () =>
	{
		const [result] = search("next week");
		expect([day(result?.start), day(result?.end), known(result!.start)]).toStrictEqual([
			"2026-10-25",
			"2026-10-31",
			["year", "month", "day"],
		]);
	});

	it("pins in 1 month to a single day", () =>
	{
		const [result] = search("in 1 month");
		expect(known(result!.start)).toStrictEqual(["year", "month", "day"]);
	});

	it("collapses a weekday range to its start in search", () =>
	{
		const [result] = search("fri - mon");
		expect([day(result?.start), day(result?.end)]).toStrictEqual(["2026-10-23", "2026-10-23"]);
	});

	it("keeps only the month known for a bare month in search", () =>
	{
		expect(known(search("oct")[0]!.start)).toStrictEqual(["month"]);
	});

	it("starts this week on Monday when weekStartDay is 1", () =>
	{
		expect(
			day(
				editorChrono(
					{
						now,
						weekStartDay: 1,
					},
				)("this week")[0]?.start,
			),
		).toBe("2026-10-19");
	});
});
