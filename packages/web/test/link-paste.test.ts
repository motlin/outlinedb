import {describe, expect, it} from "vite-plus/test";
import {applyLinkPaste, planLinkPaste} from "../src/client/link-paste.js";

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
			href === "https://workflowy.com/#/abc" ? "Target" : href === "https://workflowy.com/#/blank" ? "" : null;
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
