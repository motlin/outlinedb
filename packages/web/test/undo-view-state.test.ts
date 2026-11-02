import {describe, expect, it, vi} from "vite-plus/test";
import {locationUrl} from "../src/client/location.js";
import {planRestore, queueUndo} from "../src/client/undo-view-state.js";
import type {UndoRunner} from "../src/client/undo-view-state.js";
import type {UndoBatch, UndoOp, ViewState} from "../src/client/undo-history.js";

const editing = (nodeId: string, start: number, end = start): ViewState["editing"] => (
{
	nodeId,
	field: "name",
	start,
	end,
});

function idOf(
	op:
		|
		  {
				kind: string;
		  }
		| undefined,
): string | undefined
{
	return op !== undefined && "nodeId" in op && typeof op.nodeId === "string" ? op.nodeId : undefined;
}

describe("planRestore", () =>
{
	it("stays on the page when the zoom matches and focuses the saved caret", () =>
	{
		expect(
			planRestore(
				{
					zoomedNodeId: "z",
					editing: null,
					selectedIds: [],
				},
				{
					zoomedNodeId: "z",
					editing: editing("a", 2, 4),
					selectedIds: [],
				},
				10,
			),
		).toStrictEqual(
			{
				navigateTo: null,
				focus:
				{
					nodeId: "a",
					field: "name",
					start: 2,
					end: 4,
				},
				selectedIds: [],
			},
		);
	});

	it("navigates to the saved zoom when it differs", () =>
	{
		expect(
			planRestore(
				{
					zoomedNodeId: "z",
					editing: null,
					selectedIds: [],
				},
				{
					zoomedNodeId: "y",
					editing: editing("a", 0),
					selectedIds: [],
				},
				3,
			),
		).toStrictEqual(
			{
				navigateTo: locationUrl(
					{
						id: "y",
					},
				),
				focus:
				{
					nodeId: "a",
					field: "name",
					start: 0,
					end: 0,
				},
				selectedIds: [],
			},
		);
	});

	it("navigates home when the saved zoom is the root", () =>
	{
		expect(
			planRestore(
				{
					zoomedNodeId: "z",
					editing: null,
					selectedIds: [],
				},
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: [],
				},
				0,
			),
		).toStrictEqual(
			{
				navigateTo: "/",
				focus: null,
				selectedIds: [],
			},
		);
	});

	it("clamps a caret past the end of the text", () =>
	{
		expect(
			planRestore(
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: [],
				},
				{
					zoomedNodeId: null,
					editing: editing("a", 12),
					selectedIds: [],
				},
				5,
			),
		).toStrictEqual(
			{
				navigateTo: null,
				focus:
				{
					nodeId: "a",
					field: "name",
					start: 5,
					end: 5,
				},
				selectedIds: [],
			},
		);
	});

	it("focuses nothing when nothing was being edited", () =>
	{
		expect(
			planRestore(
				{
					zoomedNodeId: null,
					editing: editing("a", 1),
					selectedIds: [],
				},
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: [],
				},
				5,
			),
		).toStrictEqual(
			{
				navigateTo: null,
				focus: null,
				selectedIds: [],
			},
		);
	});

	it("restores the saved selection when no editor has focus", () =>
	{
		expect(
			planRestore(
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: [],
				},
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: ["echo"],
				},
				0,
				false,
			),
		).toStrictEqual(
			{
				navigateTo: null,
				focus: null,
				selectedIds: ["echo"],
			},
		);
	});

	it("leaves the selection alone while an input has focus", () =>
	{
		expect(
			planRestore(
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: [],
				},
				{
					zoomedNodeId: null,
					editing: null,
					selectedIds: ["echo"],
				},
				0,
				true,
			),
		).toStrictEqual(
			{
				navigateTo: null,
				focus: null,
			},
		);
	});
});

type Call = [string, ...unknown[]];

const ops: UndoOp[] = [
	{
		kind: "uncomplete",
		nodeId: "a",
	},
];
const batch: UndoBatch =
{
	ops,
	before:
	{
		zoomedNodeId: "z",
		editing: editing("b", 1),
		selectedIds: [],
	},
	after:
	{
		zoomedNodeId: "y",
		editing: editing("a", 9),
		selectedIds: [],
	},
};

