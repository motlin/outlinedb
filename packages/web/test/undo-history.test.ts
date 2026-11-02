import {beforeEach, describe, expect, it} from "vite-plus/test";
import
{
	UNDO_STACK_CAP,
	UndoHistory,
	invertBatch,
	invertOp,
	undoHistory,
	useUndoStore,
} from "../src/client/undo-history.js";
import type {UndoBatch, UndoOp, ViewState} from "../src/client/undo-history.js";

const viewA: ViewState =
{
	zoomedNodeId: null,
	editing:
	{
		nodeId: "a",
		field: "name",
		start: 1,
		end: 1,
	},
	selectedIds: [],
};
const viewB: ViewState =
{
	zoomedNodeId: "z",
	editing:
	{
		nodeId: "b",
		field: "note",
		start: 2,
		end: 4,
	},
	selectedIds: ["c"],
};

function editBatch(nodeId: string, before = viewA, after = viewB): UndoBatch
{
	return {
		ops: [
			{
				kind: "edit",
				nodeId,
				field: "name",
				before: "old",
				after: "new",
			},
		],
		before,
		after,
	};
}

describe("invertOp", () =>
{
	it("swaps before and after of an edit", () =>
	{
		expect(
			invertOp(
				{
					kind: "edit",
					nodeId: "n",
					field: "note",
					before: "x",
					after: "y",
				},
			),
		).toStrictEqual(
			{
				kind: "edit",
				nodeId: "n",
				field: "note",
				before: "y",
				after: "x",
			},
		);
	});

	it("swaps before and after of a layout change", () =>
	{
		expect(
			invertOp(
				{
					kind: "layout",
					nodeId: "n",
					before:
					{
						layoutMode: null,
						numberedStart: null,
					},
					after:
					{
						layoutMode: "h2",
						numberedStart: 4,
					},
				},
			),
		).toStrictEqual(
			{
				kind: "layout",
				nodeId: "n",
				before:
				{
					layoutMode: "h2",
					numberedStart: 4,
				},
				after:
				{
					layoutMode: null,
					numberedStart: null,
				},
			},
		);
	});

	it("turns a create into a delete of the same id and slot", () =>
	{
		expect(
			invertOp(
				{
					kind: "create",
					nodeId: "n",
					parentId: "p",
					index: 3,
				},
			),
		).toStrictEqual(
			{
				kind: "delete",
				nodeId: "n",
				parentId: "p",
				index: 3,
			},
		);
	});

	it("turns a delete into an undelete of the same id and slot", () =>
	{
		expect(
			invertOp(
				{
					kind: "delete",
					nodeId: "n",
					parentId: "p",
					index: 3,
				},
			),
		).toStrictEqual(
			{
				kind: "undelete",
				nodeId: "n",
				parentId: "p",
				index: 3,
			},
		);
	});

	it("turns an undelete into a delete of the same id and slot", () =>
	{
		expect(
			invertOp(
				{
					kind: "undelete",
					nodeId: "n",
					parentId: "p",
					index: 3,
				},
			),
		).toStrictEqual(
			{
				kind: "delete",
				nodeId: "n",
				parentId: "p",
				index: 3,
			},
		);
	});

	it("swaps from and to of a move", () =>
	{
		expect(
			invertOp(
				{
					kind: "move",
					nodeId: "n",
					from:
					{
						parentId: "p",
						index: 0,
					},
					to:
					{
						parentId: "q",
						index: 5,
					},
				},
			),
		).toStrictEqual(
			{
				kind: "move",
				nodeId: "n",
				from:
				{
					parentId: "q",
					index: 5,
				},
				to:
				{
					parentId: "p",
					index: 0,
				},
			},
		);
	});

	it("turns complete into uncomplete and back", () =>
	{
		expect(
			invertOp(
				{
					kind: "complete",
					nodeId: "n",
				},
			),
		).toStrictEqual(
			{
				kind: "uncomplete",
				nodeId: "n",
			},
		);
		expect(
			invertOp(
				{
					kind: "uncomplete",
					nodeId: "n",
				},
			),
		).toStrictEqual(
			{
				kind: "complete",
				nodeId: "n",
			},
		);
	});
});

describe("invertBatch", () =>
{
	it("inverts each op, reverses their order, and swaps the view states", () =>
	{
		const ops: UndoOp[] = [
			{
				kind: "create",
				nodeId: "x",
				parentId: "p",
				index: 0,
			},
			{
				kind: "edit",
				nodeId: "x",
				field: "name",
				before: "",
				after: "hi",
			},
		];
		expect(
			invertBatch(
				{
					ops,
					before: viewA,
					after: viewB,
				},
			),
		).toStrictEqual(
			{
				ops: [
					{
						kind: "edit",
						nodeId: "x",
						field: "name",
						before: "hi",
						after: "",
					},
					{
						kind: "delete",
						nodeId: "x",
						parentId: "p",
						index: 0,
					},
				],
				before: viewB,
				after: viewA,
			},
		);
	});

	it("redoing an undone create restores the same id", () =>
	{
		const batch: UndoBatch =
		{
			ops: [
				{
					kind: "create",
					nodeId: "X",
					parentId: "p",
					index: 2,
				},
			],
			before: viewA,
			after: viewB,
		};
		expect(invertBatch(invertBatch(batch))).toStrictEqual(
			{
				ops: [
					{
						kind: "undelete",
						nodeId: "X",
						parentId: "p",
						index: 2,
					},
				],
				before: viewA,
				after: viewB,
			},
		);
	});
});

