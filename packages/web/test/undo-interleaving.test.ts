import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {applyOps, holdUndoSlot, whenUndoSettled} from "../src/client/undo-batch.js";
import type {UndoAdapter} from "../src/client/undo-batch.js";
import {undoHistory} from "../src/client/undo-history.js";
import type {UndoOp} from "../src/client/undo-history.js";
import {queueUndo} from "../src/client/undo-view-state.js";
import type {UndoRunner} from "../src/client/undo-view-state.js";
import {serializeWrite} from "../src/client/write-order.js";

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore:
	{
		getState: () => (
		{
			zoomedNodeId: null,
			editingId: null,
			editingCaretOffset: null,
			editingNoteId: null,
			itemSelection:
			{
				entries: [],
				pivotId: null,
				retractableIds: [],
				counter: 0,
			},
			addErrorNotification()
			{
				return "id";
			},
		}),
	},
}));

/** One node's name on the server, in the query cache, and the requests still on the wire. */
interface World
{
	server: string;
	cache: string;
	inflight:
	{
		name: string;
		deliver(): void;
	}[];
}

async function send(world: World, name: string): Promise<void>
{
	return new Promise<void>((resolve) =>
	{
		world.inflight.push(
			{
				name,
				deliver()
				{
					world.server = name;
					resolve();
				},
			},
		);
	});
}

/** Delivers every request on the wire, newest first, so later writes reach the server before earlier ones. */
function deliverOutOfOrder(world: World): void
{
	const sent = world.inflight.splice(0);
	for (let index = sent.length - 1; index >= 0; index--)
	{
		sent[index]?.deliver();
	}
}

async function tick(): Promise<void>
{
	await new Promise<void>((resolve) =>
	{
		setTimeout(resolve, 0);
	});
}

/** Keeps delivering until `done` settles, as a slow network eventually answers everything. */
async function pump<T>(world: World, done: Promise<T>): Promise<T>
{
	const state =
	{
		finished: false,
	};
	const result = done.finally(() =>
	{
		state.finished = true;
	});
	while (!state.finished)
	{
		// oxlint-disable-next-line no-await-in-loop -- each round lets queued writes reach the wire
		await tick();
		deliverOutOfOrder(world);
	}
	return result;
}

/** The ⌘-click tag delete as `useUpdateNode` runs it: slot and before-text read at mutate time, write serialized. */
function deleteTag(world: World, tag: string): void
{
	const before = world.cache;
	const after = before.replace(` #${tag}`, "");
	const slot = holdUndoSlot();
	world.cache = after;
	void (async () =>
	{
		await serializeWrite(async () => send(world, after));
		const op: UndoOp =
		{
			kind: "edit",
			nodeId: "n",
			field: "name",
			before,
			after,
		};
		slot.settle([op]);
	})();
}

function runnerFor(world: World): UndoRunner
{
	const adapter: UndoAdapter =
	{
		async updateNode(_nodeId, request)
		{
			return send(world, request.name ?? "");
		},
		deleteNode: async () => Promise.resolve(),
		restoreNode: async () => Promise.resolve(),
		moveNode: async () => Promise.resolve(),
		completeNode: async () => Promise.resolve(),
		uncompleteNode: async () => Promise.resolve(),
		updateLayout: async () => Promise.resolve(),
		setTagColor: async () => Promise.resolve(),
		removeTagColor: async () => Promise.resolve(),
	};
	return {
		flush()
		{
		},
		settled: whenUndoSettled,
		pop: (direction) => (direction === "undo" ? undoHistory.popUndo() : undoHistory.popRedo()),
		blur()
		{
		},
		hold: () => () =>
		{
		},
		preview(ops)
		{
			for (const op of ops)
			{
				if (op.kind === "edit")
				{
					world.cache = op.after;
				}
			}
		},
		async apply(ops)
		{
			await applyOps(ops, adapter);
		},
		async reconcile()
		{
			world.cache = world.server;
			return Promise.resolve();
		},
		current: () => (
		{
			zoomedNodeId: null,
			editing: null,
			selectedIds: [],
		}),
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
}

describe("rapid tag deletes interleaved with undo", () =>
{
	beforeEach(() =>
	{
		undoHistory.clear();
	});

	it("delete, delete, undo, delete, undo, undo restores the right text each time with responses out of order", async () =>
	{
		const world: World =
		{
			server: "x #a #b #c #d",
			cache: "x #a #b #c #d",
			inflight: [],
		};
		const runner = runnerFor(world);

		deleteTag(world, "a");
		deleteTag(world, "b");
		const firstUndo = queueUndo("undo", runner);
		await vi.waitFor(async () =>
		{
			await tick();
			deliverOutOfOrder(world);
			expect(world.cache).toBe("x #b #c #d");
		});

		// Issued while the first undo's replay is still on the wire.
		deleteTag(world, "c");
		expect(world.cache).toBe("x #b #d");
		const secondUndo = queueUndo("undo", runner);
		await pump(world, Promise.all([firstUndo, secondUndo]));
		expect(
			{
				server: world.server,
				cache: world.cache,
				canUndo: undoHistory.canUndo,
			},
		).toStrictEqual(
			{
				server: "x #b #c #d",
				cache: "x #b #c #d",
				canUndo: true,
			},
		);

		await pump(world, queueUndo("undo", runner));
		expect(
			{
				server: world.server,
				cache: world.cache,
				canUndo: undoHistory.canUndo,
			},
		).toStrictEqual(
			{
				server: "x #a #b #c #d",
				cache: "x #a #b #c #d",
				canUndo: false,
			},
		);
	});

	it("keeps undoing after a delete issued during a replay", async () =>
	{
		const world: World =
		{
			server: "x #a #b",
			cache: "x #a #b",
			inflight: [],
		};
		const runner = runnerFor(world);

		deleteTag(world, "a");
		await pump(world, whenUndoSettled());
		const undo = queueUndo("undo", runner);
		await vi.waitFor(() =>
		{
			expect(world.cache).toBe("x #a #b");
		});
		deleteTag(world, "b");
		await pump(world, undo);
		await pump(world, whenUndoSettled());
		expect(undoHistory.canUndo).toBe(true);

		await pump(world, queueUndo("undo", runner));
		expect(
			{
				server: world.server,
				cache: world.cache,
			},
		).toStrictEqual(
			{
				server: "x #a #b",
				cache: "x #a #b",
			},
		);
	});
});
