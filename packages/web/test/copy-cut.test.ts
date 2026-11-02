// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {handleCopy, handleCut, handleTitleCopyCut, makeChildFilter, planCopy} from "../src/client/copy-cut.js";
import type {CopyCutDeps} from "../src/client/copy-cut.js";
import {planCut, cutBannerText, selectedMarkup} from "../src/client/copy-cut-plan.js";
import {clearCutRegistry, cutEntryFor} from "../src/client/cut-registry.js";
import {linkParents} from "../src/client/export-format.js";
import type {ExportItem} from "../src/client/export-format.js";
import {searchFilter} from "../src/client/search-filter.js";
import {highlightSearchMatches} from "../src/client/highlight-html.js";
import expected from "./fixtures/copy-format-expected.json" with {type: "json"};
import searchExpected from "./fixtures/copy-search-expected.json" with {type: "json"};

function mk(shortId: string, name: string, note = "", children: ExportItem[] = []): ExportItem
{
	return {
		id: `00000000-0000-0000-0000-${shortId}`,
		name,
		note,
		layoutMode: null,
		numberedStart: null,
		completed: false,
		parent: null,
		children,
	};
}

function fixture()
{
	const a1 = mk("e00f955fa992", "A1");
	const a2 = mk("0d8bb6069b31", "A2");
	const alpha = mk("1ccce67ee6ff", "Alpha", "", [a1, a2]);
	const bravo = mk("70fab4089100", "Bravo <b>bold</b>", "bravo note");
	const charlie = mk("9da451f0256e", "Charlie", "", [mk("c1c1c1c1c1c1", "C1")]);
	const root = mk("fa85028843d2", "CC fixture", "", [alpha, bravo, charlie]);
	linkParents([mk("ab03ee6d2ae0", "Home", "", [root])]);
	const all = [root, alpha, a1, a2, bravo, charlie, ...charlie.children];
	return {
		alpha,
		a1,
		a2,
		bravo,
		charlie,
		byId: new Map(all.map((item) => [item.id, item])),
	};
}

function fakeEvent()
{
	const data = new Map<string, string>();
	return {
		data,
		defaultPrevented: false,
		preventDefault()
		{
			this.defaultPrevented = true;
		},
		clipboardData:
		{
			setData(type: string, value: string)
			{
				data.set(type, value);
			},
		},
	};
}

function deps(selection: string[], overrides: Partial<CopyCutDeps> = {})
{
	const {alpha, byId} = fixture();
	const calls: string[] = [];
	const timers: (() => void)[] = [];
	const value: CopyCutDeps =
	{
		selected: () => selection,
		items: (ids) => ids.flatMap((id) => byId.get(id) ?? []),
		childFilter: makeChildFilter(
			{
				expandedIds: new Set([alpha.id]),
				zoomedId: null,
				showCompleted: false,
			},
		),
		canCut: () => true,
		childIds: (id) => byId.get(id)?.children.map((child) => child.id),
		deleteRows: (ids) =>
		{
			calls.push(`delete ${ids.join(",")}`);
		},
		clearSelection: () =>
		{
			calls.push("clear");
		},
		showBanner: (text) =>
		{
			calls.push(`banner ${text}`);
		},
		restore: () =>
		{
			calls.push("restore");
		},
		schedule: (run) =>
		{
			timers.push(run);
		},
		...overrides,
	};
	return {
		value,
		calls,
		flush: () =>
		{
			timers.splice(0).forEach((run) =>
			{
				run();
			});
		},
	};
}

const ids = fixture();
afterEach(() =>
{
	clearCutRegistry();
});

