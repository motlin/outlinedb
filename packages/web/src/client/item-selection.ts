/**
 * Pure multi-item selection model, mirroring upstream Workflowy's item selection: entries with a monotonic lead
 * order, ancestor subsumption, a ⇧-click pivot whose previous range retracts, and ⇧↑ / ⇧↓ expansion from the lead.
 */

export interface SelectionEntry
{
	id: string;
	leadOrder: number;
	subsumedIds: string[];
}

export interface SelectionState
{
	entries: SelectionEntry[];
	pivotId: string | null;
	retractableIds: string[];
	counter: number;
}

export interface TreeView
{
	zoomRootId: string;
	parentOf(id: string): string | null;
	/** The zoom root first, then the visible rows in display order. */
	visibleOrder: string[];
	nextPotentiallyVisibleSiblingOf(id: string): string | null;
	previousPotentiallyVisibleSiblingOf(id: string): string | null;
}

export type Direction = "up" | "down";

export function emptySelection(): SelectionState
{
	return {
		entries: [],
		pivotId: null,
		retractableIds: [],
		counter: 0,
	};
}

function exists(tree: TreeView, id: string): boolean
{
	return id === tree.zoomRootId || tree.parentOf(id) !== null;
}

function isDescendant(tree: TreeView, id: string, ancestorId: string): boolean
{
	for (let parent = tree.parentOf(id); parent !== null; parent = tree.parentOf(parent))
	{
		if (parent === ancestorId)
		{
			return true;
		}
	}
	return false;
}

/** The entry holding `id` itself or one of its ancestors. */
function coveringEntry(state: SelectionState, tree: TreeView, id: string): SelectionEntry | undefined
{
	const ids = new Set(state.entries.map((entry) => entry.id));
	for (let current: string | null = id; current !== null; current = tree.parentOf(current))
	{
		if (ids.has(current))
		{
			return state.entries.find((entry) => entry.id === current);
		}
	}
	return undefined;
}

export function isCovered(state: SelectionState, tree: TreeView, id: string): boolean
{
	return coveringEntry(state, tree, id) !== undefined;
}

/** Selects each id that exists and is not already covered; a selected ancestor subsumes its selected descendants. */
export function selectIds(state: SelectionState, tree: TreeView, ids: readonly string[]): SelectionState
{
	let entries = state.entries;
	let counter = state.counter;
	const covered = (id: string) =>
		isCovered(
			{
				...state,
				entries,
			},
			tree,
			id,
		);
	for (const id of ids)
	{
		if (!exists(tree, id) || covered(id))
		{
			continue;
		}
		const subsumed = entries.filter((entry) => isDescendant(tree, entry.id, id));
		counter += 1;
		entries = [
			...entries.filter((entry) => !subsumed.includes(entry)),
			{
				id,
				leadOrder: counter,
				subsumedIds: subsumed.map((entry) => entry.id),
			},
		];
	}
	return {
		...state,
		entries,
		counter,
	};
}

/** The selection's entry ids in lead order: what an undo step saves. */
export function selectedIdsOf(state: SelectionState): string[]
{
	return state.entries.toSorted((a, b) => a.leadOrder - b.leadOrder).map((entry) => entry.id);
}

/** A selection of `ids` with leads in the given order, rebuilt from what an undo step saved. */
export function selectionOf(ids: readonly string[]): SelectionState
{
	return {
		entries: ids.map((id, index) => (
		{
			id,
			leadOrder: index + 1,
			subsumedIds: [],
		})),
		pivotId: null,
		retractableIds: [],
		counter: ids.length,
	};
}

/** Whether `id` is itself a selection entry: the row that carries `.addedToSelection` (its nested `.project` covers the descendants). */
export function isEntry(state: SelectionState, id: string): boolean
{
	return state.entries.some((entry) => entry.id === id);
}

export function removeIds(state: SelectionState, ids: readonly string[]): SelectionState
{
	const removed = new Set(ids);
	return {
		...state,
		entries: state.entries.filter((entry) => !removed.has(entry.id)),
		pivotId: state.pivotId !== null && removed.has(state.pivotId) ? null : state.pivotId,
		retractableIds: state.retractableIds.filter((id) => !removed.has(id)),
	};
}

