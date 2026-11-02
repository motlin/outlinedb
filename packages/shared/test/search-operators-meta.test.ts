import {describe, expect, it} from "vite-plus/test";
import {parseQuery} from "../src/search/index.js";
import {SO_PLAIN_NAMES, SO_ROWS, searchItem} from "./helpers/search-so-fixture.js";

const ROWS = [
	...SO_ROWS,
	searchItem(
		"Done item",
		"",
		{
			completedAt: 1_760_000_000_000,
		},
	),
];
const NAMES = [...SO_PLAIN_NAMES, "Done item"];

function matchingNames(query: string): string[]
{
	const parsed = parseQuery(query);
	return ROWS.flatMap((row, index) => (parsed.matches(row).matches ? [NAMES[index]!] : []));
}

const META_MATCH =
{
	matches: true,
	nameMatches: false,
	noteMatches: false,
	metaMatches: true,
};

describe("has: operators", () =>
{
	it("has:note matches non-empty notes as a meta match", () =>
	{
		expect(matchingNames("has:note")).toStrictEqual(["Alpha apple pie"]);
		expect(parseQuery("has:note").matches(ROWS[0]!)).toStrictEqual(META_MATCH);
	});

	it("-has:note matches every row without a note", () =>
	{
		expect(matchingNames("-has:note")).toStrictEqual(NAMES.slice(1));
	});

	it("has:children matches rows with children", () =>
	{
		expect(matchingNames("has:children")).toStrictEqual(["Parent with kids", "Todo list"]);
	});

	it("has:date matches a <time> in the name or note", () =>
	{
		expect(matchingNames("has:date")).toStrictEqual([
			"Meeting Thu, Oct 1, 2026",
			"Past Tue, Sep 15, 2026",
			"Future Fri, Dec 25, 2026",
		]);
	});

	it("is case-insensitive", () =>
	{
		expect(matchingNames("HAS:Note")).toStrictEqual(["Alpha apple pie"]);
	});
});

describe("is: operators", () =>
{
	it("is:todo and is:task match todo and check layouts", () =>
	{
		expect(matchingNames("is:todo")).toStrictEqual(["Todo list"]);
		expect(matchingNames("is:task")).toStrictEqual(["Todo list"]);
		expect(
			parseQuery("is:todo").matches(
				searchItem(
					"x",
					"",
					{
						layoutMode: "check",
					},
				),
			).matches,
		).toBe(true);
	});

	it("is:complete matches completed items and reveals completed", () =>
	{
		expect(matchingNames("is:complete")).toStrictEqual(["Done item"]);
		expect(parseQuery("is:complete").revealsCompleted()).toBe(true);
		expect(parseQuery("has:note").revealsCompleted()).toBe(false);
	});

	it("-is:complete is false under a completed ancestor", () =>
	{
		const child = searchItem(
			"child",
			"",
			{
				ancestorCompleted: true,
			},
		);
		expect(parseQuery("-is:complete").matches(child).matches).toBe(false);
		expect(parseQuery("-is:complete").matches(ROWS[0]!).matches).toBe(true);
	});

	it("is:incomplete is the local alias of -is:complete", () =>
	{
		expect(matchingNames("is:incomplete")).toStrictEqual(SO_PLAIN_NAMES);
		expect(
			parseQuery("is:incomplete").matches(
				searchItem(
					"child",
					"",
					{
						ancestorCompleted: true,
					},
				),
			).matches,
		).toBe(false);
	});

	it("matches layout modes", () =>
	{
		const cases: [string, string][] = [
			["is:divider", "divider"],
			["is:code-block", "code-block"],
			["is:quote", "quote-block"],
			["is:h1", "h1"],
			["text:h2", "h2"],
			["text:h3", "h3"],
			["is:paragraph", "p"],
		];
		for (const [query, layoutMode] of cases)
		{
			expect(
				parseQuery(query).matches(
					searchItem(
						"x",
						"",
						{
							layoutMode,
						},
					),
				).matches,
			).toBe(true);
			expect(matchingNames(query)).toStrictEqual([]);
		}
	});

	it("is:mirror matches mirrors", () =>
	{
		expect(
			parseQuery("is:mirror").matches(
				searchItem(
					"x",
					"",
					{
						isMirror: true,
					},
				),
			).matches,
		).toBe(true);
		expect(matchingNames("is:mirror")).toStrictEqual([]);
	});
});

describe("text: and highlight: operators", () =>
{
	it("text:bold matches <b> markup", () =>
	{
		expect(matchingNames("text:bold")).toStrictEqual(["Bold word here"]);
	});

	it("matches the other inline formats in the name or note", () =>
	{
		const cases: [string, string][] = [
			["text:italic", "<i>x</i>"],
			["text:underline", "<u>x</u>"],
			["text:strikethrough", "<s>x</s>"],
			["text:code", "<code>x</code>"],
		];
		for (const [query, html] of cases)
		{
			expect(parseQuery(query).matches(searchItem("plain", html)).matches).toBe(true);
			expect(matchingNames(query)).toStrictEqual([]);
		}
	});

	it("text:<color> and text:colored match coloured spans", () =>
	{
		expect(matchingNames("text:red")).toStrictEqual(["red text line"]);
		expect(matchingNames("text:colored")).toStrictEqual(["red text line"]);
		expect(matchingNames("text:blue")).toStrictEqual([]);
	});

	it("highlight:<color> and text:highlighted match highlights", () =>
	{
		expect(matchingNames("highlight:yellow")).toStrictEqual(["hl text line"]);
		expect(matchingNames("text:highlighted")).toStrictEqual(["hl text line"]);
		expect(matchingNames("text:yellow")).toStrictEqual([]);
	});

	it("bare highlight: matches nothing", () =>
	{
		expect(matchingNames("highlight:")).toStrictEqual([]);
	});
});

