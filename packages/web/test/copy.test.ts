// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi, beforeAll} from "vite-plus/test";
import {handleCopy, handleCut, handleTitleCopyCut, makeChildFilter, planCopy} from "../src/client/copy-cut.js";
import type {CopyCutDeps} from "../src/client/copy-cut.js";
import {planCut, cutBannerText, selectedMarkup} from "../src/client/copy-cut-plan.js";
import {clearCutRegistry, cutEntryFor} from "../src/client/cut-registry.js";
import {linkParents, copyItemsHtml, copyItemsPlainText} from "../src/client/export-format.js";
import type {ExportItem, ChildAccessor} from "../src/client/export-format.js";
import {searchFilter} from "../src/client/search-filter.js";
import {highlightSearchMatches} from "../src/client/highlight-html.js";
import expected from "./fixtures/copy-format-expected.json" with {type: "json"};
import searchExpected from "./fixtures/copy-search-expected.json" with {type: "json"};
import deepExpected from "./fixtures/copy-format-deep-expected.json" with {type: "json"};
import type {Root} from "react-dom/client";
import {act, createElement, useEffect} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {useCopyLink} from "../src/client/hooks/use-item-actions.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("copy cut", () => {
	function mk(shortId: string, name: string, note = "", children: ExportItem[] = []): ExportItem {
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

	function fixture() {
		const a1 = mk("e00f955fa992", "A1");
		const a2 = mk("0d8bb6069b31", "A2");
		const alpha = mk("1ccce67ee6ff", "Alpha", "", [a1, a2]);
		const bravo = mk("70fab4089100", "Bravo <b>bold</b>", "bravo note");
		const charlie = mk("9da451f0256e", "Charlie", "", [mk("c1c1c1c1c1c1", "C1")]);
		const root = mk("fa85028843d2", "CC fixture", "", [alpha, bravo, charlie]);
		linkParents([mk("ab03ee6d2ae0", "Home", "", [root])]);
		const all = [root, alpha, a1, a2, bravo, charlie, ...charlie.children];
		return {alpha, a1, a2, bravo, charlie, byId: new Map(all.map((item) => [item.id, item]))};
	}

	function fakeEvent() {
		const data = new Map<string, string>();
		return {
			data,
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
			clipboardData: {
				setData(type: string, value: string) {
					data.set(type, value);
				},
			},
		};
	}

	function deps(selection: string[], overrides: Partial<CopyCutDeps> = {}) {
		const {alpha, byId} = fixture();
		const calls: string[] = [];
		const timers: (() => void)[] = [];
		const value: CopyCutDeps = {
			selected: () => selection,
			items: (ids) => ids.flatMap((id) => byId.get(id) ?? []),
			childFilter: makeChildFilter({expandedIds: new Set([alpha.id]), zoomedId: null, showCompleted: false}),
			canCut: () => true,
			childIds: (id) => byId.get(id)?.children.map((child) => child.id),
			deleteRows: (ids) => {
				calls.push(`delete ${ids.join(",")}`);
			},
			clearSelection: () => {
				calls.push("clear");
			},
			showBanner: (text) => {
				calls.push(`banner ${text}`);
			},
			restore: () => {
				calls.push("restore");
			},
			schedule: (run) => {
				timers.push(run);
			},
			...overrides,
		};
		return {
			value,
			calls,
			flush: () => {
				timers.splice(0).forEach((run) => {
					run();
				});
			},
		};
	}

	const ids = fixture();
	afterEach(() => {
		clearCutRegistry();
	});

	describe("copy", () => {
		it("puts the Formatted html and line-per-name text on the clipboard and prevents the default", () => {
			const event = fakeEvent();
			const {value} = deps([ids.alpha.id, ids.charlie.id]);
			expect(handleCopy(event, value)).toBe(true);
			expect({prevented: event.defaultPrevented, data: Object.fromEntries(event.data)}).toStrictEqual({
				prevented: true,
				data: {"text/html": expected.alpha_charlie.html, "text/plain": expected.alpha_charlie.plain},
			});
		});

		it("does nothing without an item selection", () => {
			const event = fakeEvent();
			const {value} = deps([]);
			expect(handleCopy(event, value)).toBe(false);
			expect({prevented: event.defaultPrevented, size: event.data.size}).toStrictEqual({
				prevented: false,
				size: 0,
			});
		});

		it("leaves collapsed rows without children and keeps rows in the order given", () => {
			const {value} = deps([]);
			expect(planCopy(value.items([ids.a2.id, ids.bravo.id]), value.childFilter)).toStrictEqual({
				html: expected.a2_bravo.html,
				text: expected.a2_bravo.plain,
			});
		});
	});

	describe("cut", () => {
		it("copies, then deletes the rows and clears the selection after the timer, without a banner for a small cut", () => {
			const event = fakeEvent();
			const {value, calls, flush} = deps([ids.a2.id, ids.bravo.id]);
			expect(handleCut(event, value)).toBe(true);
			expect({
				html: event.data.get("text/html"),
				prevented: event.defaultPrevented,
				before: [...calls],
				cut: cutEntryFor("0d8bb6069b31")?.id,
			}).toStrictEqual({html: expected.a2_bravo.html, prevented: true, before: [], cut: ids.a2.id});
			flush();
			expect(calls).toStrictEqual([`delete ${ids.a2.id},${ids.bravo.id}`, "clear"]);
		});

		it("opens the Restore banner for a cut of ten or more items", () => {
			const many = Array.from({length: 8}, (_, at) => mk(`00000000000${at}`, `Row ${at}`));
			many[0] = mk("000000000000", "Row 0", "", [mk("0000000000aa", "Kid 1"), mk("0000000000bb", "Kid 2")]);
			const byId = new Map<string, ExportItem>();
			const walk = (item: ExportItem): void => {
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

		it("does nothing when no selected row can be cut", () => {
			const event = fakeEvent();
			const {value, calls, flush} = deps([ids.a2.id], {canCut: () => false});
			expect(handleCut(event, value)).toBe(false);
			flush();
			expect({prevented: event.defaultPrevented, calls}).toStrictEqual({prevented: false, calls: []});
		});

		it("returns when something else already handled the event", () => {
			const event = fakeEvent();
			event.defaultPrevented = true;
			const {value, calls, flush} = deps([ids.a2.id]);
			expect(handleCut(event, value)).toBe(false);
			flush();
			expect(calls).toStrictEqual([]);
		});
	});

	describe("planCut", () => {
		it("is big with ten items counting descendants, and notes kids", () => {
			const rows = Array.from({length: 8}, (_, at) => `r${at}`);
			const kids = (id: string) => (id === "r0" ? ["k1", "k2"] : []);
			expect(planCut(rows, () => true, kids)).toStrictEqual({ids: rows, big: true, hasKids: true});
			expect(planCut(["a", "b", "c"], () => true)).toStrictEqual({
				ids: ["a", "b", "c"],
				big: false,
				hasKids: false,
			});
			expect(planCut(["a", "b"], (id) => id === "a")).toStrictEqual({ids: ["a"], big: false, hasKids: false});
		});

		it("words the banner", () => {
			expect(cutBannerText(2, false)).toBe("2 items cut and added to clipboard. ");
		});
	});

	describe("zoom-title copy and cut", () => {
		const title = {stored: "Bravo <b>bold</b>", start: 2, end: 8, text: "avo bo"};

		it("writes the raw markup of the selected range and plain text", () => {
			const event = fakeEvent();
			const removed = vi.fn<() => void>();
			expect(handleTitleCopyCut(event, false, title, removed)).toBe(true);
			expect({
				data: Object.fromEntries(event.data),
				prevented: event.defaultPrevented,
				removed: removed.mock.calls.length,
			}).toStrictEqual({
				data: {"text/plain": "avo bo", "text/html": "avo <b>bo</b>"},
				prevented: true,
				removed: 0,
			});
		});

		it("removes the range on cut", () => {
			const event = fakeEvent();
			const removed = vi.fn<() => void>();
			handleTitleCopyCut(event, true, title, removed);
			expect(removed).toHaveBeenCalledOnce();
		});

		it("leaves rows outside the title and collapsed selections native", () => {
			const event = fakeEvent();
			expect([
				handleTitleCopyCut(event, false, null, vi.fn<() => void>()),
				handleTitleCopyCut(event, false, {...title, end: 2}, vi.fn<() => void>()),
			]).toStrictEqual([false, false]);
			expect({prevented: event.defaultPrevented, size: event.data.size}).toStrictEqual({
				prevented: false,
				size: 0,
			});
		});

		it("cuts the markup substring", () => {
			expect(selectedMarkup("Bravo <b>bold</b>", 2, 8)).toBe("avo <b>bo</b>");
		});
	});

	describe("search-mode copy", () => {
		const plainRow = mk("f858f5ef34bf", "Plain", "plain note", [
			mk("1dffea89a928", "P1"),
			mk("2dffea89a929", "P2"),
		]);
		linkParents([mk("b0adce4a2894", "Home", "", [plainRow])]);
		const [p1, p2] = plainRow.children as [ExportItem, ExportItem];
		const result = {
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

		it("copies only the matching descendants of a search-expanded row, with highlights", () => {
			const search = searchFilter(result, new Set(), new Map());
			const childFilter = makeChildFilter({expandedIds: new Set(), zoomedId: null, showCompleted: false, search});
			const options = {
				renderName: (html: string) => highlightSearchMatches(html, "P1"),
				renderNote: (html: string) => highlightSearchMatches(html, "P1"),
			};
			expect(planCopy([plainRow], childFilter, options)).toStrictEqual({
				html: searchExpected.html,
				text: searchExpected.text,
			});
			expect(p2.name).toBe("P2");
		});

		it("honours a search expansion override that collapses the row", () => {
			const search = searchFilter(result, new Set(), new Map([[plainRow.id, false]]));
			const childFilter = makeChildFilter({expandedIds: new Set(), zoomedId: null, showCompleted: false, search});
			expect(childFilter(plainRow)).toStrictEqual([]);
		});
	});
});

describe("copy format", () => {
	interface Options {
		note?: string;
		layoutMode?: string;
		completed?: boolean;
	}

	function mk(shortId: string, name: string, options: Options = {}, children: ExportItem[] = []): ExportItem {
		return {
			id: `00000000-0000-0000-0000-${shortId}`,
			name,
			note: options.note ?? "",
			layoutMode: options.layoutMode ?? null,
			numberedStart: null,
			completed: options.completed ?? false,
			parent: null,
			children,
		};
	}

	/** Upstream's copy childFilter: only expanded rows and the zoom root contribute children. */
	function filterFor(expanded: Set<string>, zoomId?: string): ChildAccessor {
		return (item) => (item.id === zoomId || expanded.has(item.id) ? item.children : []);
	}

	function ccFixture() {
		const a1 = mk("e00f955fa992", "A1");
		const a2 = mk("0d8bb6069b31", "A2");
		const alpha = mk("1ccce67ee6ff", "Alpha", {}, [a1, a2]);
		const bravo = mk("70fab4089100", "Bravo <b>bold</b>", {note: "bravo note"});
		const charlie = mk("9da451f0256e", "Charlie", {}, [mk("c1c1c1c1c1c1", "C1")]);
		const delta = mk("53b4d5571cce", "Delta");
		const dest = mk("4b159905d286", "Dest");
		const root = mk("fa85028843d2", "CC fixture", {}, [alpha, bravo, charlie, delta, dest]);
		const top = mk("ab03ee6d2ae0", "Home", {}, [root]);
		linkParents([top]);
		return {root, alpha, a1, a2, bravo, charlie, delta, dest};
	}

	describe("copying selected rows", () => {
		it("copies two top rows, expanding only the expanded one", () => {
			const {alpha, charlie} = ccFixture();
			const filter = filterFor(new Set([alpha.id]));
			expect(copyItemsHtml([alpha, charlie], filter)).toStrictEqual(expected.alpha_charlie.html);
			expect(copyItemsPlainText([alpha, charlie], filter)).toStrictEqual(expected.alpha_charlie.plain);
		});

		it("copies rows of different depth with a note, in the order given", () => {
			const {a2, bravo} = ccFixture();
			const filter = filterFor(new Set());
			expect(copyItemsHtml([a2, bravo], filter)).toStrictEqual(expected.a2_bravo.html);
			expect(copyItemsPlainText([a2, bravo], filter)).toStrictEqual(expected.a2_bravo.plain);
		});

		it("copies one leaf as a span inside a list", () => {
			const {a1} = ccFixture();
			const filter = filterFor(new Set());
			expect(copyItemsHtml([a1], filter)).toStrictEqual(expected.a1_only.html);
			expect(copyItemsPlainText([a1], filter)).toStrictEqual(expected.a1_only.plain);
		});

		it("copies the zoom root with its visible children", () => {
			const {root, alpha} = ccFixture();
			const filter = filterFor(new Set([alpha.id]), root.id);
			expect(copyItemsHtml([root], filter)).toStrictEqual(expected.zoomroot.html);
			expect(copyItemsPlainText([root], filter)).toStrictEqual(expected.zoomroot.plain);
		});

		it("copies rows in display order", () => {
			const {bravo, delta} = ccFixture();
			const filter = filterFor(new Set());
			expect(copyItemsHtml([bravo, delta], filter)).toStrictEqual(expected.reversed_insert.html);
			expect(copyItemsPlainText([bravo, delta], filter)).toStrictEqual(expected.reversed_insert.plain);
		});
	});

	const ccd = deepExpected as unknown as Record<string, {html: string; text: string}>;

	/** The fixture's tag markup, as the row renders it. */
	function renderTag(html: string): string {
		return html.replaceAll(
			/#(ccdtag)/gu,
			'<span class="contentTag explosive" title="Filter #$1" data-val="#$1">#<span class="contentTagText">$1</span><span class="contentTagNub"></span></span>',
		);
	}

	function ccdFixture() {
		const p1 = mk("1dffea89a928", "P1");
		const p2 = mk("cd8cd021c376", "P2");
		const plain = mk("f858f5ef34bf", "Plain #ccdtag", {note: "plain note"}, [p1, p2]);
		const dest = mk("ecbac275491a", "Dest");
		const home = mk("b0adce4a2894", "Home", {}, [plain, dest]);
		linkParents([home]);
		return {plain, p1, p2, dest};
	}

	/** The dump strips data-parent from these cases. */
	function withoutParents(html: string): string {
		return html.replaceAll(/ data-parent="[0-9a-f]{12}"/gu, "");
	}

	describe("copied markup follows what the row renders", () => {
		const options = {renderName: renderTag};

		it("writes a break between the name and note of a single collapsed row", () => {
			const {plain} = ccdFixture();
			const expectedCase = ccd.single_with_note_collapsed;
			expect(copyItemsHtml([plain], filterFor(new Set()), options)).toStrictEqual(expectedCase.html);
			expect(copyItemsPlainText([plain], filterFor(new Set()), options)).toStrictEqual(expectedCase.text);
		});

		it("puts the note in the item block when several rows are copied", () => {
			const {plain, dest} = ccdFixture();
			const expectedCase = ccd.two_items_first_with_note;
			const filter = filterFor(new Set());
			expect(copyItemsHtml([plain, dest], filter, options)).toStrictEqual(expectedCase.html);
			expect(copyItemsPlainText([plain, dest], filter, options)).toStrictEqual(expectedCase.text);
		});

		it("copies an expanded single row with its children", () => {
			const {plain} = ccdFixture();
			const expectedCase = ccd["single_expanded_with_note_and_children (data-parent stripped)"];
			const filter = filterFor(new Set([plain.id]));
			expect(withoutParents(copyItemsHtml([plain], filter, options))).toStrictEqual(
				expectedCase.html.replaceAll(" >", ">"),
			);
			expect(copyItemsPlainText([plain], filter, options)).toStrictEqual(expectedCase.text);
		});

		it("copies rows of mixed depth", () => {
			const {p2, dest} = ccdFixture();
			const expectedCase = ccd["mixed_depth (data-parent stripped)"];
			const filter = filterFor(new Set());
			expect(withoutParents(copyItemsHtml([p2, dest], filter, options))).toStrictEqual(
				expectedCase.html.replaceAll(" >", ">"),
			);
			expect(copyItemsPlainText([p2, dest], filter, options)).toStrictEqual(expectedCase.text);
		});

		it("copies only the rows search renders, with highlights", () => {
			const {plain, p1} = ccdFixture();
			const expectedCase = ccd.search_mode_q_P1;
			const filter: ChildAccessor = (item) => (item === plain ? [p1] : []);
			const highlight = (html: string): string =>
				renderTag(html).replace("P1", '<span class="contentMatch">P1</span>');
			const rendered = {renderName: highlight};
			expect(copyItemsHtml([plain], filter, rendered)).toStrictEqual(expectedCase.html);
			expect(copyItemsPlainText([plain], filter, rendered)).toStrictEqual(expectedCase.text);
		});

		it("copies rendered links and date pills", () => {
			const rich = mk("f00eb4839228", "Rich", {});
			const home = mk("b0adce4a2894", "Home", {}, [rich]);
			linkParents([home]);
			const expectedCase = ccd.rich_markup;
			const markup =
				'Rich <b>bold</b> <span class="colored c-red">red</span> <a class="contentLink" target="_blank" rel="noreferrer" href="https://example.com/">link</a> <time data-monolith="true" contenteditable="false" class="explosive monolith-pill" title="⌥click to search" startyear="2026" startmonth="10" startday="1">﻿<span class="content-wrapper">2026-10-01 Thu</span>﻿</time> &amp; <code>cd</code>';
			const rendered = {renderName: () => markup};
			expect(copyItemsHtml([rich], filterFor(new Set()), rendered)).toStrictEqual(expectedCase.html);
			expect(copyItemsPlainText([rich], filterFor(new Set()), rendered)).toStrictEqual(expectedCase.text);
		});

		it("copies a completed row struck through", () => {
			const done = mk("111111111111", "Done", {completed: true});
			linkParents([mk("222222222222", "Home", {}, [done])]);
			expect(copyItemsHtml([done], filterFor(new Set()))).toBe(
				'<ul><li>\n<div>\n<span class="name" style="color:#999; text-decoration:line-through; " data-wfid="111111111111" data-parent="222222222222"><span class="innerContentContainer">Done</span></span></div></li></ul>',
			);
		});

		it("copies a numbered row as an ordered list starting at its position", () => {
			const first = mk("111111111111", "One", {layoutMode: "numbered"});
			const second = mk("222222222222", "Two", {layoutMode: "numbered"});
			second.numberedStart = 3;
			linkParents([mk("333333333333", "Home", {}, [first, second])]);
			expect(copyItemsHtml([second], filterFor(new Set()))).toBe(
				'<ol start="3" style="list-style-type:decimal;"><li>\n<div>\n<span class="name" style="color:#333; " data-wfid="222222222222" data-parent="333333333333"><span class="innerContentContainer">Two</span></span></div></li></ol>',
			);
		});
	});
});

describe("copy link original", () => {
	let root: Root | undefined;

	beforeAll(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		vi.unstubAllGlobals();
	});

	function node(id: string, originalNodeId: string | null) {
		return {
			id,
			parent_id: null,
			name: "x",
			note: null,
			priority: 0,
			data: {layoutMode: null},
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
			isMirror: originalNodeId !== null,
			originalNodeId,
		};
	}

	async function copy(nodeId: string, nodes: ReturnType<typeof node>[]) {
		const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
		vi.stubGlobal("navigator", {clipboard: {writeText}});
		const showAppMessage = vi.fn<(text: string, options?: unknown) => void>();
		useOutlineStore.setState({
			showAppMessage: (text, options) => {
				showAppMessage(text, options);
			},
		});
		const client = new QueryClient();
		for (const entry of nodes) {
			client.setQueryData(nodeKeys.detail(entry.id), entry);
		}
		let run: ((id: string) => Promise<void>) | undefined;
		function Probe({onReady}: {onReady: (copy: (id: string) => Promise<void>) => void}) {
			const copyLink = useCopyLink();
			useEffect(() => {
				onReady(copyLink);
			}, [copyLink, onReady]);
			return null;
		}
		root = createRoot(document.createElement("div"));
		act(() => {
			root?.render(
				createElement(
					QueryClientProvider,
					{client},
					createElement(Probe, {
						onReady: (copyLink) => {
							run = copyLink;
						},
					}),
				),
			);
		});
		await act(async () => {
			await run?.(nodeId);
		});
		return {copied: writeText.mock.calls.map(([text]) => text), toasts: showAppMessage.mock.calls};
	}

	describe("copy_link", () => {
		it("copies the original's url for a mirror row, with the Link copied toast", async () => {
			const result = await copy("00000000-0000-4000-8000-00000000aaaa", [
				node("00000000-0000-4000-8000-00000000aaaa", "00000000-0000-4000-8000-c4f7c5bca489"),
			]);

			expect(result).toStrictEqual({
				copied: ["https://workflowy.com/#/c4f7c5bca489"],
				toasts: [["Link copied.", {timeout: 1000}]],
			});
		});

		it("copies the row's own url when it is not a mirror", async () => {
			const result = await copy("00000000-0000-4000-8000-81df3e9581ea", [
				node("00000000-0000-4000-8000-81df3e9581ea", null),
			]);

			expect(result.copied).toStrictEqual(["https://workflowy.com/#/81df3e9581ea"]);
		});
	});
});