export function leadId(state: SelectionState): string | null
{
	let lead: SelectionEntry | null = null;
	for (const entry of state.entries)
	{
		if (lead === null || entry.leadOrder > lead.leadOrder)
		{
			lead = entry;
		}
	}
	return lead?.id ?? null;
}

/** The selected ids in display order; ids not currently visible sort last. */
export function sortedIds(state: SelectionState, tree: TreeView): string[]
{
	const position = (id: string) =>
	{
		const index = tree.visibleOrder.indexOf(id);
		return index === -1 ? Number.POSITIVE_INFINITY : index;
	};
	return state.entries.map((entry) => entry.id).toSorted((a, b) => position(a) - position(b));
}

/**
 * What an item command acts on (upstream's `commandTargets()`): the selection in display order, else the edited row.
 * `tree` is read only when items are selected, so keystrokes in the editor never walk the outline.
 */
export function commandTargets(state: SelectionState, tree: () => TreeView, editingId: string | null): string[]
{
	if (state.entries.length > 0)
	{
		return sortedIds(state, tree());
	}
	return editingId === null ? [] : [editingId];
}

/** ⌘/⌥-click: remove the covering entry, else select the row and make it the pivot. */
export function toggleClick(state: SelectionState, tree: TreeView, id: string): SelectionState
{
	const covering = coveringEntry(state, tree, id);
	if (covering !== undefined)
	{
		return removeIds(state, [covering.id]);
	}
	return {
		...selectIds(state, tree, [id]),
		pivotId: id,
		retractableIds: [],
	};
}

/** The next potentially visible sibling, climbing to an ancestor's next sibling below the zoom root; never descends. */
function stepDown(tree: TreeView, id: string): string | null
{
	for (
		let current: string | null = id;
		current !== null && current !== tree.zoomRootId;
		current = tree.parentOf(current)
	)
	{
		const sibling = tree.nextPotentiallyVisibleSiblingOf(current);
		if (sibling !== null)
		{
			return sibling;
		}
	}
	return null;
}

function previousVisible(tree: TreeView, id: string): string | null
{
	const index = tree.visibleOrder.indexOf(id);
	return index > 0 ? (tree.visibleOrder[index - 1] ?? null) : null;
}

function expandTarget(state: SelectionState, tree: TreeView, lead: string, dir: Direction): string | null
{
	if (lead === tree.zoomRootId)
	{
		return null;
	}
	if (dir === "down")
	{
		return stepDown(tree, lead);
	}
	const previous = previousVisible(tree, lead);
	if (previous !== null && isCovered(state, tree, previous))
	{
		return previous;
	}
	const sibling = tree.previousPotentiallyVisibleSiblingOf(lead);
	if (sibling !== null)
	{
		return sibling;
	}
	const parent = tree.parentOf(lead);
	return parent !== null && tree.visibleOrder.includes(parent) ? parent : null;
}

/** ⇧↑ / ⇧↓ with an item selection, working from the lead entry. */
export function expand(state: SelectionState, tree: TreeView, dir: Direction): SelectionState
{
	const lead = state.entries.find((entry) => entry.id === leadId(state));
	if (lead === undefined)
	{
		return state;
	}
	if (dir === "down" && lead.subsumedIds.length > 0)
	{
		return selectIds(removeIds(state, [lead.id]), tree, lead.subsumedIds);
	}
	const target = expandTarget(state, tree, lead.id, dir);
	if (target === null)
	{
		return state;
	}
	if (isCovered(state, tree, target))
	{
		return removeIds(state, [lead.id]);
	}
	const selected = selectIds(state, tree, [target]);
	const leadOrders = new Map(selected.entries.map((entry) => [entry.id, entry.leadOrder]));
	let counter = selected.counter;
	const step = (id: string) => (dir === "down" ? stepDown(tree, id) : previousVisible(tree, id));
	for (let beyond = step(target); beyond !== null && leadOrders.has(beyond); beyond = step(beyond))
	{
		counter += 1;
		leadOrders.set(beyond, counter);
	}
	return {
		...selected,
		entries: selected.entries.map((entry) => (
		{
			...entry,
			leadOrder: leadOrders.get(entry.id) ?? entry.leadOrder,
		})),
		counter,
	};
}