describe("copy", () =>
{
	it("puts the Formatted html and line-per-name text on the clipboard and prevents the default", () =>
	{
		const event = fakeEvent();
		const {value} = deps([ids.alpha.id, ids.charlie.id]);
		expect(handleCopy(event, value)).toBe(true);
		expect(
			{
				prevented: event.defaultPrevented,
				data: Object.fromEntries(event.data),
			},
		).toStrictEqual(
			{
				prevented: true,
				data:
				{
					"text/html": expected.alpha_charlie.html,
					"text/plain": expected.alpha_charlie.plain,
				},
			},
		);
	});

	it("does nothing without an item selection", () =>
	{
		const event = fakeEvent();
		const {value} = deps([]);
		expect(handleCopy(event, value)).toBe(false);
		expect(
			{
				prevented: event.defaultPrevented,
				size: event.data.size,
			},
		).toStrictEqual(
			{
				prevented: false,
				size: 0,
			},
		);
	});

	it("leaves collapsed rows without children and keeps rows in the order given", () =>
	{
		const {value} = deps([]);
		expect(planCopy(value.items([ids.a2.id, ids.bravo.id]), value.childFilter)).toStrictEqual(
			{
				html: expected.a2_bravo.html,
				text: expected.a2_bravo.plain,
			},
		);
	});
});

describe("cut", () =>
{
	it("copies, then deletes the rows and clears the selection after the timer, without a banner for a small cut", () =>
	{
		const event = fakeEvent();
		const {value, calls, flush} = deps([ids.a2.id, ids.bravo.id]);
		expect(handleCut(event, value)).toBe(true);
		expect(
			{
				html: event.data.get("text/html"),
				prevented: event.defaultPrevented,
				before: [...calls],
				cut: cutEntryFor("0d8bb6069b31")?.id,
			},
		).toStrictEqual(
			{
				html: expected.a2_bravo.html,
				prevented: true,
				before: [],
				cut: ids.a2.id,
			},
		);
		flush();
		expect(calls).toStrictEqual([`delete ${ids.a2.id},${ids.bravo.id}`, "clear"]);
	});

	it("opens the Restore banner for a cut of ten or more items", () =>
	{
		const many = Array.from(
			{
				length: 8,
			},
			(_, at) => mk(`00000000000${at}`, `Row ${at}`),
		);
		many[0] = mk("000000000000", "Row 0", "", [mk("0000000000aa", "Kid 1"), mk("0000000000bb", "Kid 2")]);
		const byId = new Map<string, ExportItem>();
		const walk = (item: ExportItem): void =>
		{
			byId.set(item.id, item);
			item.children.forEach(walk);
		};
		many.forEach(walk);
		const event = fakeEvent();
		const {value, calls, flush} = deps(
			many.map((item) => item.id),
			{
				items: (list) => list.flatMap((id) => byId.get(id) ?? []),
				childIds: (id) => byId.get(id)?.children.map((child) => child.id),
			},
		);
		handleCut(event, value);
		flush();
		expect(calls.at(-1)).toBe("banner 8 items and their descendantscut and added to clipboard. ");
	});

	it("does nothing when no selected row can be cut", () =>
	{
		const event = fakeEvent();
		const {value, calls, flush} = deps(
			[ids.a2.id],
			{
				canCut: () => false,
			},
		);
		expect(handleCut(event, value)).toBe(false);
		flush();
		expect(
			{
				prevented: event.defaultPrevented,
				calls,
			},
		).toStrictEqual(
			{
				prevented: false,
				calls: [],
			},
		);
	});

	it("returns when something else already handled the event", () =>
	{
		const event = fakeEvent();
		event.defaultPrevented = true;
		const {value, calls, flush} = deps([ids.a2.id]);
		expect(handleCut(event, value)).toBe(false);
		flush();
		expect(calls).toStrictEqual([]);
	});
});

describe("planCut", () =>
{
	it("is big with ten items counting descendants, and notes kids", () =>
	{
		const rows = Array.from(
			{
				length: 8,
			},
			(_, at) => `r${at}`,
		);
		const kids = (id: string) => (id === "r0" ? ["k1", "k2"] : []);
		expect(planCut(rows, () => true, kids)).toStrictEqual(
			{
				ids: rows,
				big: true,
				hasKids: true,
			},
		);
		expect(planCut(["a", "b", "c"], () => true)).toStrictEqual(
			{
				ids: ["a", "b", "c"],
				big: false,
				hasKids: false,
			},
		);
		expect(planCut(["a", "b"], (id) => id === "a")).toStrictEqual(
			{
				ids: ["a"],
				big: false,
				hasKids: false,
			},
		);
	});

	it("words the banner", () =>
	{
		expect(cutBannerText(2, false)).toBe("2 items cut and added to clipboard. ");
	});
});