function fakeRunner(popped: UndoBatch | undefined):
{
	runner: UndoRunner;
	calls: Call[];
}
{
	const calls: Call[] = [];
	const runner: UndoRunner =
	{
		flush()
		{
			calls.push(["flush"]);
		},
		async settled()
		{
			calls.push(["settled"]);
			return Promise.resolve();
		},
		pop(direction)
		{
			calls.push(["pop", direction]);
			return popped;
		},
		blur()
		{
			calls.push(["blur"]);
		},
		hold(held)
		{
			calls.push(["hold", held]);
			return () =>
			{
				calls.push(["release"]);
			};
		},
		preview(previewed)
		{
			calls.push(["preview", previewed]);
		},
		async apply(applied)
		{
			calls.push(["apply", applied]);
			return Promise.resolve();
		},
		async reconcile()
		{
			calls.push(["reconcile"]);
			return Promise.resolve();
		},
		current()
		{
			return {
				zoomedNodeId: "z",
				editing: null,
				selectedIds: [],
			};
		},
		editorFocused()
		{
			return false;
		},
		select(ids)
		{
			calls.push(["select", ids]);
		},
		textLength(nodeId, field)
		{
			calls.push(["textLength", nodeId, field]);
			return 4;
		},
		zoomTo(nodeId)
		{
			calls.push(["zoomTo", nodeId]);
		},
		focus(target)
		{
			calls.push(["focus", target]);
		},
	};
	return {
		runner,
		calls,
	};
}

describe("queueUndo", () =>
{
	it("flushes and waits before popping, previews the ops in the cache and restores the saved view before the server replay", async () =>
	{
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
			[
				"focus",
				{
					nodeId: "a",
					field: "name",
					start: 4,
					end: 4,
				},
			],
			["apply", ops],
			["release"],
			["reconcile"],
		]);
	});

	it("previews within the press itself when every step is already pushed", async () =>
	{
		const {runner, calls} = fakeRunner(batch);
		runner.settled = () =>
		{
			calls.push(["settled"]);
			return;
		};
		const undone = queueUndo("undo", runner);
		expect(calls.slice(0, 5)).toStrictEqual([["flush"], ["settled"], ["pop", "undo"], ["blur"], ["hold", ops]]);
		expect(calls.at(5)).toStrictEqual(["preview", ops]);
		await undone;
	});

	it("does nothing past the pop when the stack is empty", async () =>
	{
		const {runner, calls} = fakeRunner(undefined);
		await queueUndo("redo", runner);
		expect(calls).toStrictEqual([["flush"], ["settled"], ["pop", "redo"]]);
	});

	it("previews rapid presses at once, serializes only the server replays and reconciles once they drain", async () =>
	{
		const first: UndoOp[] = [
			{
				kind: "uncomplete",
				nodeId: "a",
			},
		];
		const second: UndoOp[] = [
			{
				kind: "complete",
				nodeId: "b",
			},
		];
		const stack = [second, first];
		const events: string[] = [];
		const releases: (() => void)[] = [];
		const {runner} = fakeRunner(batch);
		runner.pop = () =>
		{
			const popped = stack.pop();
			return popped === undefined
				? undefined
				:
					{
						...batch,
						ops: popped,
					};
		};
		runner.preview = (previewed) =>
		{
			events.push(`preview ${idOf(previewed[0])}`);
		};
		runner.apply = async (applied) =>
		{
			events.push(`apply ${idOf(applied[0])}`);
			await new Promise<void>((resolve) =>
			{
				releases.push(resolve);
			});
			events.push(`applied ${idOf(applied[0])}`);
		};
		runner.reconcile = async () =>
		{
			events.push("reconcile");
			return Promise.resolve();
		};
		const done = Promise.all([queueUndo("undo", runner), queueUndo("undo", runner)]);
		await vi.waitFor(() =>
		{
			expect(events).toStrictEqual(["preview a", "apply a", "preview b"]);
		});
		releases.shift()?.();
		await vi.waitFor(() =>
		{
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
