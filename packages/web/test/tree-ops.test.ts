import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys, spliceChildren} from "../src/client/node-cache.js";
import {
	applyBlockMove,
	applySplitPlan,
	defaultIndexIn,
	dropIndex,
	planAddChild,
	planBackspaceAtStart,
	planDeleteAtEnd,
	planAddSibling,
	planBlockMove,
	planDuplicate,
	planIndent,
	indentChildrenToLoad,
	isPotentiallyVisible,
	nextPotentiallyVisibleSibling,
	planFocusParent,
	planFocusSibling,
	planOutdent,
	planSplit,
	isEmptyForReturn,
	shapeLayoutFor,
	planToggleComplete,
	planVerticalMove,
	cacheMoveTree,
	needsChildrenBeforeMove,
	toUndoOps,
} from "../src/client/tree-ops.js";
import type {BlockMove, BlockMoveTree, VerticalMoveTree} from "../src/client/tree-ops.js";
import {invertBatch} from "../src/client/undo-history.js";
import type {UndoOp} from "../src/client/undo-history.js";

function node(partial: Partial<NodeResponse> & {id: string}): NodeResponse {
	return {
		parent_id: null,
		name: null,
		note: null,
		priority: 0,
		data: {layoutMode: null},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...partial,
	};
}

function seed(children: Record<string, NodeResponse[]>, details: NodeResponse[] = []): QueryClient {
	const qc = new QueryClient();
	for (const [parentId, kids] of Object.entries(children)) {
		qc.setQueryData(nodeKeys.children(parentId === "root" ? null : parentId), kids);
	}
	for (const d of details) {
		qc.setQueryData(nodeKeys.detail(d.id), d);
	}
	return qc;
}

const siblings = [
	node({id: "a", parent_id: "p", priority: 100}),
	node({id: "b", parent_id: "p", priority: 200}),
	node({id: "c", parent_id: "p", priority: 300}),
];

describe("planDuplicate", () => {
	it("carries name and note when duplicating", () => {
		const qc = seed({p: siblings});
		const src = node({id: "a", parent_id: "p", priority: 100, name: "Hi", note: "yo"});
		expect(planDuplicate(qc, src)).toStrictEqual({parent_id: "p", name: "Hi", note: "yo", index: 1});
	});
});

describe("planAddSibling", () => {
	it("plans an empty sibling right after the owner, counting completed siblings in the index", () => {
		const all = [
			node({id: "x", parent_id: "p", priority: 50, completedAt: 1_760_745_600}),
			node({id: "c", parent_id: "p", priority: 300}),
			node({id: "a", parent_id: "p", priority: 100}),
			node({id: "b", parent_id: "p", priority: 200}),
		];
		expect(planAddSibling({owner: all[2], siblings: all})).toStrictEqual({parent_id: "p", name: "", index: 2});
	});

	it("plans a top-level owner's sibling under the root", () => {
		const top = [node({id: "a", priority: 0}), node({id: "b", priority: 1})];
		expect(planAddSibling({owner: top[1], siblings: top})).toStrictEqual({
			parent_id: undefined,
			name: "",
			index: 2,
		});
	});
});

describe("planIndent", () => {
	const collapsed = new Set<string>();

	it("appends the node last under its previous sibling's cached children and expands the collapsed new parent", () => {
		const bKids = [node({id: "b1", parent_id: "b", priority: 0}), node({id: "b2", parent_id: "b", priority: 1})];
		const qc = seed({p: siblings, b: bKids});
		expect(planIndent(qc, siblings[2], collapsed)).toStrictEqual({
			nodeId: "c",
			parent_id: "b",
			index: 2,
			expandParentId: "b",
		});
	});

	it("does not re-expand a new parent that is already expanded", () => {
		const bKids = [node({id: "b1", parent_id: "b", priority: 0}), node({id: "b2", parent_id: "b", priority: 1})];
		const qc = seed({p: siblings, b: bKids});
		expect(planIndent(qc, siblings[2], new Set(["b"]))).toStrictEqual({
			nodeId: "c",
			parent_id: "b",
			index: 2,
			expandParentId: null,
		});
	});

	it("uses index 0 when the previous sibling has no children", () => {
		const qc = seed({p: [siblings[0], {...siblings[1], hasChildren: false}, siblings[2]]});
		expect(planIndent(qc, siblings[2], collapsed)).toStrictEqual({
			nodeId: "c",
			parent_id: "b",
			index: 0,
			expandParentId: "b",
		});
	});

	it("omits the index (bottom = last) when the previous sibling's children are not cached", () => {
		const qc = seed({p: [siblings[0], {...siblings[1], hasChildren: true}, siblings[2]]});
		expect(planIndent(qc, siblings[2], collapsed)).toStrictEqual({
			nodeId: "c",
			parent_id: "b",
			expandParentId: "b",
		});
	});

	it("returns null for the first sibling", () => {
		const qc = seed({p: siblings});
		expect(planIndent(qc, siblings[0], collapsed)).toBeNull();
	});
});

describe("indentChildrenToLoad", () => {
	it("names the previous sibling when it has children that are not cached, so Tab would wait to load them", () => {
		const qc = seed({p: [siblings[0], {...siblings[1], hasChildren: true}, siblings[2]]});
		expect(indentChildrenToLoad(qc, siblings[2])).toBe("b");
	});

	it("is null when the previous sibling's children are cached", () => {
		const qc = seed({p: [siblings[0], {...siblings[1], hasChildren: true}, siblings[2]], b: []});
		expect(indentChildrenToLoad(qc, siblings[2])).toBeNull();
	});

	it("is null when the previous sibling is a leaf", () => {
		const qc = seed({p: [siblings[0], {...siblings[1], hasChildren: false}, siblings[2]]});
		expect(indentChildrenToLoad(qc, siblings[2])).toBeNull();
	});

	it("is null for the first sibling, which Tab cannot indent", () => {
		const qc = seed({p: siblings});
		expect(indentChildrenToLoad(qc, siblings[0])).toBeNull();
	});
});

describe("planOutdent", () => {
	it("moves the node to the slot after its parent among the grandparent's children", () => {
		const parent = node({id: "p", parent_id: "gp", priority: 400});
		const parentSiblings = [
			node({id: "q0", parent_id: "gp", priority: 100}),
			node({id: "q1", parent_id: "gp", priority: 200}),
			node({id: "q2", parent_id: "gp", priority: 300, completedAt: 1}),
			parent,
			node({id: "q4", parent_id: "gp", priority: 500}),
		];
		const qc = seed({gp: parentSiblings, p: siblings}, [parent]);
		expect(planOutdent(qc, siblings[0], null)).toStrictEqual({nodeId: "a", parent_id: "gp", index: 4});
	});

	it("returns null for a root-level node", () => {
		const qc = seed({});
		expect(planOutdent(qc, node({id: "x", parent_id: null}), null)).toBeNull();
	});

	it("returns null when the parent is the zoom root", () => {
		const parent = node({id: "p", parent_id: "gp", priority: 400});
		const qc = seed({gp: [parent], p: siblings}, [parent]);
		expect(planOutdent(qc, siblings[0], "p")).toBeNull();
	});

	it("finds the parent in the zoomed root's cached children when its detail is not cached", () => {
		const parent = node({id: "p", parent_id: "zoom", priority: 100});
		const qc = seed({zoom: [parent, node({id: "q", parent_id: "zoom", priority: 200})], p: siblings});
		expect(planOutdent(qc, siblings[0], "zoom")).toStrictEqual({nodeId: "a", parent_id: "zoom", index: 1});
	});
});

