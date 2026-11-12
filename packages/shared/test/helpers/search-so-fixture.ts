import type {SearchItem} from "../../src/search/index.js";

export function searchItem(nameHtml: string, noteHtml = "", overrides: Partial<SearchItem> = {}): SearchItem
{
	return {
		id: nameHtml,
		nameHtml,
		noteHtml,
		completedAt: null,
		createdAt: null,
		modifiedAt: null,
		layoutMode: null,
		childCount: 0,
		isMirror: false,
		isBacklink: false,
		ancestorCompleted: false,
		...overrides,
	};
}

// The 15 descendants of the upstream "SO root" fixture (dumps/search-operators-live-results.txt).
export const SO_ROWS: SearchItem[] = [
	searchItem("Alpha apple pie", "zebra note"),
	searchItem("applesauce jar"),
	searchItem('Meeting <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>'),
	searchItem('Past <time startYear="2026" startMonth="9" startDay="15">Tue, Sep 15, 2026</time>'),
	searchItem('Future <time startYear="2026" startMonth="12" startDay="25">Fri, Dec 25, 2026</time>'),
	searchItem("Tagged #soTag item"),
	searchItem("Mention @soPerson item"),
	searchItem("<b>Bold word</b> here"),
	searchItem('<span class="colored c-red">red text</span> line'),
	searchItem('<span class="colored bc-yellow">hl text</span> line'),
	searchItem('Link <a href="https://example.com/">example</a>'),
	searchItem(
		"Parent with kids",
		"",
		{
			childCount: 1,
		},
	),
	searchItem("kid one"),
	searchItem(
		"Todo list",
		"",
		{
			layoutMode: "todo",
			childCount: 1,
		},
	),
	searchItem("todo kid"),
];

export const SO_PLAIN_NAMES = [
	"Alpha apple pie",
	"applesauce jar",
	"Meeting Thu, Oct 1, 2026",
	"Past Tue, Sep 15, 2026",
	"Future Fri, Dec 25, 2026",
	"Tagged #soTag item",
	"Mention @soPerson item",
	"Bold word here",
	"red text line",
	"hl text line",
	"Link example",
	"Parent with kids",
	"kid one",
	"Todo list",
	"todo kid",
];
