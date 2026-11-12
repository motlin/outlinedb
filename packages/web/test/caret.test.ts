import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {caretAnchor, editorElement, offsetsFromPath, orderOffsets, rowContent} from "../src/client/caret-dom.js";
import {
	adjacentVisibleNode,
	planVerticalCross,
	backspaceDeleteTarget,
	editingAfterMoveOut,
	editingAfterRemoval,
	firstLastNavigable,
	horizontalTarget,
	isCaretOnBoundaryLine,
	navigableIds,
	planCompleteFocus,
	planHideCompletedFocus,
	planNoteBoundary,
} from "../src/client/caret-navigation.js";

describe("caret dom", () => {
	describe("offsetsFromPath", () => {
		it("counts the lengths of the text nodes before the target node", () => {
			expect(offsetsFromPath([6, 5, 10], 1, 0)).toBe(6);
		});

		it("adds the offset inside the target node", () => {
			expect(offsetsFromPath([6, 5, 10], 1, 2)).toBe(8);
		});

		it("is the offset itself in the first node", () => {
			expect(offsetsFromPath([6, 5, 10], 0, 3)).toBe(3);
		});
	});

	describe("orderOffsets", () => {
		it("normalizes a reversed selection", () => {
			expect(orderOffsets(11, 6)).toStrictEqual({start: 6, end: 11});
		});

		it("keeps a forward selection", () => {
			expect(orderOffsets(2, 9)).toStrictEqual({start: 2, end: 9});
		});
	});

	describe("caretAnchor", () => {
		const fallback = {left: 40, bottom: 60, top: 40, right: 200, width: 160, height: 20};
		const empty = {left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0};

		it("anchors at the caret box's bottom-left", () => {
			expect(
				caretAnchor([{left: 10, bottom: 20, top: 2, right: 11, width: 1, height: 18}], fallback),
			).toStrictEqual({
				x: 10,
				y: 20,
			});
		});

		it("uses the first non-empty candidate, as upstream's text-offset range then focus-node box", () => {
			expect(
				caretAnchor(
					[
						empty,
						null,
						{left: 15, bottom: 30, top: 12, right: 15, width: 0, height: 18},
						{...fallback, left: 99},
					],
					fallback,
				),
			).toStrictEqual({x: 15, y: 30});
		});

		it("falls back to the row's name box when every candidate is all zeros", () => {
			expect(caretAnchor([empty, empty], fallback)).toStrictEqual({x: 40, y: 60});
		});

		it("falls back when there is no caret box", () => {
			expect(caretAnchor([], fallback)).toStrictEqual({x: 40, y: 60});
		});
	});

	/** A fake document whose active pane (when given) and the document itself each answer selectors from a map. */
	function stubPanes(documentMatches: Record<string, string>, activePaneMatches?: Record<string, string>): void {
		const scope = (matches: Record<string, string>) => ({
			querySelector: (selector: string) => matches[selector] ?? null,
		});
		vi.stubGlobal("CSS", {escape: (value: string) => value});
		vi.stubGlobal("document", {
			querySelector: (selector: string) =>
				selector === '[data-pane-active="true"]'
					? activePaneMatches === undefined
						? null
						: scope(activePaneMatches)
					: (documentMatches[selector] ?? null),
		});
	}

	describe("pane-scoped row lookups", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("finds the edited editor inside the active pane, not the first one in the document", () => {
			stubPanes(
				{'.innerContentContainer.editing[data-node-id="alice"]': "main editor"},
				{'.innerContentContainer.editing[data-node-id="alice"]': "side editor"},
			);
			expect(editorElement("alice")).toBe("side editor");
		});

		it("searches the whole document while no pane is active", () => {
			stubPanes({'.innerContentContainer.editing[data-node-id="alice"]': "main editor"});
			expect(editorElement("alice")).toBe("main editor");
		});

		it("finds a row's content inside the active pane", () => {
			stubPanes(
				{'.innerContentContainer[data-node-id="bob"]': "main row"},
				{'.innerContentContainer[data-node-id="bob"]': "side row"},
			);
			expect(rowContent("bob")).toBe("side row");
		});
	});
});