describe("zoom-title copy and cut", () =>
{
	const title =
	{
		stored: "Bravo <b>bold</b>",
		start: 2,
		end: 8,
		text: "avo bo",
	};

	it("writes the raw markup of the selected range and plain text", () =>
	{
		const event = fakeEvent();
		const removed = vi.fn<() => void>();
		expect(handleTitleCopyCut(event, false, title, removed)).toBe(true);
		expect(
			{
				data: Object.fromEntries(event.data),
				prevented: event.defaultPrevented,
				removed: removed.mock.calls.length,
			},
		).toStrictEqual(
			{
				data:
				{
					"text/plain": "avo bo",
					"text/html": "avo <b>bo</b>",
				},
				prevented: true,
				removed: 0,
			},
		);
	});

	it("removes the range on cut", () =>
	{
		const event = fakeEvent();
		const removed = vi.fn<() => void>();
		handleTitleCopyCut(event, true, title, removed);
		expect(removed).toHaveBeenCalledOnce();
	});

	it("leaves rows outside the title and collapsed selections native", () =>
	{
		const event = fakeEvent();
		expect([
			handleTitleCopyCut(event, false, null, vi.fn<() => void>()),
			handleTitleCopyCut(
				event,
				false,
				{
					...title,
					end: 2,
				},
				vi.fn<() => void>(),
			),
		]).toStrictEqual([false, false]);
		expect(
			{
				prevented: event.defaultPrevented,
				size: event.data.size,
			},
		).toStrictEqual(
			{
				prevented: false,
				size: 0,
			},
		);
	});

	it("cuts the markup substring", () =>
	{
		expect(selectedMarkup("Bravo <b>bold</b>", 2, 8)).toBe("avo <b>bo</b>");
	});
});

describe("search-mode copy", () =>
{
	const plainRow = mk("f858f5ef34bf", "Plain", "plain note", [mk("1dffea89a928", "P1"), mk("2dffea89a929", "P2")]);
	linkParents([mk("b0adce4a2894", "Home", "", [plainRow])]);
	const [p1, p2] = plainRow.children as [ExportItem, ExportItem];
	const result =
	{
		matchIds: [p1.id],
		nameMatchIds: [p1.id],
		noteMatchIds: [],
		metaMatchIds: [],
		ancestorIds: [plainRow.id],
		halfExpandedIds: [plainRow.id],
		rootHalfExpanded: false,
		completedMatchCount: 0,
		matchCount: 1,
		revealsCompleted: false,
	};

	it("copies only the matching descendants of a search-expanded row, with highlights", () =>
	{
		const search = searchFilter(result, new Set(), new Map());
		const childFilter = makeChildFilter(
			{
				expandedIds: new Set(),
				zoomedId: null,
				showCompleted: false,
				search,
			},
		);
		const options =
		{
			renderName: (html: string) => highlightSearchMatches(html, "P1"),
			renderNote: (html: string) => highlightSearchMatches(html, "P1"),
		};
		expect(planCopy([plainRow], childFilter, options)).toStrictEqual(
			{
				html: searchExpected.html,
				text: searchExpected.text,
			},
		);
		expect(p2.name).toBe("P2");
	});

	it("honours a search expansion override that collapses the row", () =>
	{
		const search = searchFilter(result, new Set(), new Map([[plainRow.id, false]]));
		const childFilter = makeChildFilter(
			{
				expandedIds: new Set(),
				zoomedId: null,
				showCompleted: false,
				search,
			},
		);
		expect(childFilter(plainRow)).toStrictEqual([]);
	});
});