/** The rows walked from `from` to `to`: down by sibling-or-ancestor's-sibling (entering `to`'s ancestors), up by visible row. */
function walk(tree: TreeView, from: string, to: string): string[]
{
	const fromIndex = tree.visibleOrder.indexOf(from);
	const toIndex = tree.visibleOrder.indexOf(to);
	if (fromIndex === -1 || toIndex === -1)
	{
		return [to];
	}
	const rows = [from];
	let current: string | null = from;
	while (current !== null && current !== to)
	{
		if (toIndex < fromIndex)
		{
			current = previousVisible(tree, current);
		}
		else if (isDescendant(tree, to, current))
		{
			current = tree.visibleOrder[tree.visibleOrder.indexOf(current) + 1] ?? null;
		}
		else
		{
			current = stepDown(tree, current);
		}
		if (current !== null)
		{
			rows.push(current);
		}
	}
	return rows;
}

/** ⇧-click: retract the previous range, then select every row walked from the pivot to `id`. */
export function pivotTo(
	state: SelectionState,
	tree: TreeView,
	id: string,
	fallbackFocusedId: string | null,
): SelectionState
{
	const pivot = state.pivotId ?? leadId(state) ?? fallbackFocusedId ?? tree.visibleOrder[1] ?? null;
	if (pivot === null)
	{
		return state;
	}
	const retracted = removeIds(state, state.retractableIds);
	const selected = selectIds(retracted, tree, walk(tree, pivot, id));
	const before = new Set(retracted.entries.map((entry) => entry.id));
	return {
		...selected,
		pivotId: pivot,
		retractableIds: selected.entries.map((entry) => entry.id).filter((entryId) => !before.has(entryId)),
	};
}

/** ⇧↑ at the name's text start or ⇧↓ at its end ends editing and selects the row; mid-text and in notes it stays native. */
export function editorShiftArrowTakesOver({
	dir,
	start,
	end,
	length,
	inNote,
}: {
	dir: Direction;
	start: number;
	end: number;
	length: number;
	inNote: boolean;
}): boolean
{
	if (inNote)
	{
		return false;
	}
	return dir === "up" ? start === 0 : end >= length;
}

/** ⌘A selects items only once the row's whole text is already selected; the first ⌘A stays native. */
export function editorSelectAllTakesOver({start, end, length}: {start: number; end: number; length: number}): boolean
{
	return start === 0 && end >= length;
}

/** A navigable row in display order (the zoom root's title first when zoomed) and its parent. */
export interface FlatRow
{
	id: string;
	parentId: string | null;
}

/** Where editing resumes: a text offset, or the end of the row's text. */
export interface CaretTarget
{
	id: string;
	offset: number | "end";
}

export type ArrowDirection = "left" | "right" | "up" | "down";

/** The index of `id`'s last descendant among `rows` (its own index when it has none), or -1 when absent. */
function lastDescendantIndex(rows: readonly FlatRow[], id: string): number
{
	const index = rows.findIndex((row) => row.id === id);
	if (index === -1)
	{
		return -1;
	}
	const parents = new Map(rows.map((row) => [row.id, row.parentId]));
	const descends = (rowId: string) =>
	{
		for (let parent = parents.get(rowId) ?? null; parent !== null; parent = parents.get(parent) ?? null)
		{
			if (parent === id)
			{
				return true;
			}
		}
		return false;
	};
	let last = index;
	while (last + 1 < rows.length && descends(rows[last + 1]?.id ?? ""))
	{
		last += 1;
	}
	return last;
}

/**
 * A plain arrow with an item selection clears it and edits beside it: ← the first row's start; → the end of the last
 * row's last descendant; ↑ the start of the row above the first; ↓ the start of the row after the last row's
 * descendants, else the end of that last descendant. `ordered` is the selection in display order.
 */
export function caretAfterArrowClear(
	dir: ArrowDirection,
	ordered: readonly string[],
	rows: readonly FlatRow[],
): CaretTarget | null
{
	const first = ordered[0];
	const last = ordered.at(-1);
	if (first === undefined || last === undefined)
	{
		return null;
	}
	if (dir === "left")
	{
		return {
			id: first,
			offset: 0,
		};
	}
	if (dir === "up")
	{
		const above = rows[rows.findIndex((row) => row.id === first) - 1];
		return {
			id: above?.id ?? first,
			offset: 0,
		};
	}
	const end = lastDescendantIndex(rows, last);
	const endId = rows[end]?.id ?? last;
	if (dir === "right")
	{
		return {
			id: endId,
			offset: "end",
		};
	}
	const after = rows[end + 1];
	return after === undefined
		?
			{
				id: endId,
				offset: "end",
			}
		:
			{
				id: after.id,
				offset: 0,
			};
}

