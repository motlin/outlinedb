import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
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
		expect(deleteDates('<time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> x')).toBe(" x");
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
