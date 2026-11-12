import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it, beforeEach, vi} from "vite-plus/test";
import {nodeKeys, readChildren, readDetail} from "../src/client/node-cache.js";
import {previewUndoOps} from "../src/client/undo-cache.js";
import type {NodeResponse} from "../src/node-types.js";
import {
	UNDO_STACK_CAP,
	UndoHistory,
	invertBatch,
	invertOp,
	undoHistory,
	useUndoStore,
} from "../src/client/undo-history.js";
import type {UndoBatch, UndoOp, ViewState} from "../src/client/undo-history.js";
import {locationUrl} from "../src/client/location.js";
import {planRestore, queueUndo} from "../src/client/undo-view-state.js";
import type {UndoRunner} from "../src/client/undo-view-state.js";

describe("undo cache", () => {
	function row(
		id: string,
		parentId: string | null,
		priority: number,
		extra: Partial<NodeResponse> = {},
	): NodeResponse {
		return {
			id,
			parent_id: parentId,
			name: id,
			note: null,
			priority,
			data: {layoutMode: null},
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
			...extra,
		};
	}

	function seeded(): QueryClient {
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children("P"), [row("a", "P", 100), row("b", "P", 200), row("c", "P", 300)]);
		queryClient.setQueryData(nodeKeys.children("Q"), [row("q", "Q", 100)]);
		queryClient.setQueryData(nodeKeys.detail("a"), row("a", "P", 100));
		return queryClient;
	}

	const ids = (rows: NodeResponse[] | undefined): [string, string | null][] =>
		(rows ?? []).map((node) => [node.id, node.parent_id]);

	describe("previewUndoOps", () => {
		it("moves a row within its list at the endpoint's before-removal slot", () => {
			const queryClient = seeded();
			previewUndoOps(queryClient, [
				{kind: "move", nodeId: "a", from: {parentId: "P", index: 0}, to: {parentId: "P", index: 3}},
			]);
			expect(ids(readChildren(queryClient, "P"))).toStrictEqual([
				["b", "P"],
				["c", "P"],
				["a", "P"],
			]);
		});

		it("replays a multi-row undo in order across parents and repoints the detail entry", () => {
			const queryClient = seeded();
			previewUndoOps(queryClient, [
				{kind: "move", nodeId: "b", from: {parentId: "P", index: 1}, to: {parentId: "Q", index: 0}},
				{kind: "move", nodeId: "a", from: {parentId: "P", index: 0}, to: {parentId: "Q", index: 2}},
			]);
			expect({
				P: ids(readChildren(queryClient, "P")),
				Q: ids(readChildren(queryClient, "Q")),
				detail: readDetail(queryClient, "a")?.parent_id,
			}).toStrictEqual({
				P: [["c", "P"]],
				Q: [
					["b", "Q"],
					["q", "Q"],
					["a", "Q"],
				],
				detail: "Q",
			});
		});

		it("patches an edited field everywhere the row is cached", () => {
			const queryClient = seeded();
			previewUndoOps(queryClient, [{kind: "edit", nodeId: "a", field: "name", before: "a", after: "a #tag"}]);
			expect([readChildren(queryClient, "P")?.[0]?.name, readDetail(queryClient, "a")?.name]).toStrictEqual([
				"a #tag",
				"a #tag",
			]);
		});

		it("completes and uncompletes rows", () => {
			const queryClient = seeded();
			queryClient.setQueryData(nodeKeys.children("Q"), [row("q", "Q", 100, {completedAt: 5})]);
			previewUndoOps(queryClient, [
				{kind: "complete", nodeId: "b"},
				{kind: "uncomplete", nodeId: "q"},
			]);
			expect([
				typeof readChildren(queryClient, "P")?.[1]?.completedAt,
				readChildren(queryClient, "Q")?.[0]?.completedAt,
			]).toStrictEqual(["number", null]);
		});

		it("removes a deleted row and puts it back at its slot when the same id is restored", () => {
			const queryClient = seeded();
			previewUndoOps(queryClient, [{kind: "delete", nodeId: "b", parentId: "P", index: 1}]);
			const afterDelete = ids(readChildren(queryClient, "P"));
			previewUndoOps(queryClient, [{kind: "undelete", nodeId: "b", parentId: "P", index: 1}]);
			expect({afterDelete, afterRestore: ids(readChildren(queryClient, "P"))}).toStrictEqual({
				afterDelete: [
					["a", "P"],
					["c", "P"],
				],
				afterRestore: [
					["a", "P"],
					["b", "P"],
					["c", "P"],
				],
			});
		});

		it("leaves the cache alone for a row it has never seen", () => {
			const queryClient = seeded();
			previewUndoOps(queryClient, [
				{kind: "move", nodeId: "ghost", from: {parentId: "P", index: 0}, to: {parentId: "Q", index: 0}},
				{kind: "undelete", nodeId: "ghost2", parentId: "P", index: 0},
			]);
			expect({P: ids(readChildren(queryClient, "P")), Q: ids(readChildren(queryClient, "Q"))}).toStrictEqual({
				P: [
					["a", "P"],
					["b", "P"],
					["c", "P"],
				],
				Q: [["q", "Q"]],
			});
		});
	});
});

