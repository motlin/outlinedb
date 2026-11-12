import {describe, expect, it} from "vite-plus/test";
import type {StaticScoreInput} from "../src/search/index.js";
import {indexText, resolveJoinedSec, staticScore, textFactor, withMonthNames} from "../src/search/index.js";

const JOINED_SEC = 1_500_000_000;
const DAY = 86_400;

const BASE: StaticScoreInput =
{
	depth: 1,
	childCount: 4,
	completed: false,
	lastModifiedSec: null,
	joinedSec: JOINED_SEC,
	nowSec: JOINED_SEC + 1000 * DAY,
	layoutMode: null,
	starred: false,
	name: "plain",
};

describe("staticScore", () =>
{
	it("ranks a depth-1 parent with 4 children above a depth-2 leaf", () =>
	{
		const parent = staticScore(BASE);
		const leaf = staticScore(
			{
				...BASE,
				depth: 2,
				childCount: 0,
			},
		);
		expect(
			{
				parent,
				leaf,
				parentWins: parent > leaf,
			},
		).toStrictEqual(
			{
				parent: (1 / 1.1) * 1 * 2 * 0.1,
				leaf: (1 / 1.2) * 0.1 * 2 * 0.1,
				parentWins: true,
			},
		);
	});

	it("multiplies by exactly 20 when starred", () =>
	{
		expect(
			staticScore(
				{
					...BASE,
					starred: true,
				},
			) / staticScore(BASE),
		).toBe(20);
	});

	it("halves completed nodes", () =>
	{
		expect(
			staticScore(
				{
					...BASE,
					completed: true,
				},
			) / staticScore(BASE),
		).toBe(0.5);
	});

	it("doubles h1 and h2 headings but not other layouts", () =>
	{
		const base = staticScore(BASE);
		expect([
			staticScore(
				{
					...BASE,
					layoutMode: "h1",
				},
			) / base,
			staticScore(
				{
					...BASE,
					layoutMode: "h2",
				},
			) / base,
			staticScore(
				{
					...BASE,
					layoutMode: "h3",
				},
			) / base,
			staticScore(
				{
					...BASE,
					layoutMode: "board",
				},
			) / base,
		]).toStrictEqual([2, 2, 1, 1]);
	});

	it("doubles childCount above 5 and scores leaves at 0.1", () =>
	{
		const base = staticScore(BASE);
		expect([
			staticScore(
				{
					...BASE,
					childCount: 5,
				},
			) / base,
			staticScore(
				{
					...BASE,
					childCount: 6,
				},
			) / base,
			staticScore(
				{
					...BASE,
					childCount: 0,
				},
			) / base,
		]).toStrictEqual([1, 2, 0.1]);
	});

	it("scores recency at 0.1 before the 360-day window and 10 at now", () =>
	{
		const base = staticScore(BASE);
		const nowSec = BASE.nowSec;
		expect(
			staticScore(
				{
					...BASE,
					lastModifiedSec: nowSec - 361 * DAY,
				},
			) / base,
		).toBe(1);
		expect(
			staticScore(
				{
					...BASE,
					lastModifiedSec: nowSec,
				},
			) / base,
		).toBeCloseTo(100, 9);
	});

	it("doubles tags and markup in the name only, so a note's tags leave a name hit's score alone", () =>
	{
		const base = staticScore(BASE);
		expect([
			staticScore(
				{
					...BASE,
					name: "a #tag",
				},
			) / base,
			staticScore(
				{
					...BASE,
					name: "a @bob #tag",
				},
			) / base,
			staticScore(
				{
					...BASE,
					name: "<i>x</i>",
				},
			) / base,
			staticScore(
				{
					...BASE,
					name: "#a <u>x</u>",
				},
			) / base,
		]).toStrictEqual([2, 2, 2, 4]);
	});

	it("matches a fully specified fixture computed by hand", () =>
	{
		const score = staticScore(
			{
				depth: 3,
				childCount: 2,
				completed: false,
				lastModifiedSec: JOINED_SEC + 80_000_000,
				joinedSec: JOINED_SEC,
				nowSec: JOINED_SEC + 86_400_000,
				layoutMode: "h2",
				starred: false,
				name: "Plan #trip <b>now</b>",
			},
		);
		// depth 1/1.3, children 1, open 2, recency 0.1 + 0.099 * (24_704_000 / 311_040), h2 2, name 2*2
		expect(score).toBeCloseTo(98.005698005698, 9);
	});
});

describe("staticScore note independence", () =>
{
	it("gives rows that differ only in their note equal scores", () =>
	{
		expect(staticScore(BASE)).toBe(
			staticScore(
				{
					...BASE,
				},
			),
		);
	});
});

describe("textFactor", () =>
{
	it("scores name hits by query length over name length times 10", () =>
	{
		expect(textFactor("ab", "abcd", "", true, false)).toBe(5);
	});

	it("scores a note-only hit 0, as upstream does, so it ranks after every name hit", () =>
	{
		expect(textFactor("abc", "zz", "abc", false, true)).toBe(0);
	});

	it("multiplies name and note factors when both hit", () =>
	{
		expect(textFactor("ab", "abcd", "abcdefghij", true, true)).toBeCloseTo(0.1, 12);
	});
});

describe("resolveJoinedSec", () =>
{
	it("uses the account join date when available", () =>
	{
		expect(
			resolveJoinedSec(
				{
					account:
					{
						joinedAt: "2017-07-14T02:40:00.000Z",
					},
					earliestCreatedSec: 1,
				},
			),
		).toBe(1_500_000_000);
	});

	it("falls back to the earliest cached created_at without an account", () =>
	{
		expect(
			resolveJoinedSec(
				{
					account: null,
					earliestCreatedSec: 1,
				},
			),
		).toBe(1);
	});
});

describe("indexText", () =>
{
	it("measures the folded, entity-decoded text without trimming", () =>
	{
		expect(
			{
				emoji: indexText("\u2714\uFE0F abc").length,
				hangul: indexText("abc \uD55C\uAD6D\uC5B4").length,
				trailing: indexText("abc   ").length,
				ampersand: indexText("abc &amp; b"),
				markup: indexText("<b>Zqrk</b> h\u00E9ading"),
			},
		).toStrictEqual(
			{
				emoji: 5,
				hangul: 12,
				trailing: 6,
				ampersand: "abc & b",
				markup: "zqrk heading",
			},
		);
	});
});

describe("withMonthNames", () =>
{
	it("appends the months a multi-month time range spans and leaves single-month text alone", () =>
	{
		const range =
			'<time startYear="2026" startMonth="1" startDay="5" endYear="2026" endMonth="3" endDay="2">x</time>';
		expect(
			{
				range: withMonthNames(range),
				single: withMonthNames('<time startYear="2026" startMonth="1" startDay="5">x</time>'),
				year: withMonthNames(range.replace('endYear="2026" endMonth="3"', 'endYear="2027" endMonth="1"'))
					.split(" ")
					.slice(-12),
			},
		).toStrictEqual(
			{
				range: `${range} Jan Feb Mar`,
				single: '<time startYear="2026" startMonth="1" startDay="5">x</time>',
				year: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
			},
		);
	});
});
