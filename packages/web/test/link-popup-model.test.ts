// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import
{
	applyLinkToHtml,
	canApply,
	canUnlink,
	linkPopupTrigger,
	normalizeLinkHref,
	unlinkInHtml,
} from "../src/client/link-popup-model.js";

describe("normalizeLinkHref", () =>
{
	it.each([
		["example.org/x", "https://example.org/x"],
		[" http://a.b ", "http://a.b"],
		["ftp://x", "ftp://x"],
		["message:<a@b>", "message:%3Ca@b%3E"],
		["message:abc", "message:abc"],
		["mailto:a@b.c", "https://mailto:a@b.c"],
	])("%s -> %s", (raw, expected) =>
	{
		expect(normalizeLinkHref(raw)).toBe(expected);
	});
});

describe("canApply and canUnlink", () =>
{
	it("needs both a text and an href", () =>
	{
		expect([canApply("a", "b"), canApply(" ", "b"), canApply("a", " ")]).toStrictEqual([true, false, false]);
	});

	it("hides Unlink when the text is itself exactly one URL", () =>
	{
		expect([canUnlink("https://x.com"), canUnlink("alpha"), canUnlink("see https://x.com")]).toStrictEqual([
			false,
			true,
			true,
		]);
	});
});

describe("linkPopupTrigger", () =>
{
	it.each([
		[
			{
				collapsed: false,
				selectionTouchesLink: false,
				caretInLink: false,
			},
			"new",
		],
		[
			{
				collapsed: false,
				selectionTouchesLink: true,
				caretInLink: false,
			},
			null,
		],
		[
			{
				collapsed: true,
				selectionTouchesLink: false,
				caretInLink: true,
			},
			"edit",
		],
		[
			{
				collapsed: true,
				selectionTouchesLink: false,
				caretInLink: false,
			},
			null,
		],
	] as const)("%j -> %s", (input, expected) =>
	{
		expect(linkPopupTrigger(input)).toBe(expected);
	});
});

describe("applyLinkToHtml", () =>
{
	it("wraps the selected range in a link and puts the caret after the old end", () =>
	{
		expect(applyLinkToHtml("Plain alpha beta", 6, 11, "alpha", "https://example.org/x", false)).toStrictEqual(
			{
				html: 'Plain <a href="https://example.org/x">alpha</a> beta',
				caret: 12,
			},
		);
	});

	it("rewrites an existing link's text and href", () =>
	{
		expect(applyLinkToHtml('Plain <a href="h">alpha</a> beta', 6, 11, "alpha two", "h2", true)).toStrictEqual(
			{
				html: 'Plain <a href="h2">alpha two</a> beta',
				caret: 12,
			},
		);
	});
});

describe("unlinkInHtml", () =>
{
	it("keeps the text and drops the anchor", () =>
	{
		expect(unlinkInHtml('Plain <a href="h">alpha</a> beta', 6)).toBe("Plain alpha beta");
	});
});