interface Row {
	id: string;
	children?: Row[];
	expanded?: boolean;
	hidden?: boolean;
}

/** A `VerticalMoveTree` over nested rows under an implicit root (`null`). */
function rowTree(rows: Row[]): VerticalMoveTree {
	const parents = new Map<string, string | null>();
	const children = new Map<string | null, string[]>();
	const expanded = new Set<string>();
	const hidden = new Set<string>();
	const walk = (parentId: string | null, list: Row[]): void => {
		children.set(
			parentId,
			list.map((row) => row.id),
		);
		for (const row of list) {
			parents.set(row.id, parentId);
			if (row.expanded === true) {
				expanded.add(row.id);
			}
			if (row.hidden === true) {
				hidden.add(row.id);
			}
			walk(row.id, row.children ?? []);
		}
	};
	walk(null, rows);
	return {
		parentOf: (id) => parents.get(id) ?? null,
		childrenOf: (id) => children.get(id) ?? [],
		isExpanded: (id) => expanded.has(id),
		isVisible: (id) => !hidden.has(id),
	};
}

describe("planVerticalMove", () => {
	const delta = (expanded = false): Row => ({id: "delta", expanded, children: [{id: "d1"}]});
	const bravo: Row = {id: "bravo", expanded: true, children: [{id: "b1"}, {id: "b2"}]};
	const alpha = (expanded: boolean): Row => ({id: "alpha", expanded, children: [{id: "a1"}, {id: "a2"}]});

	it("moves the first child up to the end of an open uncle", () => {
		const tree = rowTree([delta(), {id: "charlie"}, bravo, alpha(true)]);
		expect(planVerticalMove({nodeId: "a1", direction: "up", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "a1",
			parentId: "bravo",
			index: 2,
			expandParentId: null,
		});
	});
	it("moves the first child up to the top of a collapsed uncle and expands it", () => {
		const tree = rowTree([delta(), {id: "charlie", expanded: true, children: [{id: "c1"}]}]);
		expect(planVerticalMove({nodeId: "c1", direction: "up", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "c1",
			parentId: "delta",
			index: 0,
			expandParentId: "delta",
		});
	});
	it("moves the first child up into a leaf uncle and expands it", () => {
		const tree = rowTree([delta(), {id: "charlie"}, bravo, alpha(true)]);
		expect(planVerticalMove({nodeId: "b1", direction: "up", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "b1",
			parentId: "charlie",
			index: 0,
			expandParentId: "charlie",
		});
	});
	it("moves the last child down to the top of a leaf uncle", () => {
		const tree = rowTree([delta(true), {id: "charlie"}, bravo, alpha(false)]);
		expect(planVerticalMove({nodeId: "d1", direction: "down", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "d1",
			parentId: "charlie",
			index: 0,
			expandParentId: "charlie",
		});
	});
	it("moves the last child down to the top of a collapsed uncle", () => {
		const tree = rowTree([delta(), {id: "charlie"}, bravo, alpha(false)]);
		expect(planVerticalMove({nodeId: "b2", direction: "down", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "b2",
			parentId: "alpha",
			index: 0,
			expandParentId: "alpha",
		});
	});
	it("moves the last child down to the top of an open uncle without expanding it", () => {
		const tree = rowTree([delta(), {id: "charlie"}, bravo, alpha(true)]);
		expect(planVerticalMove({nodeId: "b2", direction: "down", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "b2",
			parentId: "alpha",
			index: 0,
			expandParentId: null,
		});
	});
	it("returns null with no uncle in that direction", () => {
		const tree = rowTree([delta(true), {id: "charlie"}, bravo, alpha(true)]);
		expect([
			planVerticalMove({nodeId: "d1", direction: "up", zoomRootId: null, tree}),
			planVerticalMove({nodeId: "a2", direction: "down", zoomRootId: null, tree}),
			planVerticalMove({nodeId: "delta", direction: "up", zoomRootId: null, tree}),
			planVerticalMove({nodeId: "alpha", direction: "down", zoomRootId: null, tree}),
		]).toStrictEqual([null, null, null, null]);
	});
	it("never leaves the zoomed page", () => {
		const tree = rowTree([delta(), {id: "charlie"}, bravo, alpha(true)]);
		expect([
			planVerticalMove({nodeId: "b1", direction: "up", zoomRootId: "bravo", tree}),
			planVerticalMove({nodeId: "b2", direction: "down", zoomRootId: "bravo", tree}),
			planVerticalMove({nodeId: "bravo", direction: "up", zoomRootId: "bravo", tree}),
		]).toStrictEqual([null, null, null]);
	});
	it("swaps with the previous sibling", () => {
		const tree = rowTree([{id: "p", expanded: true, children: [{id: "a"}, {id: "b"}, {id: "c"}]}]);
		expect(planVerticalMove({nodeId: "c", direction: "up", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "c",
			parentId: "p",
			index: 1,
			expandParentId: null,
		});
	});
	it("moves down past the next sibling (slot counted before removal, like the move endpoint)", () => {
		const tree = rowTree([{id: "p", expanded: true, children: [{id: "a"}, {id: "b"}, {id: "c"}]}]);
		expect(planVerticalMove({nodeId: "a", direction: "down", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "a",
			parentId: "p",
			index: 2,
			expandParentId: null,
		});
	});
	it("skips a hidden completed sibling, counting it in the index", () => {
		const tree = rowTree([
			{id: "p", expanded: true, children: [{id: "a"}, {id: "b"}, {id: "x", hidden: true}, {id: "c"}]},
		]);
		expect([
			planVerticalMove({nodeId: "c", direction: "up", zoomRootId: null, tree}),
			planVerticalMove({nodeId: "b", direction: "down", zoomRootId: null, tree}),
		]).toStrictEqual([
			{nodeId: "c", parentId: "p", index: 1, expandParentId: null},
			{nodeId: "b", parentId: "p", index: 4, expandParentId: null},
		]);
	});
	it("lands after the open uncle's last rendered child, before its hidden completed ones", () => {
		const tree = rowTree([
			{id: "u", expanded: true, children: [{id: "u1"}, {id: "u2", hidden: true}]},
			{id: "p", expanded: true, children: [{id: "a"}]},
		]);
		expect(planVerticalMove({nodeId: "a", direction: "up", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "a",
			parentId: "u",
			index: 1,
			expandParentId: null,
		});
	});
	it("skips a hidden completed uncle", () => {
		const tree = rowTree([
			{id: "u", expanded: true, children: [{id: "u1"}]},
			{id: "h", hidden: true},
			{id: "p", expanded: true, children: [{id: "a"}]},
		]);
		expect(planVerticalMove({nodeId: "a", direction: "up", zoomRootId: null, tree})).toStrictEqual({
			nodeId: "a",
			parentId: "u",
			index: 1,
			expandParentId: null,
		});
	});
});

/** Every parent's children after applying `moves` in order, for the parents listed in `parents`. */
function afterMoves(tree: BlockMoveTree, moves: BlockMove[], parents: (string | null)[]): (string | null | string[])[] {
	const after = moves.reduce<BlockMoveTree>((current, move) => applyBlockMove(current, move), tree);
	return parents.map((parentId) => after.childrenOf(parentId));
}

describe("needsChildrenBeforeMove", () => {
	const tree = (loaded: Record<string, boolean>): BlockMoveTree => ({
		...rowTree([{id: "delta"}]),
		childrenLoaded: (id) => loaded[id] ?? true,
	});

	it("is true for a collapsed row whose children are not cached", () => {
		expect(needsChildrenBeforeMove(tree({delta: false}), "delta")).toBe(true);
	});

	it("is false for a loaded row, a leaf and home", () => {
		expect([
			needsChildrenBeforeMove(tree({delta: true}), "delta"),
			needsChildrenBeforeMove(tree({}), "leaf"),
			needsChildrenBeforeMove(tree({delta: false}), null),
		]).toStrictEqual([false, false, false]);
	});

	it("is false when the tree cannot say", () => {
		expect(needsChildrenBeforeMove(rowTree([{id: "delta"}]), "delta")).toBe(false);
	});
});

describe("planBlockMove", () => {
	const root = (): Row[] => [{id: "delta"}, {id: "charlie"}, {id: "bravo"}, {id: "alpha"}];

	it("moves a run down past the next sibling as one block, decided by its last row", () => {
		const tree = rowTree(root());
		const plan = planBlockMove(["charlie", "bravo"], "down", tree);
		expect(plan).toStrictEqual([{ids: ["charlie", "bravo"], parentId: null, index: 4}]);
		expect(afterMoves(tree, plan, [null])).toStrictEqual([["delta", "alpha", "charlie", "bravo"]]);
	});

	it("moves a run up past the previous sibling as one block, decided by its first row", () => {
		const tree = rowTree(root());
		const plan = planBlockMove(["charlie", "bravo"], "up", tree);
		expect(plan).toStrictEqual([{ids: ["charlie", "bravo"], parentId: null, index: 0}]);
		expect(afterMoves(tree, plan, [null])).toStrictEqual([["charlie", "bravo", "delta", "alpha"]]);
	});

	it("gathers separate runs into one contiguous block at the target", () => {
		const tree = rowTree([{id: "delta"}, {id: "charlie"}, {id: "bravo"}, {id: "alpha"}, {id: "echo"}]);
		const plan = planBlockMove(["charlie", "alpha"], "down", tree);
		expect(plan).toStrictEqual([{ids: ["charlie", "alpha"], parentId: null, index: 5}]);
		expect(afterMoves(tree, plan, [null])).toStrictEqual([["delta", "bravo", "echo", "charlie", "alpha"]]);
	});

	it("crosses into the parent's sibling at the edge, as a single-row move would", () => {
		const tree = rowTree([
			{id: "alpha", expanded: true, children: [{id: "a1"}, {id: "a2"}]},
			{id: "bravo", children: [{id: "b1"}]},
		]);
		const plan = planBlockMove(["a1", "a2"], "down", tree);
		expect(plan).toStrictEqual([{ids: ["a1", "a2"], parentId: "bravo", index: 0}]);
		expect(afterMoves(tree, plan, ["alpha", "bravo"])).toStrictEqual([[], ["a1", "a2", "b1"]]);
	});

	it("does nothing when there is nowhere to go or the zoom root is selected", () => {
		const tree = rowTree(root());
		expect([
			planBlockMove(["delta", "charlie"], "up", tree),
			planBlockMove(["alpha"], "down", tree),
			planBlockMove([], "down", tree),
			planBlockMove(["charlie"], "down", tree, "charlie"),
		]).toStrictEqual([[], [], [], []]);
	});

	it("indents a run as the last children of the previous sibling, in order", () => {
		const tree = rowTree([{id: "alpha", children: [{id: "a1"}]}, {id: "charlie"}, {id: "bravo"}]);
		const plan = planBlockMove(["charlie", "bravo"], "indent", tree);
		expect(plan).toStrictEqual([{ids: ["charlie", "bravo"], parentId: "alpha", index: 1}]);
		expect(afterMoves(tree, plan, [null, "alpha"])).toStrictEqual([["alpha"], ["a1", "charlie", "bravo"]]);
	});

	it("indents runs in reverse order, each under its own previous sibling", () => {
		const tree = rowTree([{id: "alpha"}, {id: "bravo"}, {id: "charlie"}, {id: "delta"}]);
		const plan = planBlockMove(["bravo", "delta"], "indent", tree);
		expect(plan).toStrictEqual([
			{ids: ["delta"], parentId: "charlie", index: 0},
			{ids: ["bravo"], parentId: "alpha", index: 0},
		]);
		expect(afterMoves(tree, plan, [null, "alpha", "charlie"])).toStrictEqual([
			["alpha", "charlie"],
			["bravo"],
			["delta"],
		]);
	});

	it("skips a run with no previous sibling, and lands at the bottom when the new parent's children are unloaded", () => {
		const tree: BlockMoveTree = {
			...rowTree([{id: "alpha"}, {id: "bravo"}, {id: "charlie"}]),
			childrenLoaded: (id) => id !== "bravo",
		};
		expect(planBlockMove(["alpha", "charlie"], "indent", tree)).toStrictEqual([
			{ids: ["charlie"], parentId: "bravo"},
		]);
	});

	it("outdents runs in reverse order to just after their parent, keeping their order", () => {
		const tree = rowTree([
			{id: "alpha", children: [{id: "a1"}, {id: "a2"}, {id: "a3"}, {id: "a4"}]},
			{id: "bravo"},
		]);
		const plan = planBlockMove(["a1", "a3", "a4"], "outdent", tree);
		expect(plan).toStrictEqual([
			{ids: ["a3", "a4"], parentId: null, index: 1},
			{ids: ["a1"], parentId: null, index: 1},
		]);
		expect(afterMoves(tree, plan, [null, "alpha"])).toStrictEqual([["alpha", "a1", "a3", "a4", "bravo"], ["a2"]]);
	});

	it("does not outdent out of Home or the zoomed page", () => {
		const tree = rowTree([{id: "alpha", children: [{id: "a1"}]}]);
		expect([
			planBlockMove(["alpha"], "outdent", tree),
			planBlockMove(["a1"], "outdent", tree, "alpha"),
		]).toStrictEqual([[], []]);
	});

	it("treats rows separated only by a hidden sibling as one run", () => {
		const tree = rowTree([{id: "alpha"}, {id: "bravo"}, {id: "done", hidden: true}, {id: "charlie"}]);
		expect(planBlockMove(["bravo", "charlie"], "indent", tree)).toStrictEqual([
			{ids: ["bravo", "charlie"], parentId: "alpha", index: 0},
		]);
	});
});

describe("cacheMoveTree", () => {
	it("reads parents and priority-ordered children from the cache, visibility from completion", () => {
		const done = node({id: "d", parent_id: "p", priority: 50, completedAt: 1});
		const qc = seed({root: [node({id: "p", priority: 1})], p: [siblings[1], done, siblings[0]]});
		const tree = cacheMoveTree(qc, {
			expandedIds: new Set(["p"]),
			showCompleted: false,
			animatingCompletionIds: new Set(),
		});
		expect([
			tree.parentOf("a"),
			tree.parentOf("p"),
			tree.childrenOf("p"),
			tree.childrenOf("a"),
			tree.isExpanded("p"),
			tree.isExpanded("a"),
			tree.isVisible("d"),
			tree.isVisible("a"),
		]).toStrictEqual(["p", null, ["d", "a", "b"], [], true, false, false, true]);
	});

	it("knows a row's children are loaded when they are cached or it has none", () => {
		const leaf = node({id: "leaf", priority: 2, hasChildren: false});
		const qc = seed({root: [node({id: "p", priority: 1}), leaf], p: siblings}, [leaf, ...siblings]);
		const tree = cacheMoveTree(qc, {
			expandedIds: new Set(),
			showCompleted: true,
			animatingCompletionIds: new Set(),
		});
		expect(["p", "leaf", "a"].map((id) => tree.childrenLoaded?.(id))).toStrictEqual([true, true, false]);
	});
});

describe("defaultIndexIn", () => {
	it("is the top without defaultToBottom", () => {
		expect([defaultIndexIn({defaultToBottom: false}, 3), defaultIndexIn({}, 3)]).toStrictEqual([0, 0]);
	});

	it("is the child count with defaultToBottom", () => {
		expect(defaultIndexIn({defaultToBottom: true}, 3)).toBe(3);
	});
});

describe("planAddChild", () => {
	it("appends an empty last child with the shape the caller computed", () => {
		expect(planAddChild({childCount: 3, zoomedId: "z", shapeLayout: "numbered"})).toStrictEqual({
			parent_id: "z",
			index: 3,
			name: "",
			layoutMode: "numbered",
			at_end: true,
		});
	});

	it("leaves the layout unset when the shape is none", () => {
		expect(planAddChild({childCount: 3, zoomedId: "z", shapeLayout: null})).toStrictEqual({
			parent_id: "z",
			index: 3,
			name: "",
			layoutMode: null,
			at_end: true,
		});
	});
});

describe("shapeLayoutFor", () => {
	it("maps each source layout to the new row's layout", () => {
		const cases = ["h2", "p", "numbered", "todo", null, "bullets"] as const;
		expect(cases.map((layoutMode) => shapeLayoutFor({layoutMode}, () => "x"))).toStrictEqual([
			"p",
			"p",
			"numbered",
			"todo",
			null,
			null,
		]);
	});

	it("defers every other layout to the fallback", () => {
		expect({
			code: shapeLayoutFor({layoutMode: "code-block"}, () => "todo"),
			board: shapeLayoutFor({layoutMode: "board"}, () => null),
		}).toStrictEqual({code: "todo", board: null});
	});
});

describe("isEmptyForReturn", () => {
	const row = {text: "", layoutMode: null, hasFile: false, isCalendarContainer: false, isTableCell: false};

	it("tests the name only", () => {
		expect({
			empty: isEmptyForReturn(row),
			text: isEmptyForReturn({...row, text: "a"}),
		}).toStrictEqual({empty: true, text: false});
	});

	it("never treats a divider, file row, calendar container or table cell as empty", () => {
		expect([
			isEmptyForReturn({...row, layoutMode: "divider"}),
			isEmptyForReturn({...row, hasFile: true}),
			isEmptyForReturn({...row, isCalendarContainer: true}),
			isEmptyForReturn({...row, isTableCell: true}),
		]).toStrictEqual([false, false, false, false]);
	});
});

describe("planToggleComplete", () => {
	it("completes every item when any item is not completed", () => {
		expect(
			planToggleComplete([
				{id: "a", completedAt: null},
				{id: "b", completedAt: 123},
			]),
		).toStrictEqual({action: "complete", ids: ["a", "b"]});
	});

	it("uncompletes every item when all items are completed", () => {
		expect(
			planToggleComplete([
				{id: "a", completedAt: 1},
				{id: "b", completedAt: 2},
			]),
		).toStrictEqual({action: "uncomplete", ids: ["a", "b"]});
	});

	it("does nothing for an empty list", () => {
		expect(planToggleComplete([])).toStrictEqual({action: "none", ids: []});
	});

	it("does nothing when any item is blocked (read-only or a backlink root)", () => {
		const nodes = [
			{id: "a", completedAt: null},
			{id: "b", completedAt: null},
		];
		expect([planToggleComplete(nodes, (id) => id === "b"), planToggleComplete(nodes, () => false)]).toStrictEqual([
			{action: "none", ids: []},
			{action: "complete", ids: ["a", "b"]},
		]);
	});
});

describe("isPotentiallyVisible", () => {
	it("keeps a completed row that is animating its completion while completed rows are hidden", () => {
		expect(isPotentiallyVisible({id: "c", completedAt: 1}, false, new Set(["c"]))).toBe(true);
	});

	it("hides a completed row that is not animating while completed rows are hidden", () => {
		expect(isPotentiallyVisible({id: "c", completedAt: 1}, false, new Set())).toBe(false);
	});

	it("shows a completed row when completed rows are shown", () => {
		expect(isPotentiallyVisible({id: "c", completedAt: 1}, true, new Set())).toBe(true);
	});

	it("shows an open row while completed rows are hidden", () => {
		expect(isPotentiallyVisible({id: "o", completedAt: null}, false, new Set())).toBe(true);
	});
});

describe("planSplit", () => {
	const base = {
		id: "n",
		parent_id: "p",
		index: 4,
		hasVisibleChildren: false,
		isExpanded: false,
		isZoomRoot: false,
		isEmpty: false,
		hasNextSibling: true,
		canOutdent: true,
	};

	it("creates the first card, expanding the column, on Enter at the end of a column title", () => {
		expect(
			planSplit({
				node: {...base, id: "bob", role: "column"},
				html: "Doing",
				selection: {start: 5, end: 5},
				shapeLayout: null,
			}),
		).toStrictEqual({
			kind: "create",
			parentId: "bob",
			index: 0,
			newName: "",
			currentName: "Doing",
			focus: "new",
			layoutMode: null,
			expand: "bob",
		});
	});

	it("puts the text before a mid caret in a new row above and keeps the rest in the current row", () => {
		expect(
			planSplit({node: base, html: "Bravo text", selection: {start: 5, end: 5}, shapeLayout: null}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 4,
			newName: "Bravo",
			currentName: " text",
			focus: "current",
			layoutMode: null,
		});
	});

	it("creates an empty row after when the caret is at the end", () => {
		expect(
			planSplit({node: base, html: "Bravo text", selection: {start: 10, end: 10}, shapeLayout: null}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 5,
			newName: "",
			currentName: "Bravo text",
			focus: "new",
			layoutMode: null,
		});
	});

	it("treats a caret inside trailing whitespace as the end", () => {
		expect(
			planSplit({node: base, html: "Bravo&nbsp; ", selection: {start: 5, end: 5}, shapeLayout: null}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 5,
			newName: "&nbsp; ",
			currentName: "Bravo",
			focus: "new",
			layoutMode: null,
		});
	});

	it("creates an empty row above when the caret is at the start of a non-empty row", () => {
		expect(
			planSplit({node: base, html: "Bravo text", selection: {start: 0, end: 0}, shapeLayout: null}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 4,
			newName: "",
			currentName: "Bravo text",
			focus: "new",
			layoutMode: null,
		});
	});

	it("drops a selection and splits around it", () => {
		expect(
			planSplit({node: base, html: "XyCharlie", selection: {start: 1, end: 3}, shapeLayout: null}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 4,
			newName: "X",
			currentName: "harlie",
			focus: "current",
			layoutMode: null,
		});
	});

	it("creates the first child of an expanded row with visible children when the caret is at the end", () => {
		expect(
			planSplit({
				node: {...base, hasVisibleChildren: true, isExpanded: true},
				html: "Bravo text",
				selection: {start: 10, end: 10},
				shapeLayout: null,
			}),
		).toStrictEqual({
			kind: "create",
			parentId: "n",
			index: 0,
			newName: "",
			currentName: "Bravo text",
			focus: "new",
			layoutMode: null,
		});
	});

	it("creates an empty first child of the zoom root and keeps its full text", () => {
		expect(
			planSplit({
				node: {...base, isZoomRoot: true},
				html: "<b>Bravo</b> text",
				selection: {start: 3, end: 3},
				shapeLayout: null,
			}),
		).toStrictEqual({
			kind: "create",
			parentId: "n",
			index: 0,
			newName: "",
			currentName: "<b>Bravo</b> text",
			focus: "new",
			layoutMode: null,
		});
	});

	it("outdents an empty last child instead of creating a row", () => {
		expect(
			planSplit({
				node: {...base, isEmpty: true, hasNextSibling: false},
				html: "",
				selection: {start: 0, end: 0},
				shapeLayout: null,
			}),
		).toStrictEqual({kind: "outdent"});
	});

	it("creates a row after an empty row that has a next sibling", () => {
		expect(
			planSplit({node: {...base, isEmpty: true}, html: "", selection: {start: 0, end: 0}, shapeLayout: null}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 5,
			newName: "",
			currentName: "",
			focus: "new",
			layoutMode: null,
		});
	});

	it("creates a row after an empty last child that cannot outdent", () => {
		expect(
			planSplit({
				node: {...base, isEmpty: true, hasNextSibling: false, canOutdent: false},
				html: "",
				selection: {start: 0, end: 0},
				shapeLayout: null,
			}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 5,
			newName: "",
			currentName: "",
			focus: "new",
			layoutMode: null,
		});
	});

	it("creates the new row with the shape the caller computed", () => {
		expect(
			planSplit({node: base, html: "Bravo text", selection: {start: 10, end: 10}, shapeLayout: "p"}),
		).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 5,
			newName: "",
			currentName: "Bravo text",
			focus: "new",
			layoutMode: "p",
		});
	});

	it("keeps the empty-name outdent whatever else the row holds", () => {
		expect(
			planSplit({
				node: {...base, isEmpty: true, hasNextSibling: false},
				html: "",
				selection: {start: 0, end: 0},
				shapeLayout: "todo",
			}),
		).toStrictEqual({kind: "outdent"});
	});
});

describe("applySplitPlan", () => {
	const plan = {
		kind: "create",
		parentId: "p",
		index: 4,
		newName: "Bravo",
		currentName: " text",
		focus: "current",
		layoutMode: null,
	} as const;

	it("renames the current row, creates the row above at the planner's index, and edits the current row at 0 for a mid caret", () => {
		expect(applySplitPlan(plan, "n", "Bravo text")).toStrictEqual([
			{type: "update", nodeId: "n", name: " text"},
			{type: "create", parent_id: "p", index: 4, name: "Bravo", layoutMode: null},
			{type: "edit", target: "current", caret: 0},
		]);
	});

	it("skips the rename when the current name is unchanged and edits the new row at 0 for an end caret", () => {
		expect(
			applySplitPlan(
				{...plan, index: 5, newName: "", currentName: "Bravo text", focus: "new", layoutMode: "todo"},
				"n",
				"Bravo text",
			),
		).toStrictEqual([
			{type: "create", parent_id: "p", index: 5, name: "", layoutMode: "todo"},
			{type: "edit", target: "new", caret: 0},
		]);
	});

	it("saves text typed before an end-caret Enter", () => {
		expect(
			applySplitPlan({...plan, index: 5, newName: "", currentName: "Bravo text", focus: "new"}, "n", "Bravo"),
		).toStrictEqual([
			{type: "update", nodeId: "n", name: "Bravo text"},
			{type: "create", parent_id: "p", index: 5, name: "", layoutMode: null},
			{type: "edit", target: "new", caret: 0},
		]);
	});
});

describe("planBackspaceAtStart / planDeleteAtEnd", () => {
	const row = {
		html: "",
		hasChildren: false,
		hasNote: false,
		completed: false,
		isMirror: false,
		hasMirrors: false,
		layoutMode: null,
	};
	const current = {...row, id: "cur", html: " text"};
	const bravo = {...row, id: "bravo", html: "Bravo"};

	it("merges the previous sibling's text into the start of the current row", () => {
		expect(planBackspaceAtStart({current, previousSibling: bravo})).toStrictEqual({
			kind: "merge",
			keepId: "cur",
			deleteId: "bravo",
			name: "Bravo text",
			caret: 5,
		});
	});

	it("refuses to merge a row that holds a file, in either direction", () => {
		expect([
			planBackspaceAtStart({current, previousSibling: {...bravo, hasFile: true}}),
			planBackspaceAtStart({current: {...current, hasFile: true}, previousSibling: bravo}),
			planDeleteAtEnd({current: {...current, hasFile: true}, nextSibling: bravo}),
			planDeleteAtEnd({current, nextSibling: {...bravo, hasFile: true}}),
		]).toStrictEqual([{kind: "none"}, {kind: "none"}, {kind: "none"}, {kind: "none"}]);
	});

	it("refuses when the previous sibling has a note", () => {
		expect(planBackspaceAtStart({current, previousSibling: {...bravo, hasNote: true}})).toStrictEqual({
			kind: "none",
		});
	});

	it("refuses when the previous row is the parent (no previous sibling)", () => {
		expect(planBackspaceAtStart({current, previousSibling: null})).toStrictEqual({kind: "none"});
	});

	it("refuses when the previous sibling is completed", () => {
		expect(planBackspaceAtStart({current, previousSibling: {...bravo, completed: true}})).toStrictEqual({
			kind: "none",
		});
	});

	it("refuses when the previous sibling has children, a mirror, a board, or a different layout", () => {
		expect(
			[
				{...bravo, hasChildren: true},
				{...bravo, isMirror: true},
				{...bravo, layoutMode: "board"},
				{...bravo, layoutMode: "todo"},
			].map((previousSibling) => planBackspaceAtStart({current, previousSibling})),
		).toStrictEqual([{kind: "none"}, {kind: "none"}, {kind: "none"}, {kind: "none"}]);
	});

	it("refuses when either side is a mirror, a mirrored original or a board", () => {
		expect([
			planBackspaceAtStart({current: {...current, isMirror: true}, previousSibling: bravo}),
			planBackspaceAtStart({current, previousSibling: {...bravo, hasMirrors: true}}),
			planBackspaceAtStart({current: {...current, hasMirrors: true}, previousSibling: bravo}),
			planDeleteAtEnd({
				current: {...row, id: "bravo", html: "Bravo", layoutMode: "board"},
				nextSibling: {...row, id: "alpha", html: "Alpha", layoutMode: "board"},
			}),
		]).toStrictEqual([{kind: "none"}, {kind: "none"}, {kind: "none"}, {kind: "none"}]);
	});

	it("merges two todo rows", () => {
		expect(
			planBackspaceAtStart({
				current: {...current, layoutMode: "todo"},
				previousSibling: {...bravo, layoutMode: "todo"},
			}),
		).toStrictEqual({kind: "merge", keepId: "cur", deleteId: "bravo", name: "Bravo text", caret: 5});
	});

	it("merges the current row into the start of the next sibling, which keeps its id", () => {
		expect(
			planDeleteAtEnd({
				current: {...row, id: "bravo", html: "Bravo text"},
				nextSibling: {...row, id: "alpha", html: "Alpha", hasChildren: true},
			}),
		).toStrictEqual({kind: "merge", keepId: "alpha", deleteId: "bravo", name: "Bravo textAlpha", caret: 10});
	});

	it("refuses Delete at the end when the current row is completed", () => {
		expect(
			planDeleteAtEnd({
				current: {...row, id: "bravo", html: "Bravo text", completed: true},
				nextSibling: {...row, id: "alpha", html: "Alpha"},
			}),
		).toStrictEqual({kind: "none"});
	});

	it("refuses Delete at the end of the last sibling", () => {
		expect(planDeleteAtEnd({current: {...row, id: "bravo", html: "Bravo"}, nextSibling: null})).toStrictEqual({
			kind: "none",
		});
	});
});

describe("dropIndex", () => {
	it("indexes the target among all siblings, the dragged row included", () => {
		expect([
			dropIndex(siblings, "b", "below"),
			dropIndex(siblings, "a", "above"),
			dropIndex(siblings, "c", "above"),
			dropIndex(siblings, "c", "below"),
		]).toStrictEqual([2, 0, 2, 3]);
	});

	it("lands a same-parent drag exactly next to the target when spliced", () => {
		expect([
			spliceChildren(siblings, siblings[0], dropIndex(siblings, "b", "below")).map((child) => child.id),
			spliceChildren(siblings, siblings[0], dropIndex(siblings, "c", "above")).map((child) => child.id),
			spliceChildren(siblings, siblings[2], dropIndex(siblings, "a", "below")).map((child) => child.id),
		]).toStrictEqual([
			["b", "a", "c"],
			["b", "a", "c"],
			["a", "c", "b"],
		]);
	});

	it("indexes a row dragged in from another parent the same way", () => {
		expect(dropIndex(siblings, "b", "below")).toBe(2);
	});

	it("orders siblings by priority", () => {
		expect(dropIndex([siblings[2], siblings[1], siblings[0]], "a", "above")).toBe(0);
	});
});

describe("nextPotentiallyVisibleSibling", () => {
	const sibs = [
		node({id: "c", parent_id: "p", priority: 2}),
		node({id: "a", parent_id: "p", priority: 0}),
		node({id: "b", parent_id: "p", priority: 1, completedAt: 1}),
	];

	it("skips a hidden completed sibling going forward", () => {
		expect(nextPotentiallyVisibleSibling(sibs, "a", 1, false)).toBe("c");
	});

	it("stops at a completed sibling when completed rows show", () => {
		expect(nextPotentiallyVisibleSibling(sibs, "a", 1, true)).toBe("b");
	});

	it("skips a hidden completed sibling going backward", () => {
		expect(nextPotentiallyVisibleSibling(sibs, "c", -1, false)).toBe("a");
	});

	it("returns null past the last sibling", () => {
		expect(nextPotentiallyVisibleSibling(sibs, "c", 1, false)).toBeNull();
	});

	it("returns null for an id that is not among the siblings", () => {
		expect(nextPotentiallyVisibleSibling(sibs, "x", 1, false)).toBeNull();
	});
});

describe("planFocusSibling", () => {
	const base = {zoomedId: "z", firstChildId: "a", firstInViewChildId: null, siblings: ["a", "b", "c"]};

	it("focuses the first in-view child with no current row, in either direction", () => {
		expect([
			planFocusSibling({...base, currentId: null, firstInViewChildId: "b"}, 1),
			planFocusSibling({...base, currentId: null, firstInViewChildId: "b"}, -1),
		]).toStrictEqual(["b", "b"]);
	});

	it("does nothing with no current row and no child in view", () => {
		expect([
			planFocusSibling({...base, currentId: null}, 1),
			planFocusSibling({...base, currentId: null}, -1),
		]).toStrictEqual([null, null]);
	});

	it("focuses the first child going forward from the zoomed title", () => {
		expect(planFocusSibling({...base, currentId: "z"}, 1)).toBe("a");
	});

	it("does nothing going backward from the zoomed title", () => {
		expect(planFocusSibling({...base, currentId: "z"}, -1)).toBeNull();
	});

	it("never goes back from the first child to the title", () => {
		expect(planFocusSibling({...base, currentId: "a"}, -1)).toBeNull();
	});

	it("moves from a middle row to its next sibling", () => {
		expect(planFocusSibling({...base, currentId: "b"}, 1)).toBe("c");
	});

	it("moves from a middle row to its previous sibling", () => {
		expect(planFocusSibling({...base, currentId: "b"}, -1)).toBe("a");
	});

	it("does nothing going forward from the last sibling", () => {
		expect(planFocusSibling({...base, currentId: "c"}, 1)).toBeNull();
	});

	it("does nothing going forward from the title of an empty zoomed page", () => {
		expect(planFocusSibling({...base, currentId: "z", firstChildId: null, siblings: []}, 1)).toBeNull();
	});
});

describe("planFocusParent", () => {
	const base = {zoomedId: "z", parentOf: {a1: "a", a: "z"}};

	it("goes from a row to its parent, and from a top-level row to the title", () => {
		expect([planFocusParent({...base, currentId: "a1"}), planFocusParent({...base, currentId: "a"})]).toStrictEqual(
			["a", "z"],
		);
	});

	it("does nothing on the title, and goes to the title with nothing focused", () => {
		expect([planFocusParent({...base, currentId: "z"}), planFocusParent({...base, currentId: null})]).toStrictEqual(
			[null, "z"],
		);
	});

	it("does nothing with nothing focused at Home, or for a row with no known parent", () => {
		expect([
			planFocusParent({zoomedId: null, parentOf: {}, currentId: null}),
			planFocusParent({...base, currentId: "x"}),
		]).toStrictEqual([null, null]);
	});
});

/** Replays move ops against plain id lists, using the move endpoint's slot-before-removal index. */
function replayMoves(lists: Record<string, string[]>, ops: UndoOp[]): Record<string, string[]> {
	const next = Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, [...list]]));
	for (const op of ops) {
		if (op.kind !== "move") {
			throw new Error(`unexpected ${op.kind}`);
		}
		const source = next[op.from.parentId ?? "root"] ?? [];
		const target = (next[op.to.parentId ?? "root"] ??= []);
		const at = target.slice(0, op.to.index).filter((id) => id !== op.nodeId).length;
		source.splice(source.indexOf(op.nodeId), 1);
		target.splice(at, 0, op.nodeId);
	}
	return next;
}

function undo(ops: UndoOp[]): UndoOp[] {
	const view = {zoomedNodeId: null, editing: null, selectedIds: []};
	return invertBatch({ops, before: view, after: view}).ops;
}

function ids(...names: string[]): NodeResponse[] {
	return names.map((id, index) => node({id, parent_id: "p", priority: (index + 1) * 100}));
}

describe("toUndoOps", () => {
	it("records a delete's parent and slot among ALL children, completed included", () => {
		const qc = seed({
			p: [
				node({id: "a", parent_id: "p", priority: 100}),
				node({id: "b", parent_id: "p", priority: 200, completedAt: 5}),
				node({id: "c", parent_id: "p", priority: 300}),
			],
		});
		expect(toUndoOps({kind: "delete", nodeId: "b"}, qc)).toStrictEqual([
			{kind: "delete", nodeId: "b", parentId: "p", index: 1},
		]);
	});

	it("records a root-level delete under the null parent", () => {
		const qc = seed({root: [node({id: "r1", priority: 100}), node({id: "r2", priority: 200})]});
		expect(toUndoOps({kind: "delete", nodeId: "r2"}, qc)).toStrictEqual([
			{kind: "delete", nodeId: "r2", parentId: null, index: 1},
		]);
	});

	it("records one create per mirror at consecutive slots, so undo deletes the mirrors", () => {
		const qc = seed({p: ids("a", "b", "c")});
		expect(toUndoOps({kind: "mirror", nodeIds: ["x", "y"], parentId: "p", index: 1}, qc)).toStrictEqual([
			{kind: "create", nodeId: "x", parentId: "p", index: 1},
			{kind: "create", nodeId: "y", parentId: "p", index: 2},
		]);
		expect(toUndoOps({kind: "mirror", nodeIds: ["z"], parentId: "p"}, qc)).toStrictEqual([
			{kind: "create", nodeId: "z", parentId: "p", index: 3},
		]);
	});

	it("records nothing for a delete of an uncached node", () => {
		expect(toUndoOps({kind: "delete", nodeId: "ghost"}, seed({}))).toStrictEqual([]);
	});

	it("turns planIndent's payload into one move with exact from and to slots", () => {
		const bKids = [node({id: "b1", parent_id: "b", priority: 100})];
		const qc = seed({p: siblings, b: bKids});
		const plan = planIndent(qc, siblings[2], new Set());
		if (plan === null) {
			throw new Error("expected an indent plan");
		}
		expect(
			toUndoOps({kind: "move", ids: [plan.nodeId], parentId: plan.parent_id, index: plan.index}, qc),
		).toStrictEqual([{kind: "move", nodeId: "c", from: {parentId: "p", index: 2}, to: {parentId: "b", index: 1}}]);
	});

	it("records one move per id of a block move, each with its own from-slot", () => {
		const qc = seed({p: ids("d", "c", "b", "a")});
		expect(toUndoOps({kind: "move", ids: ["c", "b"], parentId: "p", index: 2}, qc)).toStrictEqual([
			{kind: "move", nodeId: "c", from: {parentId: "p", index: 1}, to: {parentId: "p", index: 1}},
			{kind: "move", nodeId: "b", from: {parentId: "p", index: 2}, to: {parentId: "p", index: 2}},
		]);
	});

	it("encodes a same-parent move down as the endpoint's slot before removal, both ways", () => {
		const qc = seed({p: ids("a", "b", "c", "d")});
		const ops = toUndoOps({kind: "move", ids: ["b"], parentId: "p", index: 3}, qc);
		expect(ops).toStrictEqual([
			{kind: "move", nodeId: "b", from: {parentId: "p", index: 1}, to: {parentId: "p", index: 3}},
		]);
		const after = replayMoves({p: ["a", "b", "c", "d"]}, ops);
		expect(after).toStrictEqual({p: ["a", "c", "b", "d"]});
		expect(replayMoves(after, undo(ops))).toStrictEqual({p: ["a", "b", "c", "d"]});
	});

	it("round-trips a reordering block move within one parent", () => {
		const qc = seed({p: ids("a", "b", "c", "d", "e")});
		const ops = toUndoOps({kind: "move", ids: ["d", "b"], parentId: "p", index: 1}, qc);
		const after = replayMoves({p: ["a", "b", "c", "d", "e"]}, ops);
		expect(after).toStrictEqual({p: ["a", "d", "b", "c", "e"]});
		expect(replayMoves(after, undo(ops))).toStrictEqual({p: ["a", "b", "c", "d", "e"]});
	});

	it("round-trips a block move to another parent", () => {
		const qc = seed({p: ids("d", "c", "b", "a"), q: [node({id: "x", parent_id: "q", priority: 100})]});
		const ops = toUndoOps({kind: "move", ids: ["c", "b"], parentId: "q", index: 0}, qc);
		expect(ops).toStrictEqual([
			{kind: "move", nodeId: "c", from: {parentId: "p", index: 1}, to: {parentId: "q", index: 0}},
			{kind: "move", nodeId: "b", from: {parentId: "p", index: 1}, to: {parentId: "q", index: 1}},
		]);
		const after = replayMoves({p: ["d", "c", "b", "a"], q: ["x"]}, ops);
		expect(after).toStrictEqual({p: ["d", "a"], q: ["c", "b", "x"]});
		expect(replayMoves(after, undo(ops))).toStrictEqual({p: ["d", "c", "b", "a"], q: ["x"]});
	});

	it("sends an uncached target's bottom as an index past every child", () => {
		const qc = seed({p: siblings});
		expect(toUndoOps({kind: "move", ids: ["a"], parentId: "elsewhere"}, qc)).toStrictEqual([
			{
				kind: "move",
				nodeId: "a",
				from: {parentId: "p", index: 0},
				to: {parentId: "elsewhere", index: Number.MAX_SAFE_INTEGER},
			},
		]);
	});

	it("records a create at its exact slot, or the bottom when the index is omitted", () => {
		const qc = seed({p: siblings});
		expect([
			toUndoOps({kind: "create", nodeId: "n", parentId: "p", index: 1}, qc),
			toUndoOps({kind: "create", nodeId: "m", parentId: "p"}, qc),
		]).toStrictEqual([
			[{kind: "create", nodeId: "n", parentId: "p", index: 1}],
			[{kind: "create", nodeId: "m", parentId: "p", index: 3}],
		]);
	});

	it("records each changed text field with its cached before-value and skips unchanged ones", () => {
		const qc = seed({p: [node({id: "a", parent_id: "p", priority: 100, name: "old", note: "same"})]});
		expect(toUndoOps({kind: "edit", nodeId: "a", name: "new", note: "same"}, qc)).toStrictEqual([
			{kind: "edit", nodeId: "a", field: "name", before: "old", after: "new"},
		]);
	});

	it("records a layout change with the cached layoutMode and numberedStart", () => {
		const qc = seed({p: [node({id: "alice", parent_id: "p", priority: 100})]});
		expect(toUndoOps({kind: "edit", nodeId: "alice", layoutMode: "h2"}, qc)).toStrictEqual([
			{
				kind: "layout",
				nodeId: "alice",
				before: {layoutMode: null, numberedStart: null},
				after: {layoutMode: "h2", numberedStart: null},
			},
		]);
	});

	it("treats bullets and a null layoutMode as the same layout", () => {
		const qc = seed({
			p: [
				node({id: "plain", parent_id: "p", priority: 100}),
				node({id: "heading", parent_id: "p", priority: 200, data: {layoutMode: "h1"}}),
			],
		});
		expect([
			toUndoOps({kind: "edit", nodeId: "plain", layoutMode: "bullets"}, qc),
			toUndoOps({kind: "edit", nodeId: "heading", layoutMode: "bullets"}, qc),
		]).toStrictEqual([
			[],
			[
				{
					kind: "layout",
					nodeId: "heading",
					before: {layoutMode: "h1", numberedStart: null},
					after: {layoutMode: null, numberedStart: null},
				},
			],
		]);
	});

	it("records a numberedStart change and a name and layout change together as edit then layout", () => {
		const qc = seed({
			p: [
				node({
					id: "a",
					parent_id: "p",
					priority: 100,
					name: "old",
					data: {layoutMode: "numbered"},
					numberedStart: 3,
				}),
			],
		});
		expect([
			toUndoOps({kind: "edit", nodeId: "a", numberedStart: 7}, qc),
			toUndoOps({kind: "edit", nodeId: "a", name: "new", layoutMode: "h3"}, qc),
		]).toStrictEqual([
			[
				{
					kind: "layout",
					nodeId: "a",
					before: {layoutMode: "numbered", numberedStart: 3},
					after: {layoutMode: "numbered", numberedStart: 7},
				},
			],
			[
				{kind: "edit", nodeId: "a", field: "name", before: "old", after: "new"},
				{
					kind: "layout",
					nodeId: "a",
					before: {layoutMode: "numbered", numberedStart: 3},
					after: {layoutMode: "h3", numberedStart: 3},
				},
			],
		]);
	});

	it("treats a missing cached text as empty", () => {
		const qc = seed({p: [node({id: "a", parent_id: "p", priority: 100})]});
		expect(toUndoOps({kind: "edit", nodeId: "a", note: "hi"}, qc)).toStrictEqual([
			{kind: "edit", nodeId: "a", field: "note", before: "", after: "hi"},
		]);
	});

	it("records completion toggles and restores", () => {
		const qc = seed({});
		expect([
			toUndoOps({kind: "complete", nodeId: "a"}, qc),
			toUndoOps({kind: "uncomplete", nodeId: "a"}, qc),
			toUndoOps({kind: "restore", nodeId: "a", parentId: "p", index: 2}, qc),
		]).toStrictEqual([
			[{kind: "complete", nodeId: "a"}],
			[{kind: "uncomplete", nodeId: "a"}],
			[{kind: "undelete", nodeId: "a", parentId: "p", index: 2}],
		]);
	});
});

describe("planSplit in code and quote blocks", () => {
	const base = {
		id: "n",
		parent_id: "p",
		index: 4,
		hasVisibleChildren: false,
		isExpanded: false,
		isZoomRoot: false,
		isEmpty: false,
		hasNextSibling: true,
		canOutdent: true,
	};
	const code = {...base, layoutMode: "code-block"};
	const quote = {...base, layoutMode: "quote-block"};
	const plan = (row: typeof code, html: string, caret: number) =>
		planSplit({node: row, html, selection: {start: caret, end: caret}, shapeLayout: "code-block"});

	it("inserts a newline in a code block", () => {
		expect(plan(code, "a", 1)).toStrictEqual({kind: "newline"});
	});

	it("exits a code block after a blank line, dropping the two newlines", () => {
		expect(plan(code, "a\n\n", 3)).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 5,
			newName: "",
			currentName: "a",
			focus: "new",
			layoutMode: "code-block",
		});
	});

	it("inserts a newline in a quote, and exits after one newline", () => {
		expect([plan(quote, "q", 1), plan(quote, "q\n", 2)]).toStrictEqual([
			{kind: "newline"},
			{
				kind: "create",
				parentId: "p",
				index: 5,
				newName: "",
				currentName: "q",
				focus: "new",
				layoutMode: "code-block",
			},
		]);
	});

	it("keeps the zoom root's child-create plan", () => {
		expect(plan({...code, isZoomRoot: true}, "a", 1)).toStrictEqual({
			kind: "create",
			parentId: "n",
			index: 0,
			newName: "",
			currentName: "a",
			focus: "new",
			layoutMode: "code-block",
		});
	});

	it("keeps the exit run's text after the caret in the new row", () => {
		expect(plan(code, "a\n\nrest", 3)).toStrictEqual({
			kind: "create",
			parentId: "p",
			index: 5,
			newName: "rest",
			currentName: "a",
			focus: "new",
			layoutMode: "code-block",
		});
	});
});
