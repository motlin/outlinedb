import {describe, expect, it} from "vite-plus/test";
import {renderCodeBlockHtml, renderEditorHtml, serializeEditorHtml} from "../src/client/editor-html.js";

const settings =
{
	dateFormat: "YYYY-MM-DD ddd",
	timeFormat: "HH:mm",
	weekStartDay: 0,
};
const account =
{
	userId: 7,
	fullName: "Alice Smith",
};

describe("mentions in names", () =>
{
	it.each([
		'MP date <mention id="0" by="1" ts="1"> </mention> <time startYear="2026" startMonth="10" startDay="23">Fri, Oct 23, 2026</time> z',
		'MP bold <b>p <mention id="0" by="1" ts="1"> </mention> q</b> r',
		'<mention id="7" by="7" ts="5"> </mention>',
	])("round-trips %s", (stored) =>
	{
		expect(serializeEditorHtml(renderEditorHtml(stored, settings, account))).toBe(stored);
	});

	it("renders the resolved name as a pill", () =>
	{
		const html = renderEditorHtml('a <mention id="7" by="7" ts="5"> </mention> b', settings, account);
		expect(html).toContain("mention-of-current-user");
		expect(html).toContain("Alice Smith");
	});

	it("repairs a corrupted raw mention on serialize", () =>
	{
		expect(serializeEditorHtml('x <mention id="7" by="7" ts="5"> Q</mention> y')).toBe(
			'x <mention id="7" by="7" ts="5"> </mention> y',
		);
	});
});

describe("links in names", () =>
{
	it("renders stored anchors with upstream's link markup while editing", () =>
	{
		expect(renderEditorHtml('Ext <a href="https://e.com/p">example</a> tail', settings)).toBe(
			'Ext <a class="contentLink" target="_blank" rel="noreferrer" href="https://e.com/p">example</a> tail',
		);
	});

	it("shows an auto-link as a real link while editing and stores it on the next save", () =>
	{
		const rendered = renderEditorHtml("Auto https://example.org/auto here", settings);
		expect(
			{
				rendered,
				stored: serializeEditorHtml(rendered),
			},
		).toStrictEqual(
			{
				rendered:
					'Auto <a class="contentLink" target="_blank" rel="noreferrer" href="https://example.org/auto">https://example.org/auto</a> here',
				stored: 'Auto <a href="https://example.org/auto">https://example.org/auto</a> here',
			},
		);
	});

	it("stores anchors without class, target or rel", () =>
	{
		expect(
			serializeEditorHtml(
				'Ext <a class="contentLink" target="_blank" rel="noreferrer" href="https://e.com/p">example</a> tail',
			),
		).toBe('Ext <a href="https://e.com/p">example</a> tail');
	});

	it.each([
		'Bold <b>bo<a href="https://e.com/b">ld link</a></b> end',
		'A <a href="https://workflowy.com/#/0123456789ab">x</a>',
	])("round-trips %s", (stored) =>
	{
		expect(serializeEditorHtml(renderEditorHtml(stored, settings))).toBe(stored);
	});
});

describe("renderCodeBlockHtml", () =>
{
	it("keeps only the plain text, spaces and newlines of the stored name", () =>
	{
		expect([
			renderCodeBlockHtml(
				'a <b>b</b> #t <a href="https://x.y">https://x.y</a> <time datetime="2026-10-01">Oct 1</time>\n  z',
			),
			renderCodeBlockHtml("1 &lt; 2 &amp; 3"),
		]).toStrictEqual(["a b #t https://x.y Oct 1\n  z", "1 &lt; 2 &amp; 3"]);
	});
});
