import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";
import type {ChangelogEntry} from "../src/client/whats-new-entries.js";

vi.mock("../src/client/stores/outline.js", () => ({useOutlineStore: () => null}));

const {ChangelogBody, ChangelogEntryView} = await import("../src/client/components/changelog-dialog.js");

const ENTRY: ChangelogEntry = {
	id: "first_entry",
	date: "October 31st, 2026",
	title: "First feature",
	body: [
		{t: "h3", c: ["Fixes"]},
		{t: "p", c: ["Run ", {t: "code", c: ["--json"]}, "."]},
		{
			t: "ul",
			c: [
				{
					t: "li",
					c: [
						"See ",
						{
							t: "a",
							p: {
								href: "/changes",
								className: "contentLink !text-tint",
							},
							c: ["Node Changes"],
						},
						".",
					],
				},
			],
		},
	],
};

const SECTION_CLASS = `
        section leading-base flex flex-col gap-m
        [&_h2]:text-base
        [&_ul]:list-disc
        [&_ul]:ml-l
      `;

/** Static markup without svg paths or the image preload links React's server renderer hoists. */
function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
	return renderToStaticMarkup(element)
		.replaceAll(/<link rel="preload" as="image" href="[^"]*"\/>/gu, "")
		.replaceAll(/ d="[^"]*"/gu, "");
}

describe("ChangelogEntryView (upstream I3)", () => {
	it("renders an unread entry with the notification dot and rounded box, and its body as upstream's elements", () => {
		expect(render(createElement(ChangelogEntryView, {entry: ENTRY, unread: true}))).toBe(
			'<div class="flex flex-col gap-ml p-m rounded-s">' +
				'<div class="update-header flex flex-col gap-xs"><div class="title-row flex items-center gap-s justify-between"><div class="items-center flex gap-s">' +
				'<svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="circle" class="svg-inline--fa fa-circle fa-1x w-m h-m text-tint blue-circle" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor"></path></svg>' +
				'<h2 class="text-base">First feature</h2></div></div><time class="text-s text-tertiary">October 31st, 2026</time></div>' +
				`<div class="${SECTION_CLASS.replaceAll("&", "&amp;")}">` +
				"<h3>Fixes</h3>" +
				"<p>Run <code>--json</code>.</p>" +
				'<ul><li>See <a href="/changes" class="contentLink !text-tint">Node Changes</a>.</li></ul>' +
				"</div>" +
				'<div class="flex justify-between mb-m"><span></span><div class="flex gap-m"></div></div>' +
				"</div>",
		);
	});

	it("renders a read entry with a bottom border and no dot", () => {
		const html = render(createElement(ChangelogEntryView, {entry: ENTRY, unread: false}));
		expect({
			box: html.startsWith('<div class="flex flex-col gap-ml p-m border-b border-solid border-primary">'),
			dot: html.includes("blue-circle"),
		}).toStrictEqual({box: true, dot: false});
	});
});

describe("ChangelogBody (upstream Rt0)", () => {
	it("titles the dialog What's new and lists the entries in a scroller, with no workflowy.com community footer", () => {
		const html = render(
			createElement(ChangelogBody, {entries: [ENTRY, {...ENTRY, id: "second_entry"}], read: ["second_entry"]}),
		);
		const entryBoxes = [...html.matchAll(/<div class="flex flex-col gap-ml p-m ([^"]*)">/gu)].map(
			(match) => match[1],
		);
		expect({
			start: html.slice(0, html.indexOf('<div class="flex flex-col gap-ml')),
			entryBoxes,
			footer: html.includes("footer") || html.includes("workflowy.com"),
		}).toStrictEqual({
			start:
				'<div class="flex flex-col flex-1 max-h-[calc(80vh_-_var(--wf-space-2xl)_-_var(--wf-space-2xl))] min-h-0 gap-l [@media(max-height:700px)]:max-h-none [@media(max-width:576px)]:max-h-none">' +
				'<h1 class="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl">What&#x27;s new</h1>' +
				'<div class="text-s leading-s paragraph flex-1 min-h-0 overflow-y-auto"><div class="container flex flex-col gap-l">',
			entryBoxes: ["rounded-s", "border-b border-solid border-primary"],
			footer: false,
		});
	});
});
