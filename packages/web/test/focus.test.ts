import {describe, expect, it} from "vite-plus/test";
import {caretAfterSelectionCommand} from "../src/client/focus-maintain.js";
import type {NodeResponse} from "../src/node-types.js";
import type {TreeSearchResult} from "../src/server/tree-search.js";
import {searchFilter} from "../src/client/search-filter.js";
import {focusableSiblingIds} from "../src/client/render-window.js";

describe("focus maintain", () => {
	const rows = (...ids: string[]) => ids.map((id) => ({id, parentId: "R"}));
	const before = {parentId: "R", index: 1};
	const base = {firstId: "Bravo", before, selectionActive: false, editorFocused: false};

	describe("caretAfterSelectionCommand", () => {
		it("returns the end of the first selected row while it is still rendered", () => {
			expect(caretAfterSelectionCommand({...base, rows: rows("Alpha", "Bravo", "Charlie")})).toStrictEqual({
				id: "Bravo",
				offset: "end",
			});
		});

		it("falls to the row now at the same index when the first row is gone", () => {
			expect(caretAfterSelectionCommand({...base, rows: rows("Alpha", "Charlie", "Delta")})).toStrictEqual({
				id: "Charlie",
				offset: "end",
			});
		});

		it("falls to the previous sibling when the last child was removed", () => {
			expect(caretAfterSelectionCommand({...base, rows: rows("Alpha")})).toStrictEqual({
				id: "Alpha",
				offset: "end",
			});
		});

		it("falls to the first visible row when the parent has no children left", () => {
			expect(
				caretAfterSelectionCommand({
					...base,
					before: {parentId: "Gone", index: 0},
					rows: [{id: "Zed", parentId: "R"}],
				}),
			).toStrictEqual({id: "Zed", offset: "end"});
		});

		it("does nothing while the selection is active or an editor has focus", () => {
			expect([
				caretAfterSelectionCommand({...base, selectionActive: true, rows: rows("Bravo")}),
				caretAfterSelectionCommand({...base, editorFocused: true, rows: rows("Bravo")}),
			]).toStrictEqual([null, null]);
		});
	});
});

describe("focus sibling", () => {
	function node(id: string, priority: number, completed = false): NodeResponse {
		return {
			id,
			parent_id: "z",
			name: id,
			note: null,
			priority,
			data: {layoutMode: null},
			createdAt: null,
			modifiedAt: null,
			completedAt: completed ? 1 : null,
		};
	}

	function result(matchIds: string[]): TreeSearchResult {
		return {
			matchIds,
			nameMatchIds: matchIds,
			noteMatchIds: [],
			metaMatchIds: [],
			ancestorIds: [],
			halfExpandedIds: [],
			rootHalfExpanded: false,
			completedMatchCount: 0,
			matchCount: matchIds.length,
			revealsCompleted: false,
		};
	}

	// Siblings deliberately out of priority order.
	const siblings = [node("Echo", 3), node("Charlie", 1), node("Filler05", 4), node("Delta", 2, true)];
	const none = new Set<string>();

	describe("focusableSiblingIds", () => {
		it("keeps only the siblings a search shows, in priority order", () => {
			const search = searchFilter(result(["Charlie", "Filler05"]), none, new Map());
			expect(
				focusableSiblingIds(siblings, {showCompleted: false, animatingCompletionIds: none, search}),
			).toStrictEqual(["Charlie", "Filler05"]);
		});

		it("drops a hidden completed sibling when no search is applied", () => {
			expect(
				focusableSiblingIds(siblings, {showCompleted: false, animatingCompletionIds: none, search: null}),
			).toStrictEqual(["Charlie", "Echo", "Filler05"]);
		});

		it("keeps completed siblings when completed rows are shown", () => {
			expect(
				focusableSiblingIds(siblings, {showCompleted: true, animatingCompletionIds: none, search: null}),
			).toStrictEqual(["Charlie", "Delta", "Echo", "Filler05"]);
		});

		it("is empty for an unloaded list", () => {
			expect(
				focusableSiblingIds(undefined, {showCompleted: true, animatingCompletionIds: none, search: null}),
			).toStrictEqual([]);
		});
	});
});
