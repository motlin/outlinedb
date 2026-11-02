import {RequestStatusError} from "./request-error.js";
import {selectedIdsOf} from "./item-selection.js";
import {activeNoteContent, editorElement, selectionTextRange} from "./caret-dom.js";
import {useOutlineStore} from "./stores/outline.js";
import {sameOp, undoHistory} from "./undo-history.js";
import type {UndoOp, ViewState} from "./undo-history.js";

export {RequestStatusError};

/**
 * Statuses that mean the outline no longer matches the history: the node is gone (404), was
 * already restored elsewhere (409), or cannot be restored at all without the internal API (503).
 */
const INVALIDATING_FAILURES = new Map<number, string>([
	[404, "Couldn't undo: the item no longer exists"],
	[409, "Couldn't undo: the item was already restored"],
	[
		503,
		"Couldn't undo: undo of delete needs the workflowy.com internal API (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD)",
	],
]);

/** The server calls that replay an inverted batch; injected so tests can record them. */
export interface UndoAdapter
{
	updateNode(
		nodeId: string,
		request:
		{
			name?: string;
			note?: string;
		},
	): Promise<unknown>;
	deleteNode(nodeId: string): Promise<unknown>;
	restoreNode(
		nodeId: string,
		request:
		{
			parent_id: string | null;
			index: number;
		},
	): Promise<unknown>;
	moveNode(
		nodeId: string,
		request:
		{
			parent_id: string | null;
			index: number;
		},
	): Promise<unknown>;
	completeNode(nodeId: string): Promise<unknown>;
	uncompleteNode(nodeId: string): Promise<unknown>;
	updateLayout(
		nodeId: string,
		layout:
		{
			layoutMode: string;
			numberedStart: number | null;
		},
	): Promise<unknown>;
	setTagColor(tag: string, color: string): Promise<unknown>;
	removeTagColor(tag: string): Promise<unknown>;
}

/** One undo step being collected: an entry per recorded op or held mutation, in issue order. */
interface PendingBatch
{
	entries: UndoOp[][];
	before: ViewState;
	after: ViewState | undefined;
	/** Held mutations that have not settled yet. */
	pending: number;
	/** No further command can join; it pushes once `pending` reaches 0. */
	sealed: boolean;
}

/** The batch the running command joins, with its `runInUndoBatch` nesting depth. */
let open:
	|
	  {
			batch: PendingBatch;
			depth: number;
	  }
	| undefined;
/** Batches in the order their commands ran, so they push in that order however they settle. */
const queue: PendingBatch[] = [];
/**
 * Above 0 only while `applyOps` synchronously issues one replay request: anything recorded then is
 * the undo itself. It drops back before the request is awaited, so a command the user runs while a
 * slow replay is still on the wire records its own undo step.
 */
let replaying = 0;

function enqueue(before: ViewState): PendingBatch
{
	const batch: PendingBatch =
	{
		entries: [],
		before,
		after: undefined,
		pending: 0,
		sealed: false,
	};
	queue.push(batch);
	return batch;
}

/** Callers of `whenUndoSettled` waiting for the queue to drain. */
let settledWaiters: (() => void)[] = [];

/** Pushes every finished batch at the head of the queue as ONE undo step each. */
function flush(): void
{
	let head = queue[0];
	while (head?.sealed === true && head.pending === 0)
	{
		queue.shift();
		undoHistory.push(
			{
				ops: head.entries.flat(),
				before: head.before,
				after: head.after ?? captureOutlineView(),
			},
		);
		head = queue[0];
	}
	if (queue.length === 0 && settledWaiters.length > 0)
	{
		const waiters = settledWaiters;
		settledWaiters = [];
		for (const resolve of waiters)
		{
			resolve();
		}
	}
}

/**
 * Resolves once every command and mutation issued so far has pushed its undo step, so an undo
 * right after a flushed text save pops that save rather than the step before it.
 */
export async function whenUndoSettled(): Promise<void>
{
	if (queue.length === 0)
	{
		return;
	}
	await new Promise<void>((resolve) =>
	{
		settledWaiters.push(resolve);
	});
}

