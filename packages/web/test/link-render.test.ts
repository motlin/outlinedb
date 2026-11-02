import {describe, expect, it} from "vite-plus/test";
import {renderLinks} from "../src/client/link-render.js";

describe("renderLinks", () =>
{
	it("renders a stored anchor with upstream's contentLink markup", () =>
	{
		expect(renderLinks('See <a href="https://example.com/a?b=1&amp;c=2">site</a> now')).toBe(
			'See <a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/a?b=1&amp;c=2">site</a> now',
		);
	});

	it("replaces stored attributes other than href", () =>
	{
		expect(renderLinks("<a target='_self' class=\"x\" href='https://example.com/'>x</a>")).toBe(
			'<a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/">x</a>',
		);
	});

	it("keeps formatting nested inside the link", () =>
	{
		expect(renderLinks('<a href="https://example.com/"><b>site</b></a>')).toBe(
			'<a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/"><b>site</b></a>',
		);
	});

	it("renders a mailto: or tel: anchor whose text is not an email or phone as plain text", () =>
	{
		expect(
			{
				mail: renderLinks('Mail <a href="mailto:a@b.com">mailme</a> tail'),
				nested: renderLinks('<a href="mailto:a@example.com"><b>mail</b></a>'),
				tel: renderLinks('Call <a href="tel:2015551234">me</a> now'),
			},
		).toStrictEqual(
			{
				mail: "Mail mailme tail",
				nested: "<b>mail</b>",
				tel: "Call me now",
			},
		);
	});

	it("keeps a mailto: or tel: anchor whose text is an email or phone, linking the text", () =>
	{
		expect(
			{
				mail: renderLinks('<a href="mailto:x@y.com">a@b.com</a>'),
				tel: renderLinks('<a href="tel:1">201-555-1234</a>'),
			},
		).toStrictEqual(
			{
				mail: '<a class="contentLink" target="_blank" rel="noreferrer" href="mailto:a@b.com">a@b.com</a>',
				tel: '<a class="contentLink" target="_blank" rel="noreferrer" href="tel:201-555-1234">201-555-1234</a>',
			},
		);
	});

	it("renders a javascript: link's text as plain text without the anchor", () =>
	{
		expect(renderLinks('a <a href=" JavaScript:alert(1)">bad <b>x</b></a> b <a href="https://x.test/">y</a>')).toBe(
			'a bad <b>x</b> b <a class="contentLink" target="_blank" rel="noreferrer" href="https://x.test/">y</a>',
		);
	});

	it("leaves text without anchors untouched", () =>
	{
		const html = "Plain <b>bold</b> &amp; <abbr>abbr</abbr>";
		expect(renderLinks(html)).toBe(html);
	});
});
