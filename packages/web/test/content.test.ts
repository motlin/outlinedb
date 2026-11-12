import {describe, expect, it} from "vite-plus/test";
import {internalLinkId, planContentLinkClick} from "../src/client/content-link-click.js";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {highlightHtml, highlightSearchMatches} from "../src/client/highlight-html.js";
import {cssBlock} from "./helpers/css-block.js";

describe("content link click", () =>
{
	const ORIGIN = "http://localhost:5175";
	const none =
	{
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		button: 0,
	};

	describe("internalLinkId", () =>
	{
		it("reads the item id from upstream's internal link and from this app's own links", () =>
		{
			expect([
				internalLinkId("https://workflowy.com/#/0123456789ab", ORIGIN),
				internalLinkId("https://beta.workflowy.com/#/0123456789ab?q=%23tag", ORIGIN),
				internalLinkId("http://localhost:5175/#/0123456789ab", ORIGIN),
				internalLinkId("/#/0123456789ab", ORIGIN),
			]).toStrictEqual(["0123456789ab", "0123456789ab", "0123456789ab", "0123456789ab"]);
		});

		it("ignores external links, links to Home, and unparsable hrefs", () =>
		{
			expect([
				internalLinkId("https://example.com/#/0123456789ab", ORIGIN),
				internalLinkId("https://workflowy.com/", ORIGIN),
				internalLinkId("mailto:alice@example.com", ORIGIN),
				internalLinkId("http://[bad", ORIGIN),
			]).toStrictEqual([null, null, null, null]);
		});
	});

	describe("planContentLinkClick", () =>
	{
		const WF = "https://workflowy.com/#/0123456789ab";
		const main =
		{
			isMac: true,
			inSidePane: false,
			origin: ORIGIN,
		};
		const side =
		{
			...main,
			inSidePane: true,
		};
		const loc =
		{
			id: "0123456789ab",
			query: null,
		};

		it("plans each link click the way upstream routes it", () =>
		{
			expect([
				planContentLinkClick(WF, none, main),
				planContentLinkClick(`${WF}?q=zzz`, none, main),
				planContentLinkClick("https://workflowy.com/#/", none, main),
				planContentLinkClick(
					WF,
					{
						...none,
						shiftKey: true,
					},
					main,
				),
				planContentLinkClick(
					WF,
					{
						...none,
						ctrlKey: true,
					},
					main,
				),
				planContentLinkClick(
					WF,
					{
						...none,
						metaKey: true,
					},
					main,
				),
				planContentLinkClick(
					WF,
					{
						...none,
						altKey: true,
					},
					{
						...main,
						isMac: false,
					},
				),
				planContentLinkClick(
					WF,
					{
						...none,
						metaKey: true,
						shiftKey: true,
					},
					main,
				),
				planContentLinkClick(WF, none, side),
				planContentLinkClick("search:%23foo", none, main),
				planContentLinkClick("https://example.com/page", none, main),
				planContentLinkClick(
					"https://example.com/page",
					{
						...none,
						metaKey: true,
					},
					main,
				),
				planContentLinkClick(
					WF,
					{
						...none,
						button: 1,
					},
					main,
				),
			]).toStrictEqual([
				{
					kind: "navigate",
					loc,
				},
				{
					kind: "navigate",
					loc:
					{
						id: "0123456789ab",
						query: "zzz",
					},
				},
				{
					kind: "navigate",
					loc:
					{
						id: null,
						query: null,
					},
				},
				{
					kind: "navigate",
					loc,
				},
				{
					kind: "open",
					href: WF,
				},
				{
					kind: "open_in_pane",
					loc,
				},
				{
					kind: "open_in_pane",
					loc,
				},
				{
					kind: "open",
					href: WF,
				},
				{
					kind: "navigate_pane",
					loc,
				},
				{
					kind: "search",
					query: "#foo",
				},
				{
					kind: "open",
					href: "https://example.com/page",
				},
				{
					kind: "open",
					href: "https://example.com/page",
				},
				null,
			]);
		});
	});
});

