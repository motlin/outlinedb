import {describe, expect, it} from "vite-plus/test";
import {linkColorCss} from "../src/client/link-color-style.js";
import {applyLinkPaste, planLinkPaste} from "../src/client/link-paste.js";
import {renderLinks} from "../src/client/link-render.js";

describe("link color style", () => {
	describe("linkColorCss", () => {
		it("Blue: the tint rule, the workflowy.com and localhost overrides, then the search-match sky rule", () => {
			expect(linkColorCss(false)).toBe(
				[
					".contentLink { color: var(--wf-text-tint); }",
					".contentLink[href^='https://workflowy.com'],.contentLink[href^='https://dev.workflowy.com'],.contentLink[href^='https://beta.workflowy.com'],.contentLink[href^='http://workflowy.com'],.contentLink[href^='http://dev.workflowy.com'],.contentLink[href^='http://beta.workflowy.com'],.contentLink[href^='http://localhost'] { color: var(--wf-text-tertiary); }",
					".fullMatch .contentLink, .project.metaMatches .contentLink { color: var(--wf-text-sky); }",
				].join("\n"),
			);
		});

		it("Gray: only the tertiary rule", () => {
			expect(linkColorCss(true)).toBe(".contentLink { color: var(--wf-text-tertiary); }");
		});
	});
});

describe("link paste", () => {
	const none = (): string | null => null;

	describe("planLinkPaste (upstream pJ1)", () => {
		it("formats a selection with the pasted link and inserts when the selection is itself a URL", () => {
			expect([
				planLinkPaste({
					clipboardText: "example.net/p",
					selectionText: "beta",
					collapsed: false,
					inCode: false,
					resolveTargetName: none,
				}),
				planLinkPaste({
					clipboardText: "https://x.com",
					selectionText: "https://y.com",
					collapsed: false,
					inCode: false,
					resolveTargetName: none,
				}),
				planLinkPaste({
					clipboardText: "  https://x.com/a \n",
					selectionText: "",
					collapsed: true,
					inCode: false,
					resolveTargetName: none,
				}),
			]).toStrictEqual([
				{kind: "format", href: "http://example.net/p"},
				{kind: "insert", text: "https://x.com", href: "https://x.com"},
				{kind: "insert", text: "https://x.com/a", href: "https://x.com/a"},
			]);
		});

		it("inserts an internal target's name, falling back to the href when blank", () => {
			const resolve = (href: string): string | null =>
				href === "https://workflowy.com/#/abc"
					? "Target"
					: href === "https://workflowy.com/#/blank"
						? ""
						: null;
			expect([
				planLinkPaste({
					clipboardText: "https://workflowy.com/#/abc",
					selectionText: "",
					collapsed: true,
					inCode: false,
					resolveTargetName: resolve,
				}),
				planLinkPaste({
					clipboardText: "https://workflowy.com/#/blank",
					selectionText: "",
					collapsed: true,
					inCode: false,
					resolveTargetName: resolve,
				}),
			]).toStrictEqual([
				{kind: "insert", text: "Target", href: "https://workflowy.com/#/abc"},
				{kind: "insert", text: "https://workflowy.com/#/blank", href: "https://workflowy.com/#/blank"},
			]);
		});

		it("encodes message: links and declines in code, for non-links and for two links", () => {
			expect([
				planLinkPaste({
					clipboardText: "message:<a b@c.com>",
					selectionText: "",
					collapsed: true,
					inCode: false,
					resolveTargetName: none,
				}),
				planLinkPaste({
					clipboardText: "https://x.com",
					selectionText: "beta",
					collapsed: false,
					inCode: true,
					resolveTargetName: none,
				}),
				planLinkPaste({
					clipboardText: "hello world",
					selectionText: "beta",
					collapsed: false,
					inCode: false,
					resolveTargetName: none,
				}),
				planLinkPaste({
					clipboardText: "https://x.com https://y.com",
					selectionText: "beta",
					collapsed: false,
					inCode: false,
					resolveTargetName: none,
				}),
			]).toStrictEqual([
				{kind: "insert", text: "message:<a b@c.com>", href: "message:%3Ca%20b@c.com%3E"},
				null,
				null,
				null,
			]);
		});
	});

	describe("applyLinkPaste", () => {
		it("wraps the selection, or splices the link in place of it", () => {
			expect([
				applyLinkPaste("alpha beta gamma", {start: 6, end: 10}, {kind: "format", href: "http://example.net/p"}),
				applyLinkPaste(
					"alpha  gamma",
					{start: 6, end: 6},
					{kind: "insert", text: "a<b", href: "https://x.com/?a=1&b=2"},
				),
			]).toStrictEqual([
				{html: 'alpha <a href="http://example.net/p">beta</a> gamma', caret: 10},
				{html: 'alpha <a href="https://x.com/?a=1&amp;b=2">a&lt;b</a> gamma', caret: 9},
			]);
		});
	});
});

describe("link render", () => {
	describe("renderLinks", () => {
		it("renders a stored anchor with upstream's contentLink markup", () => {
			expect(renderLinks('See <a href="https://example.com/a?b=1&amp;c=2">site</a> now')).toBe(
				'See <a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/a?b=1&amp;c=2">site</a> now',
			);
		});

		it("replaces stored attributes other than href", () => {
			expect(renderLinks("<a target='_self' class=\"x\" href='https://example.com/'>x</a>")).toBe(
				'<a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/">x</a>',
			);
		});

		it("keeps formatting nested inside the link", () => {
			expect(renderLinks('<a href="https://example.com/"><b>site</b></a>')).toBe(
				'<a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/"><b>site</b></a>',
			);
		});

		it("renders a mailto: or tel: anchor whose text is not an email or phone as plain text", () => {
			expect({
				mail: renderLinks('Mail <a href="mailto:a@b.com">mailme</a> tail'),
				nested: renderLinks('<a href="mailto:a@example.com"><b>mail</b></a>'),
				tel: renderLinks('Call <a href="tel:2015551234">me</a> now'),
			}).toStrictEqual({
				mail: "Mail mailme tail",
				nested: "<b>mail</b>",
				tel: "Call me now",
			});
		});

		it("keeps a mailto: or tel: anchor whose text is an email or phone, linking the text", () => {
			expect({
				mail: renderLinks('<a href="mailto:x@y.com">a@b.com</a>'),
				tel: renderLinks('<a href="tel:1">201-555-1234</a>'),
			}).toStrictEqual({
				mail: '<a class="contentLink" target="_blank" rel="noreferrer" href="mailto:a@b.com">a@b.com</a>',
				tel: '<a class="contentLink" target="_blank" rel="noreferrer" href="tel:201-555-1234">201-555-1234</a>',
			});
		});

		it("renders a javascript: link's text as plain text without the anchor", () => {
			expect(
				renderLinks('a <a href=" JavaScript:alert(1)">bad <b>x</b></a> b <a href="https://x.test/">y</a>'),
			).toBe(
				'a bad <b>x</b> b <a class="contentLink" target="_blank" rel="noreferrer" href="https://x.test/">y</a>',
			);
		});

		it("leaves text without anchors untouched", () => {
			const html = "Plain <b>bold</b> &amp; <abbr>abbr</abbr>";
			expect(renderLinks(html)).toBe(html);
		});
	});
});
