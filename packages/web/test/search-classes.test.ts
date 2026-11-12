import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import type {TreeSearchResult} from "../src/server/tree-search.js";
import
{
	outlineViewClassName,
	rootSearchClasses,
	searchClasses,
	shouldRenderAddChildButton,
} from "../src/client/search-classes.js";
import {searchFilter} from "../src/client/search-filter.js";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8").replaceAll(
	/\/\*[\s\S]*?\*\//gu,
	"",
);

// Zoom root > Fruit apple > {Green apple pie, Cherry tart > deep apple leaf, Banana}; Notes has a "zebra" note.
const appleResult: TreeSearchResult =
{
	matchIds: ["fruit", "pie", "leaf"],
	nameMatchIds: ["fruit", "pie", "leaf"],
	noteMatchIds: [],
	metaMatchIds: [],
	ancestorIds: ["fruit", "cherry"],
	halfExpandedIds: ["fruit"],
	rootHalfExpanded: true,
	completedMatchCount: 0,
	matchCount: 3,
	revealsCompleted: false,
};

const apple = searchFilter(appleResult, new Set(), new Map());

describe("searchClasses", () =>
{
	it("marks a leaf name match as a terminal full match", () =>
	{
		expect(
			searchClasses(
				{
					id: "pie",
					parentId: "fruit",
				},
				apple,
			),
		).toStrictEqual(
			{
				project: ["matches", "terminalMatch"],
				name: ["fullMatch", "matches"],
				note: [],
			},
		);
	});

	it("marks an open half-expanded matching ancestor as half-open, not terminal", () =>
	{
		expect(
			searchClasses(
				{
					id: "fruit",
					parentId: "root",
				},
				apple,
			),
		).toStrictEqual(
			{
				project: ["matches", "halfExpanded", "half-open"],
				name: ["fullMatch", "matches"],
				note: [],
			},
		);
	});

	it("leaves a non-matching ancestor unclassed", () =>
	{
		expect(
			searchClasses(
				{
					id: "cherry",
					parentId: "fruit",
				},
				apple,
			),
		).toStrictEqual(
			{
				project: [],
				name: [],
				note: [],
			},
		);
	});

	it("drops halfExpanded and half-open on a collapsed half-expanded row", () =>
	{
		const collapsed = searchFilter(appleResult, new Set(), new Map([["fruit", false]]));
		expect(
			searchClasses(
				{
					id: "fruit",
					parentId: "root",
				},
				collapsed,
			).project,
		).toStrictEqual(["matches"]);
	});

	it("drops halfExpanded once the row is fully expanded and marks shown non-matches as terminal matches", () =>
	{
		const full = searchFilter(appleResult, new Set(), new Map([["fruit", true]]));
		expect(
			{
				fruit: searchClasses(
					{
						id: "fruit",
						parentId: "root",
					},
					full,
				).project,
				banana: searchClasses(
					{
						id: "banana",
						parentId: "fruit",
					},
					full,
				),
				cherry: searchClasses(
					{
						id: "cherry",
						parentId: "fruit",
					},
					full,
				),
			},
		).toStrictEqual(
			{
				fruit: ["matches"],
				banana:
				{
					project: ["matches", "terminalMatch"],
					name: [],
					note: [],
				},
				cherry:
				{
					project: ["matches", "terminalMatch"],
					name: [],
					note: [],
				},
			},
		);
	});

	it("marks a row created during the search as a terminal match without fullMatch", () =>
	{
		const created = searchFilter(appleResult, new Set(["new"]), new Map());
		expect(
			searchClasses(
				{
					id: "new",
					parentId: "fruit",
				},
				created,
			),
		).toStrictEqual(
			{
				project: ["matches", "terminalMatch"],
				name: [],
				note: [],
			},
		);
	});

	it("marks an operator-only match as metaMatches", () =>
	{
		const hasNote = searchFilter(
			{
				...appleResult,
				matchIds: ["noted"],
				nameMatchIds: [],
				metaMatchIds: ["noted"],
				ancestorIds: [],
			},
			new Set(),
			new Map(),
		);
		expect(
			searchClasses(
				{
					id: "noted",
					parentId: "root",
				},
				hasNote,
			),
		).toStrictEqual(
			{
				project: ["matches", "terminalMatch", "metaMatches"],
				name: ["fullMatch"],
				note: [],
			},
		);
	});

	it("marks a note match on the note", () =>
	{
		const zebra = searchFilter(
			{
				...appleResult,
				matchIds: ["fruit"],
				nameMatchIds: [],
				noteMatchIds: ["fruit"],
				ancestorIds: [],
				halfExpandedIds: [],
			},
			new Set(),
			new Map(),
		);
		expect(
			searchClasses(
				{
					id: "fruit",
					parentId: "root",
				},
				zebra,
			),
		).toStrictEqual(
			{
				project: ["matches", "terminalMatch"],
				name: ["fullMatch"],
				note: ["matches", "fullMatch"],
			},
		);
	});

	it("gives no classes outside a search", () =>
	{
		expect(
			searchClasses(
				{
					id: "pie",
					parentId: "fruit",
				},
				null,
			),
		).toStrictEqual(
			{
				project: [],
				name: [],
				note: [],
			},
		);
	});
});

describe("rootSearchClasses", () =>
{
	it("marks the zoom root half-expanded when the search says so", () =>
	{
		expect(
			{
				half: rootSearchClasses(apple),
				whole: rootSearchClasses(
					searchFilter(
						{
							...appleResult,
							rootHalfExpanded: false,
						},
						new Set(),
						new Map(),
					),
				),
				none: rootSearchClasses(null),
			},
		).toStrictEqual(
			{
				half: ["half-open", "halfExpanded"],
				whole: [],
				none: [],
			},
		);
	});
});

describe("page and add button during a search", () =>
{
	it("adds searching to the page and suppresses the add-child button", () =>
	{
		expect(
			{
				searchingPage: outlineViewClassName("apple"),
				idlePage: outlineViewClassName(""),
				addWhileSearching: shouldRenderAddChildButton("apple"),
				addIdle: shouldRenderAddChildButton(""),
			},
		).toStrictEqual(
			{
				searchingPage: "outline-view searching",
				idlePage: "outline-view",
				addWhileSearching: false,
				addIdle: true,
			},
		);
	});

	it("opens matched notes to full height", () =>
	{
		expect(
			{
				note: cssBlock(
					styles,
					".page.searching .notes.matches > .content, .outline-view.searching .notes.matches > .content",
				),
			},
		).toStrictEqual(
			{
				note:
				{
					overflow: "visible",
					display: "block",
					"max-height": "none",
					height: "auto",
				},
			},
		);
	});
});