describe("link:, in:note: and id: operators", () =>
{
	it("link: matches hrefs by escaped regexp, bare link: matches any link", () =>
	{
		for (const query of ["link:", "link:example", "link:example.com", "link:EXAMPLE"])
		{
			expect(matchingNames(query)).toStrictEqual(["Link example"]);
		}
		expect(matchingNames("link:example.org")).toStrictEqual([]);
		expect(matchingNames("link:exampl.")).toStrictEqual([]);
	});

	it('in:note:"words" matches a prefix in the note only, with upstream\'s token grammar', () =>
	{
		expect(matchingNames('in:note:"zebra"')).toStrictEqual(["Alpha apple pie"]);
		expect(parseQuery('in:note:"zebra"').matches(ROWS[0]!)).toStrictEqual(
			{
				matches: true,
				nameMatches: false,
				noteMatches: true,
				metaMatches: false,
			},
		);
		for (const query of ['in:note:"zeb"', 'in:note:"not"', 'in:note:"zebra no"'])
		{
			expect(matchingNames(query)).toStrictEqual(["Alpha apple pie"]);
		}
		expect(matchingNames("in:note:zeb")).toStrictEqual([]);
		expect(matchingNames("in:note:\u201Czebra\u201D")).toStrictEqual([]);
		expect(matchingNames('in:note:"zebra note"')).toStrictEqual(["Alpha apple pie"]);
		expect(matchingNames('in:note:"apple"')).toStrictEqual([]);
		expect(matchingNames('in:note:"zebra note" apple')).toStrictEqual(["Alpha apple pie"]);
	});

	it("id: matches an id prefix or the 12-hex short id", () =>
	{
		const row = searchItem(
			"x",
			"",
			{
				id: "1c2d3e4f-0000-4000-8000-a1b2c3d4e5f6",
			},
		);
		expect(parseQuery("id:1c2d").matches(row)).toStrictEqual(META_MATCH);
		expect(parseQuery("id:a1b2c3d4e5f6").matches(row).matches).toBe(true);
		expect(parseQuery("id:A1B2C3D4E5F6").matches(row).matches).toBe(true);
		expect(parseQuery("id:ffff").matches(row).matches).toBe(false);
	});
});

describe("is:backlink and in:backlink: operators", () =>
{
	const backlink = searchItem(
		"Source S",
		"",
		{
			isMirror: true,
			isBacklink: true,
		},
	);
	const plain = searchItem("Source S");

	it("is:backlink is a meta match on backlink items only", () =>
	{
		expect(parseQuery("is:backlink").matches(backlink)).toStrictEqual(
			{
				matches: true,
				nameMatches: false,
				noteMatches: false,
				metaMatches: true,
			},
		);
		expect(parseQuery("is:backlink").matches(plain).matches).toBe(false);
	});

	it('in:backlink:"Sou" matches a backlink item by name prefix, not a plain item', () =>
	{
		expect(parseQuery('in:backlink:"Sou"').matches(backlink)).toStrictEqual(
			{
				matches: true,
				nameMatches: true,
				noteMatches: false,
				metaMatches: false,
			},
		);
		expect(parseQuery('in:backlink:"Sou"').matches(plain).matches).toBe(false);
	});

	it("an unquoted in:backlink:Source is a plain term", () =>
	{
		expect(parseQuery("in:backlink:Source").matches(backlink).matches).toBe(false);
		expect(parseQuery("in:backlink:Source").matches(searchItem("in:backlink:Source")).matches).toBe(true);
	});
});

describe("has:file, has:image, has:video and has:tweet", () =>
{
	const FILE_ROWS = [
		searchItem(
			"",
			"",
			{
				id: "png",
				fileType: "image/png",
			},
		),
		searchItem(
			"",
			"",
			{
				id: "pdf",
				fileType: "application/pdf",
			},
		),
		searchItem(
			"",
			"",
			{
				id: "mp4",
				fileType: "video/mp4",
			},
		),
		searchItem("plain"),
		searchItem(
			'Watch <a href="https://youtu.be/abc123">clip</a>',
			"",
			{
				id: "youtube",
			},
		),
		searchItem(
			'Tweet <a href="https://x.com/alice/status/42">t</a>',
			"",
			{
				id: "tweet",
			},
		),
		searchItem(
			"youtube.com/watch?v=nolink",
			"",
			{
				id: "bare-youtube",
			},
		),
	];

	function matchingIds(query: string): string[]
	{
		const parsed = parseQuery(query);
		return FILE_ROWS.flatMap((row) => (parsed.matches(row).matches ? [row.id] : []));
	}

	it("has:file matches an attachment that is not an image", () =>
	{
		expect(matchingIds("has:file")).toStrictEqual(["pdf", "mp4"]);
	});

	it("has:image matches an image attachment", () =>
	{
		expect(matchingIds("has:image")).toStrictEqual(["png"]);
	});

	it("has:video matches a YouTube link in the name, not an attachment", () =>
	{
		expect(matchingIds("has:video")).toStrictEqual(["youtube", "bare-youtube"]);
	});

	it("has:tweet matches a tweet link in the name", () =>
	{
		expect(matchingIds("has:tweet")).toStrictEqual(["tweet"]);
	});

	it("reports a meta match and negates", () =>
	{
		expect([parseQuery("has:image").matches(FILE_ROWS[0]!), matchingIds("-has:file")]).toStrictEqual([
			META_MATCH,
			["png", "plain", "youtube", "tweet", "bare-youtube"],
		]);
	});
});
