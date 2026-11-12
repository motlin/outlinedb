import {describe, expect, it} from "vite-plus/test";
import
{
	editorHtmlToNote,
	noteContentHtml,
	noteToEditorHtml,
	planNoteKey,
	planNoteSave,
} from "../src/client/note-text.js";
import {renderTags} from "../src/client/tag-render.js";
import {renderDatePills} from "../src/client/date-pills.js";

describe("editorHtmlToNote", () =>
{
	it("turns <br> into a newline", () =>
	{
		expect(editorHtmlToNote("abc<br>def")).toBe("abc\ndef");
	});

	it("turns each block after the first into a newline and drops a block's placeholder <br>", () =>
	{
		expect(editorHtmlToNote("abc<div>def</div><div><br></div>")).toBe("abc\ndef\n");
	});

	it("keeps a blank line between paragraph blocks", () =>
	{
		expect(editorHtmlToNote("<p>abc</p><p><br></p><p>def</p>")).toBe("abc\n\ndef");
	});

	it("unwraps innerContentContainer and keeps formatting tags", () =>
	{
		expect(editorHtmlToNote('<span class="innerContentContainer"><b>Bold</b> and #tag</span>')).toBe(
			"<b>Bold</b> and #tag",
		);
	});

	it("keeps italic, underline, strike, code, links, colors, and dates", () =>
	{
		const html =
			'<i>i</i><u>u</u><s>s</s><code>c</code><a href="https://x.test">x</a>' +
			'<span class="colored c-red">r</span><span class="colored bc-blue">b</span>' +
			'<time startYear="2026" startMonth="9" startDay="4">Fri, Sep 4, 2026</time>';
		expect(editorHtmlToNote(html)).toBe(html);
	});

	it("replaces tag decoration spans and unknown tags with their text", () =>
	{
		expect(
			editorHtmlToNote(
				'<span class="contentTag"><span class="tag-link">#home</span></span> <font color="red">x</font><img src="a.png">',
			),
		).toBe("#home x");
	});

	it("turns &nbsp; and non-breaking spaces into plain spaces", () =>
	{
		expect(editorHtmlToNote("a&nbsp;b c")).toBe("a b c");
	});

	it("keeps literal newlines and other entities", () =>
	{
		expect(editorHtmlToNote("Line\n one &amp; two")).toBe("Line\n one &amp; two");
	});

	it("saves an emptied editor as an empty note", () =>
	{
		expect(editorHtmlToNote("<br>")).toBe("");
	});
});

describe("editorHtmlToNote <time> round trip", () =>
{
	it("stores <time> with upstream's camelCase attribute names after the DOM lowercased them", () =>
	{
		const stored =
			'Call <time startYear="2026" startMonth="10" startDay="2" startHour="14" startMinute="30">Fri, Oct 2, 2026 at 2:30pm</time> back';
		const fromDom = stored.replaceAll(/\s(start\w+)=/gu, (_match, name: string) => ` ${name.toLowerCase()}=`);
		expect(editorHtmlToNote(fromDom)).toBe(stored);
	});
});

describe("editorHtmlToNote date pills", () =>
{
	it("stores a rendered pill back as canonical <time> markup", () =>
	{
		const note = 'due <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>';
		const settings =
		{
			dateFormat: "YYYY-MM-DD ddd",
			timeFormat: "HH:mm",
			weekStartDay: 0,
		};
		expect(editorHtmlToNote(noteContentHtml(note, settings, new Date(2026, 9, 1)))).toBe(note);
	});
});

describe("noteToEditorHtml", () =>
{
	it("repairs legacy <br> line breaks into newlines", () =>
	{
		expect(noteToEditorHtml("abc<br>def<br/>ghi")).toBe("abc\ndef\nghi");
	});

	it("leaves a clean note unchanged", () =>
	{
		expect(noteToEditorHtml("<b>a</b>\nb")).toBe("<b>a</b>\nb");
	});
});