describe("caret navigation", () => {
	describe("isCaretOnBoundaryLine", () => {
		// A three-line node: lines at 100-116, 120-136, 140-156 (16px caret, 20px line pitch).
		const content = {top: 98, bottom: 158};
		const firstLine = {top: 100, bottom: 116};
		const middleLine = {top: 120, bottom: 136};
		const lastLine = {top: 140, bottom: 156};

		it("treats the first line as the up boundary only", () => {
			expect([
				isCaretOnBoundaryLine("up", firstLine, content),
				isCaretOnBoundaryLine("down", firstLine, content),
			]).toStrictEqual([true, false]);
		});

		it("treats the last line as the down boundary only", () => {
			expect([
				isCaretOnBoundaryLine("up", lastLine, content),
				isCaretOnBoundaryLine("down", lastLine, content),
			]).toStrictEqual([false, true]);
		});

		it("keeps in-text movement on a middle line", () => {
			expect([
				isCaretOnBoundaryLine("up", middleLine, content),
				isCaretOnBoundaryLine("down", middleLine, content),
			]).toStrictEqual([false, false]);
		});

		it("treats a single-line node as both boundaries", () => {
			const single = {top: 100, bottom: 116};
			expect([
				isCaretOnBoundaryLine("up", single, {top: 98, bottom: 118}),
				isCaretOnBoundaryLine("down", single, {top: 98, bottom: 118}),
			]).toStrictEqual([true, true]);
		});

		it("treats an unmeasurable caret (empty node) as both boundaries", () => {
			expect([
				isCaretOnBoundaryLine("up", null, content),
				isCaretOnBoundaryLine("down", null, content),
			]).toStrictEqual([true, true]);
		});
	});

	describe("adjacentVisibleNode", () => {
		const visible = ["a", "b", "c"];

		it("returns the previous node for up", () => {
			expect(adjacentVisibleNode(visible, "b", "up")).toBe("a");
		});

		it("returns the next node for down", () => {
			expect(adjacentVisibleNode(visible, "b", "down")).toBe("c");
		});

		it("does nothing at the first node going up", () => {
			expect(adjacentVisibleNode(visible, "a", "up")).toBeNull();
		});

		it("does nothing at the last node going down", () => {
			expect(adjacentVisibleNode(visible, "c", "down")).toBeNull();
		});

		it("does nothing when the edited node is not visible", () => {
			expect(adjacentVisibleNode(visible, "z", "down")).toBeNull();
		});
	});

	describe("backspaceDeleteTarget", () => {
		const visible = ["a", "b", "c"];

		it("deletes an empty childless node and edits the previous visible node", () => {
			expect(backspaceDeleteTarget(visible, "b", {text: "", note: "", hasChildren: false})).toBe("a");
		});

		it("keeps an empty-named node that holds a file", () => {
			expect(
				backspaceDeleteTarget(visible, "b", {text: "", note: "", hasChildren: false, hasFile: true}),
			).toBeNull();
		});

		it("keeps a node that still has text", () => {
			expect(backspaceDeleteTarget(visible, "b", {text: "x", note: "", hasChildren: false})).toBeNull();
		});

		it("keeps an empty node that has a note", () => {
			expect(backspaceDeleteTarget(visible, "b", {text: "", note: "x", hasChildren: false})).toBeNull();
		});

		it("keeps an empty node that has children", () => {
			expect(backspaceDeleteTarget(visible, "b", {text: "", note: "", hasChildren: true})).toBeNull();
		});

		it("keeps the first visible node, which has nowhere to move the caret", () => {
			expect(backspaceDeleteTarget(visible, "a", {text: "", note: "", hasChildren: false})).toBeNull();
		});
	});

	describe("editingAfterRemoval", () => {
		it("continues at the end of the previous visible node", () => {
			expect(editingAfterRemoval(["a", "b", "c"], "b")).toStrictEqual({
				nodeId: "a",
				caretOffset: Number.MAX_SAFE_INTEGER,
			});
		});

		it("continues at the start of the next visible node when the removed node was first", () => {
			expect(editingAfterRemoval(["a", "b", "c"], "a")).toStrictEqual({nodeId: "b", caretOffset: 0});
		});

		it("stops editing when no other node is visible", () => {
			expect(editingAfterRemoval(["a"], "a")).toBeNull();
		});
	});

	describe("editingAfterMoveOut", () => {
		it("continues on the next row when the moved row follows the zoom title", () => {
			expect(editingAfterMoveOut(["root-title", "mover", "hub"], "mover", "root-title")).toStrictEqual({
				nodeId: "hub",
				caretOffset: 0,
			});
		});

		it("continues at the end of the previous row otherwise", () => {
			expect(editingAfterMoveOut(["root-title", "a", "mover"], "mover", "root-title")).toStrictEqual({
				nodeId: "a",
				caretOffset: Number.MAX_SAFE_INTEGER,
			});
			expect(editingAfterMoveOut(["a", "mover"], "mover", null)).toStrictEqual({
				nodeId: "a",
				caretOffset: Number.MAX_SAFE_INTEGER,
			});
		});

		it("falls back to the zoom title when the moved row was its only child", () => {
			expect(editingAfterMoveOut(["root-title", "mover"], "mover", "root-title")).toStrictEqual({
				nodeId: "root-title",
				caretOffset: Number.MAX_SAFE_INTEGER,
			});
		});
	});

	describe("horizontalTarget", () => {
		it("moves Left to the end of the previous row and Right to the start of the next", () => {
			expect({
				left: horizontalTarget(["a", "b", "c"], "b", "left"),
				right: horizontalTarget(["a", "b", "c"], "b", "right"),
			}).toStrictEqual({
				left: {nodeId: "a", caretOffset: Number.MAX_SAFE_INTEGER},
				right: {nodeId: "c", caretOffset: 0},
			});
		});

		it("returns null at the first row going left, the last going right, and for unknown rows", () => {
			expect({
				firstLeft: horizontalTarget(["a", "b", "c"], "a", "left"),
				lastRight: horizontalTarget(["a", "b", "c"], "c", "right"),
				unknown: horizontalTarget(["a", "b", "c"], "z", "left"),
			}).toStrictEqual({firstLeft: null, lastRight: null, unknown: null});
		});
	});

	describe("navigableIds", () => {
		it("prepends the zoom root's title when zoomed", () => {
			expect(navigableIds("z", ["a", "b"])).toStrictEqual(["z", "a", "b"]);
		});

		it("returns the visible rows unchanged at the main-tree root", () => {
			expect(navigableIds(null, ["a"])).toStrictEqual(["a"]);
		});

		it("moves Up from the first child into the zoom title", () => {
			expect(adjacentVisibleNode(navigableIds("z", ["a", "b"]), "a", "up")).toBe("z");
		});

		it("moves Down from the zoom title into the first child", () => {
			expect(adjacentVisibleNode(navigableIds("z", ["a", "b"]), "z", "down")).toBe("a");
		});

		it("continues editing at the end of the zoom title when its only child leaves the view", () => {
			expect(editingAfterRemoval(navigableIds("z", ["a"]), "a")).toStrictEqual({
				nodeId: "z",
				caretOffset: Number.MAX_SAFE_INTEGER,
			});
		});
	});

	describe("planCompleteFocus", () => {
		// Zoomed into "z": children delta, charlie, bravo, alpha (priority order); alpha expanded [a2, a1].
		const children: Record<string, string[]> = {
			z: ["delta", "charlie", "bravo", "alpha"],
			alpha: ["a2", "a1"],
		};
		const parentOf = (id: string): string =>
			Object.keys(children).find((parent) => children[parent]?.includes(id)) ?? "";
		const siblingsOf = (id: string): string[] => children[parentOf(id)] ?? [];
		const allRows = ["z", "delta", "charlie", "bravo", "alpha", "a2", "a1"];
		const base = {
			completing: true,
			showCompleted: false,
			zoomRootId: "z",
			siblingsOf,
			visibleRows: allRows,
			completedIds: new Set<string>(),
		};

		it("moves a multi-selection's caret to the row after the last item", () => {
			expect([
				planCompleteFocus({...base, showCompleted: true, ids: ["delta", "charlie"]}),
				planCompleteFocus({
					...base,
					ids: ["delta", "charlie"],
					completedIds: new Set(["bravo"]),
				}),
			]).toStrictEqual([
				{kind: "row", id: "bravo", offset: 0},
				{kind: "row", id: "alpha", offset: 0},
			]);
		});

		it("moves to the next sibling when completing with completed rows hidden", () => {
			expect(planCompleteFocus({...base, ids: ["charlie"]})).toStrictEqual({kind: "row", id: "bravo", offset: 0});
		});

		it("falls back to the previous visible row for the last sibling when hidden", () => {
			expect(planCompleteFocus({...base, ids: ["alpha"]})).toStrictEqual({kind: "row", id: "bravo", offset: 0});
		});

		it("moves to the next sibling when completed rows are shown", () => {
			expect(planCompleteFocus({...base, showCompleted: true, ids: ["bravo"]})).toStrictEqual({
				kind: "row",
				id: "alpha",
				offset: 0,
			});
		});

		it("keeps the caret in the last sibling at offset 0 when completed rows are shown", () => {
			expect(planCompleteFocus({...base, showCompleted: true, ids: ["alpha"]})).toStrictEqual({
				kind: "row",
				id: "alpha",
				offset: 0,
			});
		});

		it("focuses the zoom title when the only visible child is completed and hidden", () => {
			expect(
				planCompleteFocus({
					...base,
					ids: ["only"],
					siblingsOf: () => ["only"],
					visibleRows: ["z", "only"],
				}),
			).toStrictEqual({kind: "zoomTitle"});
		});

		it("skips already-completed siblings when hidden", () => {
			expect(
				planCompleteFocus({
					...base,
					ids: ["delta"],
					visibleRows: ["z", "delta", "bravo", "alpha", "a2", "a1"],
					completedIds: new Set(["charlie"]),
				}),
			).toStrictEqual({kind: "row", id: "bravo", offset: 0});
		});

		it("keeps the caret where it is when uncompleting", () => {
			expect(planCompleteFocus({...base, completing: false, ids: ["charlie"]})).toStrictEqual({kind: "stay"});
		});

		it("zooms out after a delay when the zoom root is among the items", () => {
			expect(planCompleteFocus({...base, ids: ["z"]})).toStrictEqual({kind: "zoomOut", delayMs: 500});
		});
	});

	describe("planNoteBoundary", () => {
		it("moves Down from the end of the noted root title to the start of the root note", () => {
			expect(planNoteBoundary({from: "rootTitleEnd", key: "Down", rootNoted: true})).toStrictEqual({
				focus: "rootNote",
				caret: 0,
			});
		});

		it("moves Right from the end of the noted root title to the start of the root note", () => {
			expect(planNoteBoundary({from: "rootTitleEnd", key: "Right", rootNoted: true})).toStrictEqual({
				focus: "rootNote",
				caret: 0,
			});
		});

		it("moves Up from the start of the first child's name to the end of the root note", () => {
			expect(planNoteBoundary({from: "firstChildName", key: "Up", caret: 0, rootNoted: true})).toStrictEqual({
				focus: "rootNote",
				caret: "end",
			});
		});

		it("moves Left from the start of the first child's name to the end of the root note", () => {
			expect(planNoteBoundary({from: "firstChildName", key: "Left", caret: 0, rootNoted: true})).toStrictEqual({
				focus: "rootNote",
				caret: "end",
			});
		});

		it("leaves the first child's name alone when the caret is not at its start", () => {
			expect(planNoteBoundary({from: "firstChildName", key: "Up", caret: 3, rootNoted: true})).toBeNull();
		});

		it("ignores keys that move away from the root note", () => {
			expect([
				planNoteBoundary({from: "rootTitleEnd", key: "Up", rootNoted: true}),
				planNoteBoundary({from: "firstChildName", key: "Down", caret: 0, rootNoted: true}),
			]).toStrictEqual([null, null]);
		});

		it("does nothing when the root has no note", () => {
			expect([
				planNoteBoundary({from: "rootTitleEnd", key: "Down", rootNoted: false}),
				planNoteBoundary({from: "firstChildName", key: "Up", caret: 0, rootNoted: false}),
			]).toStrictEqual([null, null]);
		});
	});

	describe("firstLastNavigable", () => {
		it("spans the first and last visible rows at home", () => {
			expect(firstLastNavigable(["c", "b", "b1", "a"], {titleEditable: false})).toStrictEqual({
				first: "c",
				last: "a",
			});
		});

		it("starts at the zoomed title when it is editable", () => {
			expect(firstLastNavigable(["c", "b", "b1", "a"], {titleEditable: true, zoomedId: "sandbox"})).toStrictEqual(
				{
					first: "sandbox",
					last: "a",
				},
			);
		});

		it("uses the zoomed title for both ends when the zoomed node has no visible rows", () => {
			expect(firstLastNavigable([], {titleEditable: true, zoomedId: "sandbox"})).toStrictEqual({
				first: "sandbox",
				last: "sandbox",
			});
		});

		it("returns null with nothing to focus", () => {
			expect(firstLastNavigable([], {titleEditable: false})).toBeNull();
		});
	});

	describe("planHideCompletedFocus", () => {
		it("moves the caret to the previous visible row at offset 0 when the edited row hides", () => {
			expect(planHideCompletedFocus(["a", "b", "c"], new Set(["b"]), "b")).toStrictEqual({
				nodeId: "a",
				caretOffset: 0,
			});
		});

		it("keeps the caret when the edited row stays visible", () => {
			expect(planHideCompletedFocus(["a", "b", "c"], new Set(["b"]), "c")).toBeNull();
		});

		it("falls back to the zoom title when the first row hides", () => {
			expect(planHideCompletedFocus(["zoom", "a", "b"], new Set(["a"]), "a")).toStrictEqual({
				nodeId: "zoom",
				caretOffset: 0,
			});
		});

		it("skips hidden rows above and keeps the caret with nothing visible before it", () => {
			expect([
				planHideCompletedFocus(["a", "b", "c"], new Set(["b", "c"]), "c"),
				planHideCompletedFocus(["a", "b"], new Set(["a"]), "a"),
				planHideCompletedFocus(["a"], new Set(), null),
			]).toStrictEqual([{nodeId: "a", caretOffset: 0}, null, null]);
		});
	});

	describe("planVerticalCross", () => {
		const ids = ["T", "A", "B", "C"];

		it("moves to the neighbor at offset 0 in both directions", () => {
			expect([planVerticalCross(ids, "A", "up"), planVerticalCross(ids, "B", "down")]).toStrictEqual([
				{kind: "move", nodeId: "T", caretOffset: 0},
				{kind: "move", nodeId: "C", caretOffset: 0},
			]);
		});

		it("swallows Up at the first row and leaves Down native on the last row or an unknown row", () => {
			expect([
				planVerticalCross(ids, "T", "up"),
				planVerticalCross(ids, "C", "down"),
				planVerticalCross(ids, "X", "down"),
			]).toStrictEqual([{kind: "swallow"}, {kind: "native"}, {kind: "native"}]);
		});
	});
});
