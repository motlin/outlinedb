import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";
import {NONAME_TITLE, documentTitleFor, nextTitle} from "../src/client/document-title.js";

const FEFF = "﻿";

describe("documentTitleFor", () => {
	it("appends the OutlineDB suffix to a plain name", () => {
		expect(documentTitleFor("🧪 Sync sandbox")).toBe("🧪 Sync sandbox - OutlineDB");
	});

	it("strips tags and decodes entities", () => {
		expect(documentTitleFor("<b>Bold</b> &amp; <i>it</i> #tagx")).toBe("Bold & it #tagx - OutlineDB");
	});

	it("falls back to the noname title for an empty label", () => {
		expect([
			documentTitleFor(""),
			documentTitleFor(null),
			documentTitleFor(undefined),
			documentTitleFor("<b></b>"),
		]).toStrictEqual([NONAME_TITLE, NONAME_TITLE, NONAME_TITLE, NONAME_TITLE]);
		expect(NONAME_TITLE).toBe("OutlineDB - Organize your brain.");
	});

	it("truncates a label over 100 chars", () => {
		expect(documentTitleFor(`${"L".repeat(60)} ${"M".repeat(60)}`)).toBe(
			`${"L".repeat(60)} ${"M".repeat(39)}... - OutlineDB`,
		);
	});

	it("does not trim", () => {
		expect(documentTitleFor(" a ")).toBe(" a  - OutlineDB");
	});

	it("decodes numeric entities and nbsp, amp last", () => {
		expect(documentTitleFor("a&nbsp;b &#65;&#x42; &amp;lt;")).toBe("a b AB &lt; - OutlineDB");
	});

	it("titles a date name through the render callback", () => {
		const render = (html: string) => html.replace(/<time[^>]*>.*?<\/time>/u, `${FEFF}${FEFF}2026-10-01 Thu${FEFF}`);
		expect(
			documentTitleFor(
				'<time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time> dated',
				render,
			),
		).toBe(`${FEFF}${FEFF}2026-10-01 Thu${FEFF} dated - OutlineDB`);
	});
});

describe("static fallback title", () => {
	it("index.html carries the noname title", () => {
		const html = readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");
		expect(/<title>(.*?)<\/title>/u.exec(html)?.[1]).toStrictEqual(NONAME_TITLE);
	});
});

describe("nextTitle", () => {
	it("retitles on a zoom change", () => {
		expect(nextTitle({zoomId: "a", title: "A - OutlineDB"}, {zoomId: "b", nameHtml: "B"})).toBe("B - OutlineDB");
	});

	it("keeps the old title when only the name changes", () => {
		expect(nextTitle({zoomId: "a", title: "A - OutlineDB"}, {zoomId: "a", nameHtml: "Renamed"})).toBeNull();
	});

	it("titles a zoom whose node has loaded since", () => {
		expect(nextTitle({zoomId: "a", title: null}, {zoomId: "a", nameHtml: "A"})).toBe("A - OutlineDB");
	});

	it("gives Home the noname title", () => {
		expect(nextTitle({zoomId: "a", title: "A - OutlineDB"}, {zoomId: null, nameHtml: null})).toStrictEqual(
			NONAME_TITLE,
		);
	});
});