describe("noteContentHtml", () =>
{
	it("renders nothing for an empty note", () =>
	{
		expect(noteContentHtml("")).toBe("");
	});

	it("decorates tags with the same markup names use and round-trips through the codec", () =>
	{
		const html = noteContentHtml("and #tag in note");
		expect(html).toBe(`<span class="innerContentContainer">${renderTags("and #tag")} in note</span>`);
		expect(editorHtmlToNote(html)).toBe("and #tag in note");
	});

	it("round-trips a tag after a repaired legacy break", () =>
	{
		const html = noteContentHtml("a<br>@bob");
		expect(html).toBe(`<span class="innerContentContainer">${renderTags("a\n@bob")}</span>`);
		expect(editorHtmlToNote(html)).toBe("a\n@bob");
	});

	it("renders links with upstream's contentLink markup and stores them back as bare href links", () =>
	{
		const html = noteContentHtml('see <a href="https://example.com/">site</a>');
		expect(html).toBe(
			'<span class="innerContentContainer">see <a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/">site</a></span>',
		);
		expect(editorHtmlToNote(html)).toBe('see <a href="https://example.com/">site</a>');
	});

	it("keeps a javascript: link's text when the note is edited and saved", () =>
	{
		const note = 'keep <a href="javascript:alert(1)">this text</a> here';
		const edited = `${noteContentHtml(note)} more`;
		expect(planNoteSave(note, edited)).toStrictEqual(
			{
				save: true,
				note: "keep this text here more",
			},
		);
	});

	it("renders stored <time> as monolith pills only when given date settings", () =>
	{
		const note = 'due <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> #tag';
		const settings =
		{
			dateFormat: "YYYY-MM-DD ddd",
			timeFormat: "HH:mm",
			weekStartDay: 0,
		};
		const now = new Date(2026, 9, 1);
		expect(
			{
				raw: noteContentHtml(note),
				pills: noteContentHtml(note, settings, now),
			},
		).toStrictEqual(
			{
				raw: `<span class="innerContentContainer">${renderTags(note)}</span>`,
				pills: `<span class="innerContentContainer">${renderTags(renderDatePills(note, settings, now))}</span>`,
			},
		);
	});
});

describe("planNoteSave", () =>
{
	it("skips saving an unchanged note", () =>
	{
		expect(planNoteSave("a", "a")).toStrictEqual(
			{
				save: false,
				note: "a",
			},
		);
	});

	it("saves a changed note with line breaks as newlines", () =>
	{
		expect(planNoteSave("a", "a<br>b")).toStrictEqual(
			{
				save: true,
				note: "a\nb",
			},
		);
	});

	it("saves a blank note as the empty string", () =>
	{
		expect(planNoteSave("a", "<br>")).toStrictEqual(
			{
				save: true,
				note: "",
			},
		);
	});

	it("saves a whitespace-only note as the empty string", () =>
	{
		expect(planNoteSave("a", "&nbsp; ")).toStrictEqual(
			{
				save: true,
				note: "",
			},
		);
	});

	it("skips saving a blank note that was already empty", () =>
	{
		expect(planNoteSave("", "<br>")).toStrictEqual(
			{
				save: false,
				note: "",
			},
		);
	});
});

