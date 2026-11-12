import type {UndoBatch} from "./undo-history.js";

/**
 * The rows the last cut removed, by the 12-hex short id the copied html carries (`data-wfid`). A paste whose html
 * names a cut row moves it back with its original id (upstream `Item.pasteUnder` undeleting a deleted item); any
 * other row is a copy.
 */
export interface CutEntry
{
	id: string;
	cutAt: number;
}

const cut = new Map<string, CutEntry>();

function shortIdOf(id: string): string
{
	return id.replaceAll("-", "").slice(-12);
}

export function recordCut(ids: readonly string[], now: number = Date.now()): void
{
	for (const id of ids)
	{
		cut.set(
			shortIdOf(id),
			{
				id,
				cutAt: now,
			},
		);
	}
}

/** The cut entry for a short id, if that row is still waiting to be pasted. */
export function cutEntryFor(shortId: string): CutEntry | undefined
{
	return cut.get(shortId);
}

/** A cut row leaves the registry once it has been pasted back (it can move only once). */
export function forgetCut(shortId: string): void
{
	cut.delete(shortId);
}

export function clearCutRegistry(): void
{
	cut.clear();
}

/**
 * Matches the undo step of the cut that removed exactly `ids` (stored inverted, so every op is an undelete of one of
 * them and each id is covered), so Restore undoes that cut and never whatever step came last.
 */
export function cutUndoMatch(ids: readonly string[]): (batch: UndoBatch) => boolean
{
	const wanted = new Set(ids);
	return (batch) =>
		batch.ops.length > 0 &&
		batch.ops.every((op) => op.kind === "undelete" && wanted.has(op.nodeId)) &&
		ids.every((id) => batch.ops.some((op) => "nodeId" in op && op.nodeId === id));
}