describe("content match", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

	describe("highlightHtml", () =>
	{
		it("wraps a plain-text range", () =>
		{
			expect(highlightHtml("Green apple pie", [[6, 11]])).toBe(
				'Green <span class="contentMatch">apple</span> pie',
			);
		});

		it("keeps existing markup around the range", () =>
		{
			expect(highlightHtml("a <b>apple</b> b", [[2, 7]])).toBe(
				'a <b><span class="contentMatch">apple</span></b> b',
			);
		});

		it("splits a range that crosses element boundaries", () =>
		{
			expect(highlightHtml("a<b>pp</b>le", [[0, 5]])).toBe(
				'<span class="contentMatch">a</span><b><span class="contentMatch">pp</span></b><span class="contentMatch">le</span>',
			);
		});

		it("counts an entity as one plain character", () =>
		{
			expect(highlightHtml("a &amp; apple", [[4, 9]])).toBe('a &amp; <span class="contentMatch">apple</span>');
		});

		it("wraps several ranges and leaves html without ranges untouched", () =>
		{
			expect(
				{
					several: highlightHtml("apple and apple", [
						[0, 5],
						[10, 15],
					]),
					none: highlightHtml("a <b>b</b>", []),
				},
			).toStrictEqual(
				{
					several: '<span class="contentMatch">apple</span> and <span class="contentMatch">apple</span>',
					none: "a <b>b</b>",
				},
			);
		});
	});

	describe("highlightSearchMatches", () =>
	{
		it("highlights the query's text matches on the rendered html's plain text", () =>
		{
			expect(
				{
					term: highlightSearchMatches('Green <span class="contentTag">#apple</span> pie', "apple"),
					empty: highlightSearchMatches("Green apple", ""),
					metaOnly: highlightSearchMatches("Green apple", "is:complete"),
					nestedKid: highlightSearchMatches("kid one", "parent > kid"),
					nestedParent: highlightSearchMatches("Parent with kids", "parent > kid"),
				},
			).toStrictEqual(
				{
					term: 'Green <span class="contentTag">#<span class="contentMatch">apple</span></span> pie',
					empty: "Green apple",
					metaOnly: "Green apple",
					nestedKid: '<span class="contentMatch">kid</span> one',
					nestedParent: 'Parent with <span class="contentMatch">kid</span>s',
				},
			);
		});
	});

	describe("highlightSearchMatches inside code", () =>
	{
		it("nests matches inside code and across its boundary like upstream", () =>
		{
			expect([
				highlightSearchMatches("plain <code>inline code</code> after", '"code after"'),
				highlightSearchMatches("search <code>findme zz</code> tail", "findme"),
			]).toStrictEqual([
				'plain <code>inline <span class="contentMatch">code</span></code><span class="contentMatch"> after</span>',
				'search <code><span class="contentMatch">findme</span> zz</code> tail',
			]);
		});
	});

	describe("contentMatch styles", () =>
	{
		it("colors matches only inside full matches and meta-only matches", () =>
		{
			expect(
				{
					fullMatch: cssBlock(styles, ".fullMatch :is(.content .contentMatch)"),
					doneFullMatch: cssBlock(styles, ".done .fullMatch :is(.content .contentMatch)"),
					selected: cssBlock(styles, ".project.addedToSelection .content .contentMatch"),
					tagDelete: cssBlock(styles, ".content .contentTag.contentTagDelete:hover .contentMatch"),
					meta: cssBlock(styles, ".project.metaMatches > .name > .content > .innerContentContainer"),
				},
			).toStrictEqual(
				{
					fullMatch:
					{
						"background-color": "var(--wf-background-found)",
					},
					doneFullMatch:
					{
						"background-color": "var(--wf-background-found)",
					},
					selected:
					{
						"background-color": "transparent",
					},
					tagDelete:
					{
						"background-color": "transparent",
					},
					meta:
					{
						"background-color": "var(--wf-background-found)",
					},
				},
			);
		});
	});
});
