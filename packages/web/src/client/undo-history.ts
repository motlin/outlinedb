import {create} from "zustand";

/** Upstream keeps at most this many undoable batches, dropping the oldest. */
export const UNDO_STACK_CAP = 100;

export interface Slot
{
	/** Null for the outline root. */
	parentId: string | null;
	index: number;
}

/** A node's layout as an undo step restores it; a null `layoutMode` is bullets. */
export interface LayoutState
{
	layoutMode: string | null;
	numberedStart: number | null;
}

/**
 * One reversible outline mutation. Delete is undone by restoring the ORIGINAL id, so redo of a
 * create also restores that id (`undelete`) rather than creating a fresh node.
 */
export type UndoOp =
	|
	  {
			kind: "edit";
			nodeId: string;
			field: "name" | "note";
			before: string;
			after: string;
	  }
	|
	  {
			kind: "create";
			nodeId: string;
			parentId: string | null;
			index: number;
	  }
	|
	  {
			kind: "delete";
			nodeId: string;
			parentId: string | null;
			index: number;
	  }
	|
	  {
			kind: "undelete";
			nodeId: string;
			parentId: string | null;
			index: number;
	  }
	|
	  {
			kind: "move";
			nodeId: string;
			from: Slot;
			to: Slot;
	  }
	|
	  {
			kind: "complete" | "uncomplete";
			nodeId: string;
	  }
	|
	  {
			kind: "layout";
			nodeId: string;
			before: LayoutState;
			after: LayoutState;
	  }
	/** A tag color change: a null color is no color assigned. */
	|
	  {
			kind: "tagColor";
			tag: string;
			before: string | null;
			after: string | null;
	  };

/** Where the user was looking and typing; restored on undo/redo but never itself an op. */
export interface ViewState
{
	zoomedNodeId: string | null;
	editing:
	{
		nodeId: string;
		field: "name" | "note";
		start: number;
		end: number;
		reversed?: boolean;
	} | null;
	/** The item selection's entry ids in lead order. */
	selectedIds: string[];
}

export interface UndoBatch
{
	ops: UndoOp[];
	before: ViewState;
	after: ViewState;
}

/** The undo step for changing `tag`'s color from what the cache holds now; null when nothing changes. */
export function tagColorOp(tag: string, before: string | undefined, after: string | null): UndoOp | null
{
	const previous = before ?? null;
	return previous === after
		? null
		:
			{
				kind: "tagColor",
				tag,
				before: previous,
				after,
			};
}

export function invertOp(op: UndoOp): UndoOp
{
	switch (op.kind)
	{
		case "edit":
			return {
				...op,
				before: op.after,
				after: op.before,
			};
		case "layout":
			return {
				...op,
				before: op.after,
				after: op.before,
			};
		case "tagColor":
			return {
				...op,
				before: op.after,
				after: op.before,
			};
		case "create":
		case "undelete":
			return {
				kind: "delete",
				nodeId: op.nodeId,
				parentId: op.parentId,
				index: op.index,
			};
		case "delete":
			return {
				kind: "undelete",
				nodeId: op.nodeId,
				parentId: op.parentId,
				index: op.index,
			};
		case "move":
			return {
				...op,
				from: op.to,
				to: op.from,
			};
		case "complete":
			return {
				kind: "uncomplete",
				nodeId: op.nodeId,
			};
		case "uncomplete":
		default:
			return {
				kind: "complete",
				nodeId: op.nodeId,
			};
	}
}

/** Whether two ops say the same thing, field by field. */
export function sameOp(left: UndoOp, right: UndoOp): boolean
{
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown
{
	if (value === null || typeof value !== "object")
	{
		return value;
	}
	return Object.fromEntries(
		Object.entries(value)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonical(entry)]),
	);
}

export function invertBatch(batch: UndoBatch): UndoBatch
{
	return {
		ops: batch.ops.map(invertOp).toReversed(),
		before: batch.after,
		after: batch.before,
	};
}

/**
 * Upstream-style undo/redo stacks. Both stacks hold batches already inverted relative to the
 * direction they will be applied in, so a pop returns exactly what to apply.
 */
export class UndoHistory
{
	private undoStack: UndoBatch[] = [];
	private redoStack: UndoBatch[] = [];

	constructor(
		private readonly onChange: (history: UndoHistory) => void = () =>
		{
		},
	)
	{
	}

	get canUndo(): boolean
	{
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean
	{
		return this.redoStack.length > 0;
	}

	push(batch: UndoBatch): void
	{
		if (batch.ops.length === 0)
		{
			return;
		}
		this.undoStack.push(invertBatch(batch));
		if (this.undoStack.length > UNDO_STACK_CAP)
		{
			this.undoStack.shift();
		}
		this.redoStack = [];
		this.onChange(this);
	}

	popUndo(): UndoBatch | undefined
	{
		const batch = this.undoStack.pop();
		if (batch === undefined)
		{
			return undefined;
		}
		this.redoStack.push(invertBatch(batch));
		this.onChange(this);
		return batch;
	}

	/** Pops the newest undo step `match` accepts, leaving the steps above it; undefined when none is left. */
	popUndoWhere(match: (batch: UndoBatch) => boolean): UndoBatch | undefined
	{
		const at = this.undoStack.findLastIndex(match);
		if (at === -1)
		{
			return undefined;
		}
		const [batch] = this.undoStack.splice(at, 1);
		if (batch === undefined)
		{
			return undefined;
		}
		this.redoStack.push(invertBatch(batch));
		this.onChange(this);
		return batch;
	}

	popRedo(): UndoBatch | undefined
	{
		const batch = this.redoStack.pop();
		if (batch === undefined)
		{
			return undefined;
		}
		this.undoStack.push(invertBatch(batch));
		this.onChange(this);
		return batch;
	}

	/**
	 * Corrects ops pushed before their mutation answered: each of `original` (in either direction, on
	 * either stack) becomes the matching op of `replacement`, or is dropped when there is none; a step
	 * left empty goes with it.
	 */
	replaceOps(original: readonly UndoOp[], replacement: readonly UndoOp[]): void
	{
		const swap = (batch: UndoBatch): UndoBatch =>
		{
			let ops = batch.ops;
			for (const [index, op] of original.entries())
			{
				const next = replacement[index];
				const forward = ops.findIndex((candidate) => sameOp(candidate, op));
				const inverse = forward === -1 ? ops.findIndex((candidate) => sameOp(candidate, invertOp(op))) : -1;
				const at = forward === -1 ? inverse : forward;
				if (at !== -1)
				{
					const swapped = next === undefined ? [] : [forward === -1 ? invertOp(next) : next];
					ops = ops.toSpliced(at, 1, ...swapped);
				}
			}
			return ops === batch.ops
				? batch
				:
					{
						...batch,
						ops,
					};
		};
		this.undoStack = this.undoStack.map(swap).filter((batch) => batch.ops.length > 0);
		this.redoStack = this.redoStack.map(swap).filter((batch) => batch.ops.length > 0);
		this.onChange(this);
	}

	clear(): void
	{
		this.undoStack = [];
		this.redoStack = [];
		this.onChange(this);
	}
}

interface UndoStore
{
	canUndo: boolean;
	canRedo: boolean;
}

export const useUndoStore = create<UndoStore>(() => (
{
	canUndo: false,
	canRedo: false,
}));

/** The app's single history; every change is mirrored into `useUndoStore` for rendering. */
export const undoHistory = new UndoHistory((history) =>
{
	useUndoStore.setState(
		{
			canUndo: history.canUndo,
			canRedo: history.canRedo,
		},
	);
});
