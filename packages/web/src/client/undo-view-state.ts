import {locationUrl} from "./location.js";
import {serializeWrite} from "./write-order.js";
import type {UndoBatch, UndoOp, ViewState} from "./undo-history.js";

type Editing = NonNullable<ViewState["editing"]>;

export interface RestorePlan
{
	/** The route to push when the saved zoom differs from the current one, else null. */
	navigateTo: string | null;
	/** The row and caret to focus, clamped to the restored text; null when nothing was being edited. */
	focus: Editing | null;
	/** The selection to restore; absent while an editor or input has focus, as upstream. */
	selectedIds?: string[];
}

/** Where to go, what to focus and what to select to put the user back in `target`, the view saved with an undo step. */
export function planRestore(
	current: ViewState,
	target: ViewState,
	textLength: number,
	editorFocused = false,
): RestorePlan
{
	const navigateTo =
		current.zoomedNodeId === target.zoomedNodeId
			? null
			: target.zoomedNodeId === null
				? "/"
				: locationUrl(
						{
							id: target.zoomedNodeId,
						},
					);
	const clamp = (offset: number): number => Math.max(0, Math.min(offset, textLength));
	const focus =
		target.editing === null
			? null
			:
				{
					...target.editing,
					start: clamp(target.editing.start),
					end: clamp(target.editing.end),
				};
	return editorFocused
		?
			{
				navigateTo,
				focus,
			}
		:
			{
				navigateTo,
				focus,
				selectedIds: target.selectedIds,
			};
}

export type UndoDirection = "undo" | "redo";

/** The app services an undo or redo touches; injected so tests can record the order. */
export interface UndoRunner
{
	/** Saves the edited row's pending text, which becomes its own undo step. */
	flush(): void;
	/**
	 * Pushes every issued mutation's undo step; undefined when that happened at once, else a promise for the
	 * steps still waiting on a reply.
	 */
	settled(): Promise<void> | undefined;
	pop(direction: UndoDirection, match?: (batch: UndoBatch) => boolean): UndoBatch | undefined;
	/** Leaves the editor so the replay does not write under the caret. */
	blur(): void;
	/** Keeps server answers from landing over the preview until the replay is done; returns the release. */
	hold(ops: readonly UndoOp[]): () => void;
	/** Writes the ops into the cache at once, so the outline shows the undo before the server answers. */
	preview(ops: readonly UndoOp[]): void;
	/** Replays the ops on the server. */
	apply(ops: readonly UndoOp[]): Promise<void>;
	/** Refetches the cache once no replay is left, so it matches the server. */
	reconcile(): Promise<void>;
	current(): ViewState;
	/** Whether a contentEditable or input has focus, which keeps the selection as it is. */
	editorFocused(): boolean;
	select(ids: readonly string[]): void;
	/** The restored text's plain length, for clamping the caret. */
	textLength(nodeId: string, field: Editing["field"]): number;
	/** Pushes the saved zoom (null for home). */
	zoomTo(nodeId: string | null): void;
	focus(target: Editing): void;
}

/** A popped step shown in the outline, with the release of its hold on server answers. */
interface Previewed
{
	batch: UndoBatch;
	release: () => void;
}

/**
 * Upstream undo/redo's instant half, after the flush and settle: pop, blur, apply the ops to the cache and
 * restore the view saved with the step (the pre-command view for undo, the post-command view for redo), not
 * the current one, so the outline updates without a round trip.
 */
function previewStep(
	direction: UndoDirection,
	runner: UndoRunner,
	match?: (batch: UndoBatch) => boolean,
): Previewed | undefined
{
	const batch = runner.pop(direction, match);
	if (batch === undefined)
	{
		return undefined;
	}
	runner.blur();
	const release = runner.hold(batch.ops);
	runner.preview(batch.ops);
	const target = batch.after;
	const length = target.editing === null ? 0 : runner.textLength(target.editing.nodeId, target.editing.field);
	const plan = planRestore(runner.current(), target, length, runner.editorFocused());
	if (plan.navigateTo !== null)
	{
		runner.zoomTo(target.zoomedNodeId);
	}
	if (plan.selectedIds !== undefined)
	{
		runner.select(plan.selectedIds);
	}
	if (plan.focus !== null)
	{
		runner.focus(plan.focus);
	}
	return {
		batch,
		release,
	};
}

/** Flushes the pending text, then previews once every step is pushed: synchronously when nothing awaits a reply. */
function previewUndo(
	direction: UndoDirection,
	runner: UndoRunner,
	match?: (batch: UndoBatch) => boolean,
): Previewed | undefined | Promise<Previewed | undefined>
{
	runner.flush();
	const waiting = runner.settled();
	return waiting === undefined
		? previewStep(direction, runner, match)
		: waiting.then(() => previewStep(direction, runner, match));
}

/** The latest press still waiting to preview; later presses queue behind it so each pops the step after the last. */
let waitingPreview: Promise<unknown> | undefined;
/** Presses still waiting to preview; once none is left, the next press previews in the keypress itself. */
let waitingPresses = 0;
/** Replays queued or running; the cache reconciles with the server once this drops to 0. */
let pendingReplays = 0;

function startPreview(
	direction: UndoDirection,
	runner: UndoRunner,
	match?: (batch: UndoBatch) => boolean,
): Previewed | undefined | Promise<Previewed | undefined>
{
	const previewed =
		waitingPreview === undefined
			? previewUndo(direction, runner, match)
			: waitingPreview.then(async () => previewUndo(direction, runner, match));
	if (previewed instanceof Promise)
	{
		waitingPresses++;
		waitingPreview = (async () =>
		{
			await previewed.catch(() => {});
			waitingPresses--;
			if (waitingPresses === 0)
			{
				waitingPreview = undefined;
			}
		})();
	}
	return previewed;
}

/**
 * Runs an undo or redo: each press previews at once (in the keypress itself when no step still awaits its
 * server reply), even while earlier presses still replay, so rapid ⌘Z steps back without waiting on the
 * server; only the replays are serialized (in line with text saves, see `serializeWrite`), and the cache
 * refetches once after the last of them so a middle refetch never lands over a later preview.
 */
export async function queueUndo(
	direction: UndoDirection,
	runner: UndoRunner,
	match?: (batch: UndoBatch) => boolean,
): Promise<void>
{
	const previewed = await startPreview(direction, runner, match);
	if (previewed === undefined)
	{
		return;
	}
	pendingReplays++;
	try
	{
		await serializeWrite(async () => runner.apply(previewed.batch.ops));
	}
	finally
	{
		previewed.release();
		pendingReplays--;
		if (pendingReplays === 0)
		{
			await runner.reconcile();
		}
	}
}