describe("planNoteKey", () =>
{
	const seventy = "a".repeat(70);
	const twoLines = "first line ok\nsecond";
	const base =
	{
		shift: false,
		onFirstLine: true,
		onLastLine: true,
	};

	it("inserts a newline plus a sentinel newline for Enter at the very end", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "Enter",
					text: seventy,
					start: 70,
					end: 70,
				},
			),
		).toStrictEqual(
			{
				kind: "insert",
				text: "\n\n",
				caret: 71,
			},
		);
	});

	it("inserts one newline for Enter mid-text", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "Enter",
					text: seventy,
					start: 4,
					end: 4,
				},
			),
		).toStrictEqual(
			{
				kind: "insert",
				text: "\n",
				caret: 5,
			},
		);
	});

	it("moves to the end of the name for Shift+Enter", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "Enter",
					shift: true,
					text: seventy,
					start: 4,
					end: 4,
				},
			),
		).toStrictEqual(
			{
				kind: "focusName",
				caret: "end",
			},
		);
	});

	it("inserts a tab for Tab and does nothing for Shift+Tab", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "Tab",
					text: seventy,
					start: 4,
					end: 4,
				},
			),
		).toStrictEqual(
			{
				kind: "insert",
				text: "\t",
				caret: 5,
			},
		);
		expect(
			planNoteKey(
				{
					...base,
					key: "Tab",
					shift: true,
					text: seventy,
					start: 4,
					end: 4,
				},
			),
		).toStrictEqual(
			{
				kind: "noop",
			},
		);
	});

	it("clears a blank note and focuses the name on Backspace", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "Backspace",
					text: "\n",
					start: 1,
					end: 1,
				},
			),
		).toStrictEqual(
			{
				kind: "clearAndFocusName",
			},
		);
	});

	it("appends a trailing-newline sentinel before a native Backspace in a note with text", () =>
	{
		expect([
			planNoteKey(
				{
					...base,
					key: "Backspace",
					text: "abc\nd\t",
					start: 6,
					end: 6,
				},
			),
			planNoteKey(
				{
					...base,
					key: "Backspace",
					text: "abc\nd\n",
					start: 5,
					end: 5,
				},
			),
			planNoteKey(
				{
					...base,
					key: "Backspace",
					text: "abc",
					start: 1,
					end: 3,
				},
			),
			planNoteKey(
				{
					...base,
					key: "Backspace",
					text: "\n",
					start: 1,
					end: 1,
				},
			),
		]).toStrictEqual([
			{
				kind: "appendSentinelThenNative",
			},
			{
				kind: "native",
			},
			{
				kind: "native",
			},
			{
				kind: "clearAndFocusName",
			},
		]);
	});

	it("moves Up to the start of the name only from offset 0", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowUp",
					text: twoLines,
					start: 13,
					end: 13,
					onLastLine: false,
				},
			),
		).toStrictEqual(
			{
				kind: "native",
			},
		);
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowUp",
					text: twoLines,
					start: 0,
					end: 0,
					onLastLine: false,
				},
			),
		).toStrictEqual(
			{
				kind: "focusName",
				caret: 0,
			},
		);
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowUp",
					shift: true,
					text: twoLines,
					start: 0,
					end: 0,
					onLastLine: false,
				},
			),
		).toStrictEqual(
			{
				kind: "native",
			},
		);
	});

	it("moves Down at the very end of the last line to the next row's name", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowDown",
					text: twoLines,
					start: 20,
					end: 20,
					onFirstLine: false,
				},
			),
		).toStrictEqual(
			{
				kind: "focusNextRowName",
			},
		);
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowDown",
					text: twoLines,
					start: 3,
					end: 3,
					onLastLine: false,
				},
			),
		).toStrictEqual(
			{
				kind: "native",
			},
		);
	});

	it("moves Left at 0 to the end of the name and Right at the end to the next row's name", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowLeft",
					text: "hi",
					start: 0,
					end: 0,
				},
			),
		).toStrictEqual(
			{
				kind: "focusName",
				caret: "end",
			},
		);
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowLeft",
					text: "hi",
					start: 1,
					end: 1,
				},
			),
		).toStrictEqual(
			{
				kind: "native",
			},
		);
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowRight",
					text: "hi",
					start: 2,
					end: 2,
				},
			),
		).toStrictEqual(
			{
				kind: "focusNextRowName",
			},
		);
		expect(
			planNoteKey(
				{
					...base,
					key: "ArrowRight",
					text: "hi",
					start: 0,
					end: 2,
				},
			),
		).toStrictEqual(
			{
				kind: "native",
			},
		);
	});

	it("leaves Delete native", () =>
	{
		expect(
			planNoteKey(
				{
					...base,
					key: "Delete",
					text: "",
					start: 0,
					end: 0,
				},
			),
		).toStrictEqual(
			{
				kind: "native",
			},
		);
	});
});

describe("mentions in notes", () =>
{
	const settings =
	{
		dateFormat: "YYYY-MM-DD ddd",
		timeFormat: "HH:mm",
		weekStartDay: 0,
	};
	const note = 'note <mention id="0" by="1" ts="1"> </mention> tail';

	it("keeps a mention byte-identical through a note edit", () =>
	{
		const html = noteContentHtml(note, settings, new Date(2026, 9, 1), null);
		expect(html).toContain('class="mention view-mode monolith-pill explosive"');
		expect(editorHtmlToNote(`${html}z`)).toBe('note <mention id="0" by="1" ts="1"> </mention> tailz');
	});

	it("stores a rendered mention back unchanged", () =>
	{
		expect(editorHtmlToNote(noteContentHtml(note, settings, new Date(2026, 9, 1), null))).toBe(note);
	});

	it("keeps a raw mention when saving", () =>
	{
		expect(editorHtmlToNote(`${note}z`)).toBe(`${note}z`);
	});
});