/** Where editing resumes after deleting the selection: the end of the row above it, else the start of the row after it. */
export function deleteCaretTarget(ordered: readonly string[], rows: readonly FlatRow[]): CaretTarget | null
{
	const first = ordered[0];
	const last = ordered.at(-1);
	if (first === undefined || last === undefined)
	{
		return null;
	}
	const above = rows[rows.findIndex((row) => row.id === first) - 1];
	if (above !== undefined)
	{
		return {
			id: above.id,
			offset: "end",
		};
	}
	const after = rows[lastDescendantIndex(rows, last) + 1];
	return after === undefined
		? null
		:
			{
				id: after.id,
				offset: 0,
			};
}

export type SelectionDeletePlan =
	|
	  {
			kind: "zoom-out";
			parentId: string | null;
	  }
	|
	  {
			kind: "edit-beside";
			target: CaretTarget | null;
	  };

/**
 * What the view does when the selected items (`ordered`) are deleted. Upstream's `np` zooms out to the parent when
 * the selected zoom root itself goes (Home when it is top-level); otherwise editing resumes beside the deleted rows.
 */
export function selectionDeletePlan(
	ordered: readonly string[],
	rows: readonly FlatRow[],
	zoomedId: string | null,
	parentOf: (id: string) => string | null,
): SelectionDeletePlan
{
	if (zoomedId !== null && ordered.includes(zoomedId))
	{
		return {
			kind: "zoom-out",
			parentId: parentOf(zoomedId),
		};
	}
	return {
		kind: "edit-beside",
		target: deleteCaretTarget(ordered, rows),
	};
}

/** The keys an item selection owns while focus is off the editors (upstream's hotkeys enabled while it has entries). */
export type SelectionKeyAction =
	| "EXPAND_UP"
	| "EXPAND_DOWN"
	| "SELECT_ALL"
	| "CLEAR_LEFT"
	| "CLEAR_RIGHT"
	| "CLEAR_UP"
	| "CLEAR_DOWN"
	| "DELETE";

const PLAIN_SELECTION_KEYS: Readonly<Record<string, SelectionKeyAction>> =
{
	ArrowLeft: "CLEAR_LEFT",
	ArrowRight: "CLEAR_RIGHT",
	ArrowUp: "CLEAR_UP",
	ArrowDown: "CLEAR_DOWN",
	Backspace: "DELETE",
	Delete: "DELETE",
};

/** Classify a keydown made while items are selected, or null when the selection leaves it alone. */
export function selectionKeyAction(
	event:
	{
		key: string;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	},
	isMac: boolean,
): SelectionKeyAction | null
{
	const {key, metaKey, ctrlKey, altKey, shiftKey} = event;
	if (altKey)
	{
		return null;
	}
	const mod = isMac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
	if (mod)
	{
		return !shiftKey && key === "a" ? "SELECT_ALL" : null;
	}
	if (metaKey || ctrlKey)
	{
		return null;
	}
	if (shiftKey)
	{
		if (key === "ArrowUp")
		{
			return "EXPAND_UP";
		}
		return key === "ArrowDown" ? "EXPAND_DOWN" : null;
	}
	return PLAIN_SELECTION_KEYS[key] ?? null;
}

export interface DragRangeRow
{
	readonly id: string;
	readonly parentId: string | null;
	readonly top: number;
	readonly height: number;
}

/** Pixels around the start row's name inside which a drag selects nothing. */
const DRAG_DEAD_ZONE_PX = 5;
const DRAG_ROW_STEP_PX = 14;

/**
 * Upstream's drag-select range (`aZ.getRangesBetweenPositionAndStartInclusive`): `rows` are the `.project` rects in
 * display order. Null is the dead zone around the start name. Rows whose parent is in range are dropped, since the
 * parent's entry covers them.
 */
