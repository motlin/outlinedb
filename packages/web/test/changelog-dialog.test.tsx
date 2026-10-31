import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";
import type {ChangelogEntry} from "../src/client/changelog-entries.js";

vi.mock("../src/client/stores/outline.js", () => ({useOutlineStore: () => null}));

const {ChangelogBody, ChangelogEntryView} = await import("../src/client/components/changelog-dialog.js");

const ENTRY: ChangelogEntry = {
	id: "may27_2025",
	date: "May 27th, 2025",
	title: "2025.2 - Patch Notes",
	body: [
		{t: "h3", c: ["Fixes"]},
		{t: "img", p: {src: "https://beta.workflowy.com/media/whats-new/x.gif", alt: "X", width: "360"}},
		{t: "video", p: {src: "https://beta.workflowy.com/media/whats-new/y.mp4"}},
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
								href: "https://workflowy.com/help/boards",
								target: "_blank",
								rel: "noopener noreferrer",
								className: "contentLink !text-tint",
							},
							c: ["boards"],
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
				'<h2 class="text-base">2025.2 - Patch Notes</h2></div></div><time class="text-s text-tertiary">May 27th, 2025</time></div>' +
				`<div class="${SECTION_CLASS.replaceAll("&", "&amp;")}">` +
				"<h3>Fixes</h3>" +
				'<img src="https://beta.workflowy.com/media/whats-new/x.gif" alt="X" width="360" class="border border-stone-200 rounded-s"/>' +
				'<video src="https://beta.workflowy.com/media/whats-new/y.mp4" autoPlay="" muted="" loop="" playsInline=""></video>' +
				'<ul><li>See <a href="https://workflowy.com/help/boards" target="_blank" rel="noopener noreferrer" class="contentLink !text-tint">boards</a>.</li></ul>' +
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
	it("titles the dialog What's new, lists the entries in a scroller and ends with the community footer", () => {
		const html = render(
			createElement(ChangelogBody, {entries: [ENTRY, {...ENTRY, id: "june11_2025"}], read: {june11_2025: true}}),
		);
		const entryBoxes = [...html.matchAll(/<div class="flex flex-col gap-ml p-m ([^"]*)">/gu)].map(
			(match) => match[1],
		);
		expect({
			start: html.slice(0, html.indexOf('<div class="flex flex-col gap-ml')),
			entryBoxes,
			end: html.slice(html.lastIndexOf('<div class="footer')),
		}).toStrictEqual({
			start:
				'<div class="flex flex-col flex-1 max-h-[calc(80vh_-_var(--wf-space-2xl)_-_var(--wf-space-2xl))] min-h-0 gap-l [@media(max-height:700px)]:max-h-none [@media(max-width:576px)]:max-h-none">' +
				'<h1 class="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl">What&#x27;s new</h1>' +
				'<div class="text-s leading-s paragraph flex-1 min-h-0 overflow-y-auto"><div class="container flex flex-col gap-l">',
			entryBoxes: ["rounded-s", "border-b border-solid border-primary"],
			end:
				'<div class="footer sticky bottom-0 z-1 -mx-xl -mb-xl pt-l text-sm text-center border-t border-solid border-primary bg-primary shrink-0">' +
				'<p>Questions or feedback? Get in touch on the  <a href="https://workflowy.com/discourse/login/" class="contentLink !text-tint" target="_blank">Workflowy Community.</a></p>' +
				"</div></div>",
		});
	});
});