describe("UndoHistory", () =>
{
	it("starts empty", () =>
	{
		const history = new UndoHistory();
		expect(
			{
				canUndo: history.canUndo,
				canRedo: history.canRedo,
			},
		).toStrictEqual(
			{
				canUndo: false,
				canRedo: false,
			},
		);
		expect(history.popUndo()).toBeUndefined();
		expect(history.popRedo()).toBeUndefined();
	});

	it("discards an empty batch", () =>
	{
		const history = new UndoHistory();
		history.push(
			{
				ops: [],
				before: viewA,
				after: viewB,
			},
		);
		expect(history.canUndo).toBe(false);
	});

	it("popUndo returns the inverted batch whose after is the original before", () =>
	{
		const history = new UndoHistory();
		history.push(editBatch("n"));
		expect(history.popUndo()).toStrictEqual(
			{
				ops: [
					{
						kind: "edit",
						nodeId: "n",
						field: "name",
						before: "new",
						after: "old",
					},
				],
				before: viewB,
				after: viewA,
			},
		);
		expect(
			{
				canUndo: history.canUndo,
				canRedo: history.canRedo,
			},
		).toStrictEqual(
			{
				canUndo: false,
				canRedo: true,
			},
		);
	});

	it("popRedo returns the original batch and makes it undoable again", () =>
	{
		const history = new UndoHistory();
		history.push(editBatch("n"));
		history.popUndo();
		expect(history.popRedo()).toStrictEqual(editBatch("n"));
		expect(
			{
				canUndo: history.canUndo,
				canRedo: history.canRedo,
			},
		).toStrictEqual(
			{
				canUndo: true,
				canRedo: false,
			},
		);
		expect(history.popUndo()).toStrictEqual(invertBatch(editBatch("n")));
	});

	it("a new push clears the redo stack", () =>
	{
		const history = new UndoHistory();
		history.push(editBatch("a"));
		history.popUndo();
		history.push(editBatch("b"));
		expect(
			{
				canUndo: history.canUndo,
				canRedo: history.canRedo,
			},
		).toStrictEqual(
			{
				canUndo: true,
				canRedo: false,
			},
		);
	});

	it("an empty push does not clear the redo stack", () =>
	{
		const history = new UndoHistory();
		history.push(editBatch("a"));
		history.popUndo();
		history.push(
			{
				ops: [],
				before: viewA,
				after: viewA,
			},
		);
		expect(history.canRedo).toBe(true);
	});

	it("drops the oldest batch past the cap", () =>
	{
		const history = new UndoHistory();
		for (let i = 0; i <= UNDO_STACK_CAP; i++)
		{
			history.push(editBatch(`n${i}`));
		}
		const popped: (UndoBatch | undefined)[] = [];
		while (history.canUndo)
		{
			popped.push(history.popUndo());
		}
		expect(popped).toHaveLength(UNDO_STACK_CAP);
		expect(popped.at(-1)).toStrictEqual(invertBatch(editBatch("n1")));
	});

	it("clear empties both stacks", () =>
	{
		const history = new UndoHistory();
		history.push(editBatch("a"));
		history.push(editBatch("b"));
		history.popUndo();
		history.clear();
		expect(
			{
				canUndo: history.canUndo,
				canRedo: history.canRedo,
			},
		).toStrictEqual(
			{
				canUndo: false,
				canRedo: false,
			},
		);
	});
});

describe("useUndoStore", () =>
{
	beforeEach(() =>
	{
		undoHistory.clear();
	});

	it("mirrors the shared history's canUndo and canRedo", () =>
	{
		expect(useUndoStore.getState()).toStrictEqual(
			{
				canUndo: false,
				canRedo: false,
			},
		);
		undoHistory.push(editBatch("a"));
		expect(useUndoStore.getState()).toStrictEqual(
			{
				canUndo: true,
				canRedo: false,
			},
		);
		undoHistory.popUndo();
		expect(useUndoStore.getState()).toStrictEqual(
			{
				canUndo: false,
				canRedo: true,
			},
		);
		undoHistory.clear();
		expect(useUndoStore.getState()).toStrictEqual(
			{
				canUndo: false,
				canRedo: false,
			},
		);
	});
});
