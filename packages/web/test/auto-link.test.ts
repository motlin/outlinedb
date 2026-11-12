import {describe, expect, it} from "vite-plus/test";
import {findEmails, findPhoneNumbers, findUrls} from "../src/client/auto-link.js";
import {renderLinks} from "../src/client/link-render.js";
import {editorHtmlToNote, noteContentHtml} from "../src/client/note-text.js";

function autoLink(href: string, text: string): string
{
	return `<a class="contentLink" target="_blank" rel="noreferrer" href="${href}">${text}</a>`;
}

describe("findUrls (upstream TT)", () =>
{
	it("finds bare domains, scheme URLs, and paths with upstream's hrefs and trailing-punctuation rules", () =>
	{
		expect(
			{
				domain: findUrls("check the studentrecs.bergen.org portal 72 hours"),
				mixedCase: findUrls("Studentrecs.Bergen.Org Portal"),
				path: findUrls("see otter.ai/u/abc_123?x=1."),
				scheme: findUrls("go to https://example.com/a/b, then"),
				parens: findUrls("(https://en.wikipedia.org/wiki/Foo_(bar))"),
				message: findUrls("open message:<abc@example.com> now"),
			},
		).toStrictEqual(
			{
				domain: [
					{
						start: 10,
						end: 32,
						href: "http://studentrecs.bergen.org",
					},
				],
				mixedCase: [
					{
						start: 0,
						end: 22,
						href: "http://Studentrecs.Bergen.Org",
					},
				],
				path: [
					{
						start: 4,
						end: 26,
						href: "http://otter.ai/u/abc_123?x=1",
					},
				],
				scheme: [
					{
						start: 6,
						end: 29,
						href: "https://example.com/a/b",
					},
				],
				parens: [
					{
						start: 1,
						end: 40,
						href: "https://en.wikipedia.org/wiki/Foo_(bar)",
					},
				],
				message: [
					{
						start: 5,
						end: 30,
						href: "message:<abc@example.com>",
					},
				],
			},
		);
	});

	it("skips unknown TLDs, file-like TLDs, javascript:, and bare www like upstream", () =>
	{
		expect(
			{
				unknownTld: findUrls("version 1.2 and foo.bar"),
				fileTld: findUrls("edit notes.md and script.py"),
				fileTldWithScheme: findUrls("http://notes.md"),
				javascript: findUrls("javascript://alert(1)"),
				bareWww: findUrls("http://www"),
				mSc: findUrls("m.sc"),
				wordChar: findUrls("example.comx"),
			},
		).toStrictEqual(
			{
				unknownTld: [],
				fileTld: [],
				fileTldWithScheme: [
					{
						start: 0,
						end: 15,
						href: "http://notes.md",
					},
				],
				javascript: [],
				bareWww: [],
				mSc: [],
				wordChar: [],
			},
		);
	});
});

describe("findEmails (upstream Gn1)", () =>
{
	it("finds addresses and skips ones closed by >", () =>
	{
		expect(
			{
				plain: findEmails("Bergen County Academies admissions@bergen.org"),
				bracketed: findEmails("<a@example.com>"),
				noLocal: findEmails("@example.com"),
			},
		).toStrictEqual(
			{
				plain: [
					{
						start: 24,
						end: 45,
						text: "admissions@bergen.org",
					},
				],
				bracketed: [],
				noLocal: [],
			},
		);
	});
});

describe("findPhoneNumbers (upstream Vn1)", () =>
{
	it("finds NANP numbers bounded by space or punctuation", () =>
	{
		expect(
			{
				dashed: findPhoneNumbers("call 201-555-1234 now"),
				parens: findPhoneNumbers("(201) 555-1234"),
				country: findPhoneNumbers("+1-201-555-1234."),
				badArea: findPhoneNumbers("call 101-555-1234"),
			},
		).toStrictEqual(
			{
				dashed: [
					{
						start: 5,
						end: 17,
						text: "201-555-1234",
					},
				],
				parens: [],
				country: [
					{
						start: 0,
						end: 15,
						text: "+1-201-555-1234",
					},
				],
				badArea: [],
			},
		);
	});
});

describe("renderLinks auto-linking", () =>
{
	it("links bare domains, emails, and paths from the BCA node", () =>
	{
		expect(
			{
				domain: renderLinks("check the studentrecs.bergen.org portal"),
				email: renderLinks("Bergen County Academies admissions@bergen.org"),
				nbsp: renderLinks("Career Innovation High School  cihsadmissions@bergen.org"),
				path: renderLinks("otter.ai/u/abc"),
				phone: renderLinks("call 201-555-1234"),
			},
		).toStrictEqual(
			{
				domain: `check the ${autoLink("http://studentrecs.bergen.org", "studentrecs.bergen.org")} portal`,
				email: `Bergen County Academies ${autoLink("mailto:admissions@bergen.org", "admissions@bergen.org")}`,
				nbsp: `Career Innovation High School  ${autoLink("mailto:cihsadmissions@bergen.org", "cihsadmissions@bergen.org")}`,
				path: autoLink("http://otter.ai/u/abc", "otter.ai/u/abc"),
				phone: `call ${autoLink("tel:201-555-1234", "201-555-1234")}`,
			},
		);
	});

	it("never links inside stored links, code, or dates, and links inside formatting", () =>
	{
		expect(
			{
				stored: renderLinks('<b><a href="http://Studentrecs.Bergen.Org">Studentrecs.Bergen.Org</a> Portal</b>'),
				code: renderLinks("run <code>example.com</code>"),
				time: renderLinks('<time startYear="2026">example.com</time>'),
				bold: renderLinks("<b>The studentrecs.bergen.org account</b>"),
			},
		).toStrictEqual(
			{
				stored: `<b><a class="contentLink" target="_blank" rel="noreferrer" href="http://Studentrecs.Bergen.Org">Studentrecs.Bergen.Org</a> Portal</b>`,
				code: "run <code>example.com</code>",
				time: '<time startYear="2026">example.com</time>',
				bold: `<b>The ${autoLink("http://studentrecs.bergen.org", "studentrecs.bergen.org")} account</b>`,
			},
		);
	});

	it("decodes entities for detection and escapes the href", () =>
	{
		expect(renderLinks("see example.com/?a=1&amp;b=2 now")).toBe(
			`see ${autoLink("http://example.com/?a=1&amp;b=2", "example.com/?a=1&amp;b=2")} now`,
		);
	});

	it("stores a note's auto-links as real anchors on the next edit, like upstream", () =>
	{
		const note = 'mail admissions@bergen.org or see <a href="https://example.com/">site</a>';
		expect(editorHtmlToNote(noteContentHtml(note))).toBe(
			'mail <a href="mailto:admissions@bergen.org">admissions@bergen.org</a> or see <a href="https://example.com/">site</a>',
		);
	});

	it("marks auto-links with no extra attribute", () =>
	{
		expect(renderLinks("x https://a.com")).not.toContain("data-autolink");
	});
});