type ReadSelection = (
	nodeId: string,
	field: "name" | "note",
) =>
{
	start: number;
	end: number;
	reversed?: boolean;
} | null;

/** The live selection in `nodeId`'s rendered name or note editor; null without one (or without a DOM). */
function liveSelection(nodeId: string, field: "name" | "note"): ReturnType<ReadSelection>
{
	if (typeof document === "undefined")
	{
		return null;
	}
	const editor = field === "name" ? editorElement(nodeId) : activeNoteContent();
	return editor === null ? null : selectionTextRange(editor);
}

/**
 * The outline's zoom, caret and item selection: the focused editor's live selection (name or note) when it is
 * rendered (the store's caret is only where editing started), else the stored caret.
 */
export function captureOutlineView(readSelection: ReadSelection = liveSelection): ViewState
{
	const {zoomedNodeId, editingId, editingCaretOffset, editingNoteId, itemSelection} = useOutlineStore.getState();
	const selectedIds = selectedIdsOf(itemSelection);
	if (editingId !== null)
	{
		const caret = editingCaretOffset ?? 0;
		const {start, end, reversed} = readSelection(editingId, "name") ??
		{
			start: caret,
			end: caret,
		};
		return {
			zoomedNodeId,
			editing:
			{
				nodeId: editingId,
				field: "name",
				start,
				end,
				...(reversed === true
					?
						{
							reversed,
						}
					: {}),
			},
			selectedIds,
		};
	}
	if (editingNoteId === null)
	{
		return {
			zoomedNodeId,
			editing: null,
			selectedIds,
		};
	}
	const {start, end, reversed} = readSelection(editingNoteId, "note") ??
	{
		start: 0,
		end: 0,
	};
	return {
		zoomedNodeId,
		editing:
		{
			nodeId: editingNoteId,
			field: "note",
			start,
			end,
			...(reversed === true
				?
					{
						reversed,
					}
				: {}),
		},
		selectedIds,
	};
}

/** Opens a batch, or joins the outer one when a command runs inside another. */
function startBatch(before: ViewState): void
{
	if (open === undefined)
	{
		open =
		{
			batch: enqueue(before),
			depth: 1,
		};
	}
	else
	{
		open.depth++;
	}
}

/** Adds one mutation to the open batch; a mutation outside any batch is not undoable. */
export function recordOp(op: UndoOp): void
{
	if (replaying === 0)
	{
		open?.batch.entries.push([op]);
	}
}

/** Closes one nesting level; the outermost close seals the batch so the next command starts its own. */
function finishBatch(after: ViewState): void
{
	if (open === undefined)
	{
		return;
	}
	open.depth--;
	if (open.depth > 0)
	{
		return;
	}
	open.batch.after = after;
	open.batch.sealed = true;
	open = undefined;
	flush();
}

/** A reserved place in an undo step for a mutation whose ops are known only once it settles. */
export interface UndoSlot
{
	/** Settles the mutation with the ops it applied (none when it failed). */
	settle(ops: readonly UndoOp[]): void;
}

/** A held slot whose ops were known when it was issued; an undo may push them before the reply. */
interface ProvisionalSlot
{
	batch: PendingBatch;
	index: number;
	ops: readonly UndoOp[];
}

/** Held slots with known ops whose mutation has not answered yet. */
const provisionalSlots = new Set<ProvisionalSlot>();

/** Whether two op lists say the same thing, op by op. */
function sameOps(left: readonly UndoOp[], right: readonly UndoOp[]): boolean
{
	return (
		left.length === right.length &&
		left.every((op, index) =>
		{
			const other = right[index];
			return other !== undefined && sameOp(op, other);
		})
	);
}

/**
 * Reserves the next op slot for a mutation issued now, so its ops keep issue order. Inside a
 * command it joins that command's step, which waits for it; alone it is its own step. `provisional`
 * is the ops the mutation will apply as far as the cache knows at issue time: an undo pressed before
 * the reply pushes them at once (`settleUndoNow`), and the reply corrects them if it differs.
 */