describe("undo history", () => {
	const viewA: ViewState = {
		zoomedNodeId: null,
		editing: {nodeId: "a", field: "name", start: 1, end: 1},
		selectedIds: [],
	};
	const viewB: ViewState = {
		zoomedNodeId: "z",
		editing: {nodeId: "b", field: "note", start: 2, end: 4},
		selectedIds: ["c"],
	};

	function editBatch(nodeId: string, before = viewA, after = viewB): UndoBatch {
		return {ops: [{kind: "edit", nodeId, field: "name", before: "old", after: "new"}], before, after};
	}

	describe("invertOp", () => {
		it("swaps before and after of an edit", () => {
			expect(invertOp({kind: "edit", nodeId: "n", field: "note", before: "x", after: "y"})).toStrictEqual({
				kind: "edit",
				nodeId: "n",
				field: "note",
				before: "y",
				after: "x",
			});
		});

		it("swaps before and after of a layout change", () => {
			expect(
				invertOp({
					kind: "layout",
					nodeId: "n",
					before: {layoutMode: null, numberedStart: null},
					after: {layoutMode: "h2", numberedStart: 4},
				}),
			).toStrictEqual({
				kind: "layout",
				nodeId: "n",
				before: {layoutMode: "h2", numberedStart: 4},
				after: {layoutMode: null, numberedStart: null},
			});
		});

		it("turns a create into a delete of the same id and slot", () => {
			expect(invertOp({kind: "create", nodeId: "n", parentId: "p", index: 3})).toStrictEqual({
				kind: "delete",
				nodeId: "n",
				parentId: "p",
				index: 3,
			});
		});

		it("turns a delete into an undelete of the same id and slot", () => {
			expect(invertOp({kind: "delete", nodeId: "n", parentId: "p", index: 3})).toStrictEqual({
				kind: "undelete",
				nodeId: "n",
				parentId: "p",
				index: 3,
			});
		});

		it("turns an undelete into a delete of the same id and slot", () => {
			expect(invertOp({kind: "undelete", nodeId: "n", parentId: "p", index: 3})).toStrictEqual({
				kind: "delete",
				nodeId: "n",
				parentId: "p",
				index: 3,
			});
		});

		it("swaps from and to of a move", () => {
			expect(
				invertOp({kind: "move", nodeId: "n", from: {parentId: "p", index: 0}, to: {parentId: "q", index: 5}}),
			).toStrictEqual({
				kind: "move",
				nodeId: "n",
				from: {parentId: "q", index: 5},
				to: {parentId: "p", index: 0},
			});
		});

		it("turns complete into uncomplete and back", () => {
			expect(invertOp({kind: "complete", nodeId: "n"})).toStrictEqual({kind: "uncomplete", nodeId: "n"});
			expect(invertOp({kind: "uncomplete", nodeId: "n"})).toStrictEqual({kind: "complete", nodeId: "n"});
		});
	});

	describe("invertBatch", () => {
		it("inverts each op, reverses their order, and swaps the view states", () => {
			const ops: UndoOp[] = [
				{kind: "create", nodeId: "x", parentId: "p", index: 0},
				{kind: "edit", nodeId: "x", field: "name", before: "", after: "hi"},
			];
			expect(invertBatch({ops, before: viewA, after: viewB})).toStrictEqual({
				ops: [
					{kind: "edit", nodeId: "x", field: "name", before: "hi", after: ""},
					{kind: "delete", nodeId: "x", parentId: "p", index: 0},
				],
				before: viewB,
				after: viewA,
			});
		});

		it("redoing an undone create restores the same id", () => {
			const batch: UndoBatch = {
				ops: [{kind: "create", nodeId: "X", parentId: "p", index: 2}],
				before: viewA,
				after: viewB,
			};
			expect(invertBatch(invertBatch(batch))).toStrictEqual({
				ops: [{kind: "undelete", nodeId: "X", parentId: "p", index: 2}],
				before: viewA,
				after: viewB,
			});
		});
	});

	describe("UndoHistory", () => {
		it("starts empty", () => {
			const history = new UndoHistory();
			expect({canUndo: history.canUndo, canRedo: history.canRedo}).toStrictEqual({
				canUndo: false,
				canRedo: false,
			});
			expect(history.popUndo()).toBeUndefined();
			expect(history.popRedo()).toBeUndefined();
		});

		it("discards an empty batch", () => {
			const history = new UndoHistory();
			history.push({ops: [], before: viewA, after: viewB});
			expect(history.canUndo).toBe(false);
		});

		it("popUndo returns the inverted batch whose after is the original before", () => {
			const history = new UndoHistory();
			history.push(editBatch("n"));
			expect(history.popUndo()).toStrictEqual({
				ops: [{kind: "edit", nodeId: "n", field: "name", before: "new", after: "old"}],
				before: viewB,
				after: viewA,
			});
			expect({canUndo: history.canUndo, canRedo: history.canRedo}).toStrictEqual({canUndo: false, canRedo: true});
		});

		it("popRedo returns the original batch and makes it undoable again", () => {
			const history = new UndoHistory();
			history.push(editBatch("n"));
			history.popUndo();
			expect(history.popRedo()).toStrictEqual(editBatch("n"));
			expect({canUndo: history.canUndo, canRedo: history.canRedo}).toStrictEqual({canUndo: true, canRedo: false});
			expect(history.popUndo()).toStrictEqual(invertBatch(editBatch("n")));
		});

		it("a new push clears the redo stack", () => {
			const history = new UndoHistory();
			history.push(editBatch("a"));
			history.popUndo();
			history.push(editBatch("b"));
			expect({canUndo: history.canUndo, canRedo: history.canRedo}).toStrictEqual({canUndo: true, canRedo: false});
		});

		it("an empty push does not clear the redo stack", () => {
			const history = new UndoHistory();
			history.push(editBatch("a"));
			history.popUndo();
			history.push({ops: [], before: viewA, after: viewA});
			expect(history.canRedo).toBe(true);
		});

		it("drops the oldest batch past the cap", () => {
			const history = new UndoHistory();
			for (let i = 0; i <= UNDO_STACK_CAP; i++) {
				history.push(editBatch(`n${i}`));
			}
			const popped: (UndoBatch | undefined)[] = [];
			while (history.canUndo) {
				popped.push(history.popUndo());
			}
			expect(popped).toHaveLength(UNDO_STACK_CAP);
			expect(popped.at(-1)).toStrictEqual(invertBatch(editBatch("n1")));
		});

		it("clear empties both stacks", () => {
			const history = new UndoHistory();
			history.push(editBatch("a"));
			history.push(editBatch("b"));
			history.popUndo();
			history.clear();
			expect({canUndo: history.canUndo, canRedo: history.canRedo}).toStrictEqual({
				canUndo: false,
				canRedo: false,
			});
		});
	});

	describe("useUndoStore", () => {
		beforeEach(() => {
			undoHistory.clear();
		});

		it("mirrors the shared history's canUndo and canRedo", () => {
			expect(useUndoStore.getState()).toStrictEqual({canUndo: false, canRedo: false});
			undoHistory.push(editBatch("a"));
			expect(useUndoStore.getState()).toStrictEqual({canUndo: true, canRedo: false});
			undoHistory.popUndo();
			expect(useUndoStore.getState()).toStrictEqual({canUndo: false, canRedo: true});
			undoHistory.clear();
			expect(useUndoStore.getState()).toStrictEqual({canUndo: false, canRedo: false});
		});
	});
});