export function dragRangeAt(
	rows: readonly DragRangeRow[],
	startIndex: number,
	startName:
	{
		readonly top: number;
		readonly height: number;
	},
	y: number,
): string[] | null
{
	const start = rows[startIndex];
	if (start === undefined)
	{
		return null;
	}
	if (y >= startName.top - DRAG_DEAD_ZONE_PX && y < startName.top + startName.height + DRAG_DEAD_ZONE_PX)
	{
		return null;
	}
	let hitIndex = 0;
	for (const [index, row] of rows.entries())
	{
		const best = rows[hitIndex];
		if (best !== undefined && Math.abs(row.top - y) < Math.abs(best.top - y))
		{
			hitIndex = index;
		}
	}
	const n = hitIndex - startIndex;
	const below = y >= startName.top + startName.height + DRAG_DEAD_ZONE_PX;
	const hit = rows[hitIndex];
	const previous = rows[hitIndex - 1];
	if (hit !== undefined && below)
	{
		if (y < hit.top + (DRAG_ROW_STEP_PX * Math.max(1 - n + 3, 0)) / 3 && previous !== undefined)
		{
			hitIndex -= 1;
		}
	}
	else if (
		hit !== undefined &&
		y < hit.top - (DRAG_ROW_STEP_PX * Math.max(n + 3, 0)) / 3 &&
		previous !== undefined &&
		y < previous.top + previous.height
	)
	{
		hitIndex -= 1;
	}
	const edge = rows[hitIndex];
	if (edge === undefined)
	{
		return null;
	}
	const low = Math.min(edge.top, start.top);
	const high = Math.max(edge.top, start.top);
	const range = rows.filter((row) => row.top >= low && row.top <= high);
	const inRange = new Set(range.map((row) => row.id));
	return range.filter((row) => row.parentId === null || !inRange.has(row.parentId)).map((row) => row.id);
}

export type ContentMouseDownAction = "TOGGLE" | "PIVOT" | "DRAG";

/**
 * Classify a mousedown on a row's `.content`: ⌘/⌥ toggles the row, ⇧ selects from the pivot (except on the edited
 * row, where it natively extends the text selection), and a plain left press arms drag-select. The bullet owns its
 * own presses.
 */
export function contentMouseDownAction(
	event:
	{
		button: number;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		onBullet: boolean;
		isEditingRow: boolean;
	},
	isMac: boolean,
): ContentMouseDownAction | null
{
	if (event.button !== 0 || event.onBullet)
	{
		return null;
	}
	const mod = isMac ? event.metaKey : event.ctrlKey;
	if (mod || event.altKey)
	{
		return "TOGGLE";
	}
	if (event.metaKey || event.ctrlKey)
	{
		return null;
	}
	if (event.shiftKey)
	{
		return event.isEditingRow ? null : "PIVOT";
	}
	return "DRAG";
}

/**
 * Upstream's `Px4`: while items are selected and no editor holds the caret, a paste is swallowed, so nothing is
 * inserted anywhere. Returns the listener's remover.
 */
export function listenForSelectionPaste(target: EventTarget, hasSelection: () => boolean): () => void
{
	const onPaste = (event: Event): void =>
	{
		const inText =
			event.target instanceof HTMLElement &&
			(event.target.isContentEditable ||
				event.target instanceof HTMLInputElement ||
				event.target instanceof HTMLTextAreaElement);
		if (hasSelection() && !inText)
		{
			event.preventDefault();
			event.stopPropagation();
		}
	};
	target.addEventListener("paste", onPaste, true);
	return () =>
	{
		target.removeEventListener("paste", onPaste, true);
	};
}

/**
 * Upstream's selection-menu anchor (`fF4`): the LAST inserted entry that has a rendered row, and the footer count,
 * which still includes unrendered entries. Entries are kept in insertion order.
 */
export function selectionMenuAnchor(
	state: SelectionState,
	rendered: (id: string) => boolean,
):
{
	anchorId: string | null;
	count: number;
}
{
	const anchor = state.entries.findLast((entry) => rendered(entry.id));
	return {
		anchorId: anchor?.id ?? null,
		count: state.entries.length,
	};
}

export interface MatchRow
{
	id: string;
	matches: boolean;
	completed: boolean;
	isMirror: boolean;
}

/** Ids for upstream's "Select matched": search matches that pass the completed and mirrors filters, in display order. */
export function selectMatchedIds(
	rows: readonly MatchRow[],
	filters:
	{
		showCompleted: boolean;
		includeMirrors: boolean;
	},
): string[]
{
	return rows
		.filter(
			(row) =>
				row.matches && (filters.showCompleted || !row.completed) && (filters.includeMirrors || !row.isMirror),
		)
		.map((row) => row.id);
}
