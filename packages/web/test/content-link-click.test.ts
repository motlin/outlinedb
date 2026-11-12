import {describe, expect, it} from "vite-plus/test";
import {internalLinkId, planContentLinkClick} from "../src/client/content-link-click.js";

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
