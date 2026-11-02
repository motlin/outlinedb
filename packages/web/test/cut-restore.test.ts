import {describe, expect, it} from "vite-plus/test";
import {RequestStatusError} from "../src/client/request-error.js";
import {cutUndoMatch} from "../src/client/cut-registry.js";
import {pasteSteps} from "../src/client/paste/items.js";
import type {ItemPasteStep, PasteStepsIo} from "../src/client/paste/items.js";
import {UndoHistory} from "../src/client/undo-history.js";
import type {UndoBatch, UndoOp, ViewState} from "../src/client/undo-history.js";
import {queueUndo} from "../src/client/undo-view-state.js";
import type {UndoRunner} from "../src/client/undo-view-state.js";

const view: ViewState =
{
	zoomedNodeId: null,
	editing: null,
	selectedIds: [],
};

function deleteBatch(...nodeIds: string[]): UndoBatch
{
	return {
		ops: nodeIds.map((nodeId, index): UndoOp => (
		{
			kind: "delete",
			nodeId,
			parentId: "p",
			index,
		})),
		before: view,
		after: view,
	};
}

function editBatch(nodeId: string): UndoBatch
{
	return {
		ops: [
			{
				kind: "edit",
				nodeId,
				field: "name",
				before: "a",
				after: "b",
			},
		],
		before: view,
		after: view,
	};
}

describe("Restore after a cut", () =>
{
	it("pops the cut's own undo step, leaving the later edit on the stack", () =>
	{
		const history = new UndoHistory();
		history.push(deleteBatch("a", "b"));
		history.push(editBatch("other"));
		const popped = history.popUndoWhere(cutUndoMatch(["a", "b"]));
		expect(
			{
				popped: popped?.ops.map((op) => `${op.kind} ${"nodeId" in op ? op.nodeId : ""}`),
				next: history.popUndo()?.ops.map((op) => op.kind),
				canRedo: history.canRedo,
			},
		).toStrictEqual(
			{
				popped: ["undelete b", "undelete a"],
				next: ["edit"],
				canRedo: true,
			},
		);
	});

	it("finds nothing when the cut was already undone", () =>
	{
		const history = new UndoHistory();
		history.push(deleteBatch("a"));
		history.popUndo();
		expect(history.popUndoWhere(cutUndoMatch(["a"]))).toBeUndefined();
	});

	it("queueUndo applies only the matched step", async () =>
	{
		const history = new UndoHistory();
		history.push(deleteBatch("a"));
		history.push(editBatch("other"));
		const applied: UndoOp[][] = [];
		const runner: UndoRunner =
		{
			flush()
			{
			},
			settled: () =>
			{
			},
			pop: (direction, match) =>
				direction === "undo"
					? match === undefined
						? history.popUndo()
						: history.popUndoWhere(match)
					: history.popRedo(),
			blur()
			{
			},
			hold: () => () =>
			{
			},
			preview()
			{
			},
			apply: async (ops) =>
			{
				applied.push([...ops]);
				return Promise.resolve();
			},
			async reconcile()
			{
			},
			current: () => view,
			editorFocused: () => false,
			select()
			{
			},
			textLength: () => 0,
			zoomTo()
			{
			},
			focus()
			{
			},
		};
		await queueUndo("undo", runner, cutUndoMatch(["a"]));
		expect(applied).toStrictEqual([
			[
				{
					kind: "undelete",
					nodeId: "a",
					parentId: "p",
					index: 0,
				},
			],
		]);
	});
});

describe("pasteSteps", () =>
{
	const restoreSteps: ItemPasteStep[] = ["a", "b", "c"].map((id) => (
	{
		kind: "restore",
		shortId: id,
		id,
	}));

	function io(failAt: number):
	{
		io: PasteStepsIo;
		log: string[];
	}
	{
		const log: string[] = [];
		return {
			log,
			io:
			{
				restore: async (step, index) =>
				{
					if (index === failAt)
					{
						return Promise.reject(new RequestStatusError(409, "x"));
					}
					log.push(`restore ${step.id}@${index}`);
					return Promise.resolve();
				},
				copyFromCache: async () => Promise.resolve(undefined),
				mirror: async () => Promise.resolve(undefined),
				fallbackCopy: async (stepIndex, index) =>
				{
					log.push(`fallback ${stepIndex}@${index}`);
					return Promise.resolve(`new${stepIndex}`);
				},
			},
		};
	}

	it("falls back for the rest when the 2nd of 3 restores fails, so all 3 land", async () =>
	{
		const {io: value, log} = io(6);
		const result = await pasteSteps(restoreSteps, 5, value);
		expect(
			{
				result,
				log,
			},
		).toStrictEqual(
			{
				result:
				{
					unmovable: false,
					lastId: "new2",
					fellBack: true,
				},
				log: ["restore a@5", "fallback 1@6", "fallback 2@7"],
			},
		);
	});

	it("reports unmovable when the first restore fails", async () =>
	{
		const {io: value, log} = io(0);
		expect(
			{
				result: await pasteSteps(restoreSteps, 0, value),
				log,
			},
		).toStrictEqual(
			{
				result:
				{
					unmovable: true,
				},
				log: [],
			},
		);
	});

	it("rethrows other failures", async () =>
	{
		const value = io(9).io;
		value.restore = async () => Promise.reject(new RequestStatusError(500, "boom"));
		await expect(pasteSteps(restoreSteps, 0, value)).rejects.toThrow("boom");
	});
});