export function holdUndoSlot(provisional?: readonly UndoOp[]): UndoSlot
{
	if (replaying > 0)
	{
		return {
			settle()
			{
			},
		};
	}
	let batch = open?.batch;
	if (batch === undefined)
	{
		batch = enqueue(captureOutlineView());
		batch.sealed = true;
	}
	const target = batch;
	const index = target.entries.push([]) - 1;
	target.pending++;
	const early =
		provisional === undefined
			? undefined
			:
				{
					batch: target,
					index,
					ops: [...provisional],
				};
	if (early !== undefined)
	{
		provisionalSlots.add(early);
	}
	let settled = false;
	return {
		settle(ops)
		{
			if (settled)
			{
				return;
			}
			settled = true;
			if (early !== undefined && !provisionalSlots.delete(early))
			{
				// An undo already took the provisional ops: correct them where they now are.
				if (!sameOps(early.ops, ops))
				{
					if (queue.includes(target))
					{
						target.entries[index] = [...ops];
					}
					else
					{
						undoHistory.replaceOps(early.ops, ops);
					}
				}
				return;
			}
			target.entries[index] = [...ops];
			target.pending--;
			flush();
		},
	};
}

/**
 * Settles every in-flight slot whose ops are already known with those ops, so an undo pressed now
 * pops the step the user just made without waiting on the server. Returns undefined once every step
 * is pushed, else a promise for the slots and commands that still need their reply.
 */
export function settleUndoNow(): Promise<void> | undefined
{
	for (const slot of provisionalSlots)
	{
		slot.batch.entries[slot.index] = [...slot.ops];
		slot.batch.pending--;
	}
	provisionalSlots.clear();
	flush();
	return queue.length === 0 ? undefined : whenUndoSettled();
}

/** Runs one user command as a single undo step, capturing the view before and after it. */
export async function runInUndoBatch<T>(captureView: () => ViewState, fn: () => T | Promise<T>): Promise<T>
{
	startBatch(captureView());
	try
	{
		return await fn();
	}
	finally
	{
		finishBatch(captureView());
	}
}

async function applyOp(op: UndoOp, adapter: UndoAdapter): Promise<unknown>
{
	switch (op.kind)
	{
		case "edit":
			return adapter.updateNode(
				op.nodeId,
				{
					[op.field]: op.after,
				},
			);
		case "delete":
			return adapter.deleteNode(op.nodeId);
		case "create":
		case "undelete":
			return adapter.restoreNode(
				op.nodeId,
				{
					parent_id: op.parentId,
					index: op.index,
				},
			);
		case "move":
			return adapter.moveNode(
				op.nodeId,
				{
					parent_id: op.to.parentId,
					index: op.to.index,
				},
			);
		case "complete":
			return adapter.completeNode(op.nodeId);
		case "layout":
			return adapter.updateLayout(
				op.nodeId,
				{
					layoutMode: op.after.layoutMode ?? "bullets",
					numberedStart: op.after.numberedStart,
				},
			);
		case "tagColor":
			return op.after === null ? adapter.removeTagColor(op.tag) : adapter.setTagColor(op.tag, op.after);
		case "uncomplete":
		default:
			return adapter.uncompleteNode(op.nodeId);
	}
}

/** Issues one replay request with recording suppressed, then awaits it with recording back on. */
async function issueReplay(op: UndoOp, adapter: UndoAdapter): Promise<unknown>
{
	replaying++;
	let request: Promise<unknown>;
	try
	{
		request = applyOp(op, adapter);
	}
	finally
	{
		replaying--;
	}
	return request;
}

/**
 * Replays a popped (already inverted) batch in order. A 404, 409 or 503 means the outline no longer
 * matches the history: report it, drop the rest of the batch and clear both stacks.
 */
export async function applyOps(ops: readonly UndoOp[], adapter: UndoAdapter): Promise<void>
{
	try
	{
		for (const op of ops)
		{
			// oxlint-disable-next-line no-await-in-loop -- inverses depend on the previous op's result (slots, parents)
			await issueReplay(op, adapter);
		}
	}
	catch (error)
	{
		const message = error instanceof RequestStatusError ? INVALIDATING_FAILURES.get(error.status) : undefined;
		if (message !== undefined)
		{
			useOutlineStore.getState().addErrorNotification(message);
			undoHistory.clear();
			return;
		}
		throw error;
	}
}
