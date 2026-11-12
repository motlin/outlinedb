import type {FlatRow} from "./item-selection.js";

/**
 * Upstream `WF.Focus.maintain` (`b80`): after a selection command clears the selection and leaves focus on the body,
 * the caret goes to the end of the first selected row, else the row now at its old index under the same parent,
 * else the previous sibling, else the first visible row.
 */
export function caretAfterSelectionCommand({
	firstId,
	before,
	rows,
	selectionActive,
	editorFocused,
}: {
	firstId: string;
	before:
	{
		parentId: string | null;
		index: number;
	};
	rows: readonly FlatRow[];
	selectionActive: boolean;
	editorFocused: boolean;
}):
{
	id: string;
	offset: "end";
} | null
{
	if (selectionActive || editorFocused)
	{
		return null;
	}
	if (rows.some((row) => row.id === firstId))
	{
		return {
			id: firstId,
			offset: "end",
		};
	}
	const siblings = rows.filter((row) => row.parentId === before.parentId);
	const target = siblings[before.index] ?? siblings[before.index - 1] ?? rows[0];
	return target === undefined
		? null
		:
			{
				id: target.id,
				offset: "end",
			};
}

export interface FocusMaintainEnv
{
	/** The row whose caret is kept: the edited row, else the first selection entry in insertion order. */
	firstId: () => string | null;
	position: (id: string) =>
	{
		parentId: string | null;
		index: number;
	};
	rows: () => readonly FlatRow[];
	selectionActive: () => boolean;
	editorFocused: () => boolean;
	resume: (id: string) => void;
	/** Runs after the command's writes have settled into the cache and the store. */
	defer: (callback: () => void) => void;
}

/** Upstream `WF.Focus.maintain(fn)`: run `fn`, then restore the caret if it left the selection without one. */
export function maintainFocus(fn: () => void, env: FocusMaintainEnv): void
{
	const firstId = env.firstId();
	const before = firstId === null ? null : env.position(firstId);
	fn();
	if (firstId === null || before === null)
	{
		return;
	}
	env.defer(() =>
	{
		const caret = caretAfterSelectionCommand(
			{
				firstId,
				before,
				rows: env.rows(),
				selectionActive: env.selectionActive(),
				editorFocused: env.editorFocused(),
			},
		);
		if (caret !== null)
		{
			env.resume(caret.id);
		}
	});
}