describe("undo view state", () => {
	const editing = (nodeId: string, start: number, end = start): ViewState["editing"] => ({
		nodeId,
		field: "name",
		start,
		end,
	});

	function idOf(op: {kind: string} | undefined): string | undefined {
		return op !== undefined && "nodeId" in op && typeof op.nodeId === "string" ? op.nodeId : undefined;
	}

	describe("planRestore", () => {
		it("stays on the page when the zoom matches and focuses the saved caret", () => {
			expect(
				planRestore(
					{zoomedNodeId: "z", editing: null, selectedIds: []},
					{zoomedNodeId: "z", editing: editing("a", 2, 4), selectedIds: []},
					10,
				),
			).toStrictEqual({navigateTo: null, focus: {nodeId: "a", field: "name", start: 2, end: 4}, selectedIds: []});
		});

		it("navigates to the saved zoom when it differs", () => {
			expect(
				planRestore(
					{zoomedNodeId: "z", editing: null, selectedIds: []},
					{zoomedNodeId: "y", editing: editing("a", 0), selectedIds: []},
					3,
				),
			).toStrictEqual({
				navigateTo: locationUrl({id: "y"}),
				focus: {nodeId: "a", field: "name", start: 0, end: 0},
				selectedIds: [],
			});
		});

		it("navigates home when the saved zoom is the root", () => {
			expect(
				planRestore(
					{zoomedNodeId: "z", editing: null, selectedIds: []},
					{zoomedNodeId: null, editing: null, selectedIds: []},
					0,
				),
			).toStrictEqual({
				navigateTo: "/",
				focus: null,
				selectedIds: [],
			});
		});

		it("clamps a caret past the end of the text", () => {
			expect(
				planRestore(
					{zoomedNodeId: null, editing: null, selectedIds: []},
					{zoomedNodeId: null, editing: editing("a", 12), selectedIds: []},
					5,
				),
			).toStrictEqual({navigateTo: null, focus: {nodeId: "a", field: "name", start: 5, end: 5}, selectedIds: []});
		});

		it("focuses nothing when nothing was being edited", () => {
			expect(
				planRestore(
					{zoomedNodeId: null, editing: editing("a", 1), selectedIds: []},
					{zoomedNodeId: null, editing: null, selectedIds: []},
					5,
				),
			).toStrictEqual({navigateTo: null, focus: null, selectedIds: []});
		});

		it("restores the saved selection when no editor has focus", () => {
			expect(
				planRestore(
					{zoomedNodeId: null, editing: null, selectedIds: []},
					{zoomedNodeId: null, editing: null, selectedIds: ["echo"]},
					0,
					false,
				),
			).toStrictEqual({navigateTo: null, focus: null, selectedIds: ["echo"]});
		});

		it("leaves the selection alone while an input has focus", () => {
			expect(
				planRestore(
					{zoomedNodeId: null, editing: null, selectedIds: []},
					{zoomedNodeId: null, editing: null, selectedIds: ["echo"]},
					0,
					true,
				),
			).toStrictEqual({navigateTo: null, focus: null});
		});
	});

	type Call = [string, ...unknown[]];

	const ops: UndoOp[] = [{kind: "uncomplete", nodeId: "a"}];
	const batch: UndoBatch = {
		ops,
		before: {zoomedNodeId: "z", editing: editing("b", 1), selectedIds: []},
		after: {zoomedNodeId: "y", editing: editing("a", 9), selectedIds: []},
	};

	function fakeRunner(popped: UndoBatch | undefined): {runner: UndoRunner; calls: Call[]} {
		const calls: Call[] = [];
		const runner: UndoRunner = {
			flush() {
				calls.push(["flush"]);
			},
			async settled() {
				calls.push(["settled"]);
				return Promise.resolve();
			},
			pop(direction) {
				calls.push(["pop", direction]);
				return popped;
			},
			blur() {
				calls.push(["blur"]);
			},
			hold(held) {
				calls.push(["hold", held]);
				return () => {
					calls.push(["release"]);
				};
			},
			preview(previewed) {
				calls.push(["preview", previewed]);
			},
			async apply(applied) {
				calls.push(["apply", applied]);
				return Promise.resolve();
			},
			async reconcile() {
				calls.push(["reconcile"]);
				return Promise.resolve();
			},
			current() {
				return {zoomedNodeId: "z", editing: null, selectedIds: []};
			},
			editorFocused() {
				return false;
			},
			select(ids) {
				calls.push(["select", ids]);
			},
			textLength(nodeId, field) {
				calls.push(["textLength", nodeId, field]);
				return 4;
			},
			zoomTo(nodeId) {
				calls.push(["zoomTo", nodeId]);
			},
			focus(target) {
				calls.push(["focus", target]);
			},
		};
		return {runner, calls};
	}

	describe("queueUndo", () => {
		it("flushes and waits before popping, previews the ops in the cache and restores the saved view before the server replay", async () => {
			const {runner, calls} = fakeRunner(batch);
			await queueUndo("undo", runner);
			expect(calls).toStrictEqual([
				["flush"],
				["settled"],
				["pop", "undo"],
				["blur"],
				["hold", ops],
				["preview", ops],
				["textLength", "a", "name"],
				["zoomTo", "y"],
				["select", []],
				["focus", {nodeId: "a", field: "name", start: 4, end: 4}],
				["apply", ops],
				["release"],
				["reconcile"],
			]);
		});

		it("previews within the press itself when every step is already pushed", async () => {
			const {runner, calls} = fakeRunner(batch);
			runner.settled = () => {
				calls.push(["settled"]);
				return;
			};
			const undone = queueUndo("undo", runner);
			expect(calls.slice(0, 5)).toStrictEqual([["flush"], ["settled"], ["pop", "undo"], ["blur"], ["hold", ops]]);
			expect(calls.at(5)).toStrictEqual(["preview", ops]);
			await undone;
		});

		it("does nothing past the pop when the stack is empty", async () => {
			const {runner, calls} = fakeRunner(undefined);
			await queueUndo("redo", runner);
			expect(calls).toStrictEqual([["flush"], ["settled"], ["pop", "redo"]]);
		});

		it("previews rapid presses at once, serializes only the server replays and reconciles once they drain", async () => {
			const first: UndoOp[] = [{kind: "uncomplete", nodeId: "a"}];
			const second: UndoOp[] = [{kind: "complete", nodeId: "b"}];
			const stack = [second, first];
			const events: string[] = [];
			const releases: (() => void)[] = [];
			const {runner} = fakeRunner(batch);
			runner.pop = () => {
				const popped = stack.pop();
				return popped === undefined ? undefined : {...batch, ops: popped};
			};
			runner.preview = (previewed) => {
				events.push(`preview ${idOf(previewed[0])}`);
			};
			runner.apply = async (applied) => {
				events.push(`apply ${idOf(applied[0])}`);
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
				events.push(`applied ${idOf(applied[0])}`);
			};
			runner.reconcile = async () => {
				events.push("reconcile");
				return Promise.resolve();
			};
			const done = Promise.all([queueUndo("undo", runner), queueUndo("undo", runner)]);
			await vi.waitFor(() => {
				expect(events).toStrictEqual(["preview a", "apply a", "preview b"]);
			});
			releases.shift()?.();
			await vi.waitFor(() => {
				expect(events.at(-1)).toBe("apply b");
			});
			releases.shift()?.();
			await done;
			expect(events).toStrictEqual([
				"preview a",
				"apply a",
				"preview b",
				"applied a",
				"apply b",
				"applied b",
				"reconcile",
			]);
		});
	});
});
