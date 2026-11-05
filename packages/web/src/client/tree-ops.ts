import type {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../node-types.js";
import {normalizeLayoutMode} from "./layout-types.js";
import {readChildren, readNode, spliceBlock} from "./node-cache.js";
import {concatHtml, plainLength, plainText, splitHtml, trimmedPlainLength} from "./rich-text.js";
import {sortByPriority} from "./tree-position.js";
import type {UndoOp} from "./undo-history.js";

/**
 * Tree-mutation planning: given the React Query cache and a node, compute the
 * payload for the corresponding create/move mutation (or null when the mutation
 * is a no-op). Each function hides the sibling-cache read and the index arithmetic
 * that the keyboard handlers and the editor would otherwise inline.
 *
 * An `index` is a slot among ALL of the target parent's children sorted by priority,
 * completed rows included (hiding them is render-time only); omitted means bottom.
 * For a move it is counted BEFORE the moved node is removed (the node lands right
 * before the row now at `index`), matching the move endpoint and `MoveToInput`.
 *
 * These are pure over `(queryClient, node)`, so they unit-test by seeding a
 * QueryClient and asserting the emitted payload — no DOM, no key events.
 */

/** Payload accepted by the create-node mutation. */
export interface CreateNodePayload {
	parent_id?: string;
	name: string;
	note?: string;
	index?: number;
}

/** Payload accepted by the move-node mutation. */
export interface MoveNodePayload {
	nodeId: string;
	parent_id: string | null;
	index?: number;
}

/** The minimal node fields the planners read. */
type PlanNode = Pick<NodeResponse, "id" | "parent_id" | "priority">;

/** `{index}` for the slot right after `id` among `parentId`'s cached children, or `{}` (bottom) when uncached. */
function indexAfter(queryClient: QueryClient, parentId: string | null, id: string): {index?: number} {
	const siblings = readChildren(queryClient, parentId);
	const index = siblings ? sortByPriority(siblings).findIndex((sibling) => sibling.id === id) : -1;
	return index === -1 ? {} : {index: index + 1};
}

/**
 * Upstream `WF.Priority.defaultIn`: where a node dropped or moved "into" `target`
 * lands — the bottom when its metadata says `defaultToBottom`, else the top.
 */
export function defaultIndexIn(target: Pick<NodeResponse, "defaultToBottom">, childCount: number): number {
	return target.defaultToBottom === true ? childCount : 0;
}

/**
 * The move index for dropping a row above or below `targetId`: the target's
 * slot among all `children` (priority order, the dragged row included), +1 for below.
 */
export function dropIndex(
	children: Pick<NodeResponse, "id" | "priority">[],
	targetId: string,
	position: "above" | "below",
): number {
	const target = sortByPriority(children).findIndex((child) => child.id === targetId);
	return target + (position === "below" ? 1 : 0);
}

/** Payload for the add-child button: an empty last child of the zoomed item. */
export interface AddChildPlan {
	parent_id: string | undefined;
	index: number;
	name: string;
	layoutMode: string | null;
	/** Append after the server's LIVE last child, not after the last row this client has cached. */
	at_end: true;
}

/**
 * Upstream `Item.shape` for one source row: the layout a new row next to it takes. Headings become paragraphs,
 * numbered and todo rows repeat, a bullet stores nothing, and any other layout (board, table, quote, code, divider,
 * dashboard) defers to `fallback`.
 */
export function shapeLayoutFor(
	source: {layoutMode: string | null | undefined},
	fallback: () => string | null,
): string | null {
	switch (source.layoutMode ?? "bullets") {
		case "h1":
		case "h2":
		case "h3":
		case "p":
			return "p";
		case "numbered":
			return "numbered";
		case "todo":
			return "todo";
		case "bullets":
			return null;
		default:
			return fallback();
	}
}

/**
 * The shape a row gives a new neighbor, read from the cache: `shapeLayoutFor` with upstream's fallback, the previous
 * sibling's shape, else the parent's, and null at the root.
 */
export function rowShapeLayout(queryClient: QueryClient, node: NodeResponse): string | null {
	return shapeLayoutFor(node.data, () => {
		const siblings = sortByPriority(readChildren(queryClient, node.parent_id) ?? []);
		const previous = siblings[siblings.findIndex((sibling) => sibling.id === node.id) - 1];
		if (previous !== undefined) {
			return rowShapeLayout(queryClient, previous);
		}
		const parent = node.parent_id === null ? undefined : readNode(queryClient, node.parent_id);
		return parent === undefined ? null : rowShapeLayout(queryClient, parent);
	});
}

/** The shape of a new last child of `parentId`: the previous visible row's, else the parent's, else none. */
export function lastChildShapeLayout(
	queryClient: QueryClient,
	parentId: string | null,
	lastVisible: NodeResponse | undefined,
): string | null {
	if (lastVisible !== undefined) {
		return rowShapeLayout(queryClient, lastVisible);
	}
	const parent = parentId === null ? undefined : readNode(queryClient, parentId);
	return parent === undefined ? null : rowShapeLayout(queryClient, parent);
}

/**
 * Plan the "+" add-child button: the new node goes in the bottom slot (`index` =
 * child count) and takes the shape the caller computed from the previous visible row.
 */
export function planAddChild({
	childCount,
	zoomedId,
	shapeLayout,
}: {
	childCount: number;
	zoomedId: string | null;
	shapeLayout: string | null;
}): AddChildPlan {
	return {
		parent_id: zoomedId ?? undefined,
		index: childCount,
		name: "",
		layoutMode: shapeLayout,
		at_end: true,
	};
}

/** Payload for an outline's add-sibling button: an empty node right after its owner. */
export interface AddSiblingPlan {
	parent_id: string | undefined;
	name: string;
	index: number;
}

/**
 * Plan the guide line's add-sibling button: an empty sibling of `owner` (the row
 * whose `.children` holds the button) in the slot right after it among ALL of its
 * `siblings` in priority order, completed rows included.
 */
export function planAddSibling({owner, siblings}: {owner: PlanNode; siblings: PlanNode[]}): AddSiblingPlan {
	const ownerIndex = sortByPriority(siblings).findIndex((sibling) => sibling.id === owner.id);
	return {parent_id: owner.parent_id ?? undefined, name: "", index: ownerIndex + 1};
}

/**
 * Upstream `item:is-empty` with the name-only default: the NAME is empty, whatever the note or children hold. A
 * divider, a file row, a calendar container and a table cell are never empty.
 */
export function isEmptyForReturn(row: {
	text: string;
	layoutMode: string | null | undefined;
	hasFile: boolean;
	isCalendarContainer: boolean;
	isTableCell: boolean;
}): boolean {
	return (
		row.text === "" && row.layoutMode !== "divider" && !row.hasFile && !row.isCalendarContainer && !row.isTableCell
	);
}

/** The row state `planSplit` reads. `isEmpty` = empty NAME (see `isEmptyForReturn`). */
export interface SplitNode {
	id: string;
	parent_id: string | null;
	index: number;
	hasVisibleChildren: boolean;
	isExpanded: boolean;
	isZoomRoot: boolean;
	isEmpty: boolean;
	hasNextSibling: boolean;
	/** False when the parent is the zoom root (or the tree root). */
	canOutdent: boolean;
	/** The row's layout mode: Enter in a code or quote block inserts a newline. */
	layoutMode?: string | null | undefined;
	/** `"column"` when the parent is a board, `"card"` when it is a dashboard: Enter at the end creates the first child. */
	role?: "column" | "card" | null;
}

/** What Enter does: outdent the empty row, insert a newline in a code or quote block, or create a row and rename the current one. */
export type SplitPlan =
	| {kind: "outdent"}
	| {kind: "newline"}
	| {
			kind: "create";
			parentId: string | null;
			index: number;
			newName: string;
			currentName: string;
			focus: "new" | "current";
			layoutMode: string | null;
			/** A row to expand once the new row exists (the board column that gained a first card). */
			expand?: string;
	  };

/** The newline run that exits a multi-line block with Enter: a code block ends after a blank line, a quote after one. */
const MULTILINE_EXIT: Readonly<Record<string, string>> = {"code-block": "\n\n", "quote-block": "\n"};

/**
 * Enter in a code or quote block inserts a newline, except right after the exit run (`\n\n` in code, `\n` in a
 * quote), which is removed and starts a new row after this one.
 */
function planBlockEnter({
	node,
	html,
	selection,
	shapeLayout,
	exit,
}: {
	node: SplitNode;
	html: string;
	selection: {start: number; end: number};
	shapeLayout: string | null;
	exit: string;
}): SplitPlan {
	const {start, end} = selection;
	if (start !== end || !plainText(html, "").slice(0, start).endsWith(exit)) {
		return {kind: "newline"};
	}
	const {before, after} = splitHtml(html, start - exit.length, start);
	return {
		kind: "create",
		parentId: node.parent_id,
		index: node.index + 1,
		newName: after,
		currentName: before,
		focus: "new",
		layoutMode: shapeLayout,
	};
}

/**
 * Plan Enter in the editor (upstream `hK`). A caret at the trimmed end creates a row
 * after (or the first child of an expanded parent / the zoom root); a caret at the start
 * creates an empty row above; anything else moves the text before the selection into a
 * new row above, so the current row keeps its id, children, and note.
 */
export function planSplit({
	node,
	html,
	selection,
	shapeLayout,
}: {
	node: SplitNode;
	html: string;
	selection: {start: number; end: number};
	/** The new row's layout, from `rowShapeLayout` of the split row. */
	shapeLayout: string | null;
}): SplitPlan {
	const block = node.isZoomRoot ? undefined : MULTILINE_EXIT[normalizeLayoutMode(node.layoutMode) ?? ""];
	if (block !== undefined) {
		return planBlockEnter({node, html, selection, shapeLayout, exit: block});
	}
	if (node.isEmpty && !node.hasNextSibling && node.canOutdent && !node.isZoomRoot) {
		return {kind: "outdent"};
	}
	const create = (
		parentId: string | null,
		index: number,
		newName: string,
		currentName: string,
		focus: "new" | "current",
	): Extract<SplitPlan, {kind: "create"}> => ({
		kind: "create",
		parentId,
		index,
		newName,
		currentName,
		focus,
		layoutMode: shapeLayout,
	});

	if (node.isZoomRoot) {
		return create(node.id, 0, "", html, "new");
	}
	const {start, end} = selection;
	if (start === end && start >= trimmedPlainLength(html)) {
		const {before, after} = splitHtml(html, start, end);
		if (node.role === "column" || node.role === "card") {
			return {...create(node.id, 0, after, before, "new"), expand: node.id};
		}
		if (node.hasVisibleChildren && node.isExpanded) {
			return create(node.id, 0, after, before, "new");
		}
		return create(node.parent_id, node.index + 1, after, before, "new");
	}
	if (start === end && start === 0) {
		return create(node.parent_id, node.index, "", html, "new");
	}
	const {before, after} = splitHtml(html, start, end);
	return create(node.parent_id, node.index, before, after, "current");
}

/** One step of carrying out a split plan, in order. */
export type SplitMutation =
	| {type: "update"; nodeId: string; name: string}
	| {type: "create"; parent_id: string | null; index: number; name: string; layoutMode: string | null}
	| {type: "edit"; target: "new" | "current"; caret: 0};

/**
 * The ordered mutations for a `create` split plan on `nodeId`: rename the current row
 * when its name differs from `savedName`, create the new row at the planner's exact
 * `index` (one create, no sibling rotation), then edit the focused row at its start.
 */
export function applySplitPlan(
	plan: Extract<SplitPlan, {kind: "create"}>,
	nodeId: string,
	savedName: string,
): SplitMutation[] {
	const rename: SplitMutation[] =
		plan.currentName === savedName ? [] : [{type: "update", nodeId, name: plan.currentName}];
	return [
		...rename,
		{type: "create", parent_id: plan.parentId, index: plan.index, name: plan.newName, layoutMode: plan.layoutMode},
		{type: "edit", target: plan.focus, caret: 0},
	];
}

/** The row state the merge planners read. */
export interface MergeRow {
	id: string;
	html: string;
	hasChildren: boolean;
	hasNote: boolean;
	completed: boolean;
	isMirror: boolean;
	/** The row is an original that mirrors point to. */
	hasMirrors: boolean;
	layoutMode: string | null | undefined;
	/** The row holds an attachment: upstream's `item.can_merge` refuses to merge it. */
	hasFile?: boolean;
}

/** What Backspace at the start / Delete at the end does: merge two sibling rows, or nothing. */
export type MergePlan = {kind: "none"} | {kind: "merge"; keepId: string; deleteId: string; name: string; caret: number};

/**
 * Merge `absorbed` (deleted) into `kept`, which keeps its id, children, and note. Refused
 * unless `absorbed` is a plain leaf (no children, note, or completion) with the same layout as
 * `kept`, and neither row is a board, a mirror, or a mirrored original.
 */
function planMerge(first: MergeRow, second: MergeRow, absorbed: MergeRow, kept: MergeRow): MergePlan {
	const refused =
		absorbed.hasFile === true ||
		kept.hasFile === true ||
		absorbed.hasChildren ||
		absorbed.hasNote ||
		absorbed.completed ||
		absorbed.isMirror ||
		kept.isMirror ||
		absorbed.hasMirrors ||
		kept.hasMirrors ||
		absorbed.layoutMode === "board" ||
		kept.layoutMode === "board" ||
		(absorbed.layoutMode ?? null) !== (kept.layoutMode ?? null);
	if (refused) {
		return {kind: "none"};
	}
	return {
		kind: "merge",
		keepId: kept.id,
		deleteId: absorbed.id,
		name: concatHtml(first.html, second.html),
		caret: plainLength(first.html),
	};
}

/**
 * Backspace with a collapsed caret at offset 0 (upstream): the previous sibling's text
 * moves to the start of the current row, which keeps its id; the sibling is deleted.
 */
export function planBackspaceAtStart({
	current,
	previousSibling,
}: {
	current: MergeRow;
	previousSibling: MergeRow | null;
}): MergePlan {
	return previousSibling === null ? {kind: "none"} : planMerge(previousSibling, current, previousSibling, current);
}

/**
 * Delete with a collapsed caret at the text end (upstream): the mirror image of
 * Backspace — the current row's text moves to the start of the next sibling, which
 * keeps its id; the current row is deleted.
 */
export function planDeleteAtEnd({current, nextSibling}: {current: MergeRow; nextSibling: MergeRow | null}): MergePlan {
	return nextSibling === null ? {kind: "none"} : planMerge(current, nextSibling, current, nextSibling);
}

/** Duplicate `node`'s name/note as a sibling immediately after it. */
export function planDuplicate(
	queryClient: QueryClient,
	node: PlanNode & Pick<NodeResponse, "name" | "note">,
): CreateNodePayload {
	return {
		parent_id: node.parent_id ?? undefined,
		name: node.name ?? "",
		note: node.note ?? undefined,
		...indexAfter(queryClient, node.parent_id, node.id),
	};
}

/** Tab plan: the move payload, plus the new parent to expand when it is collapsed (or null). */
export type IndentPlan = MoveNodePayload & {expandParentId: string | null};

/**
 * Indent `node` as the LAST child of its previous sibling (upstream `Gs1`), expanding
 * that sibling when it is not in `expandedIds`, or null if it has no previous sibling.
 * Without the sibling's children cached the index is omitted, since the server's
 * bottom is the same slot.
 */
export function planIndent(
	queryClient: QueryClient,
	node: PlanNode,
	expandedIds: ReadonlySet<string>,
): IndentPlan | null {
	const siblings = readChildren(queryClient, node.parent_id);
	if (!siblings) {
		return null;
	}
	const sorted = sortByPriority(siblings);
	const index = sorted.findIndex((sibling) => sibling.id === node.id);
	const previous = sorted[index - 1];
	if (index <= 0 || previous === undefined) {
		return null;
	}
	const expandParentId = expandedIds.has(previous.id) ? null : previous.id;
	const previousChildren = readChildren(queryClient, previous.id);
	if (previousChildren !== undefined) {
		return {nodeId: node.id, parent_id: previous.id, index: previousChildren.length, expandParentId};
	}
	return previous.hasChildren === false
		? {nodeId: node.id, parent_id: previous.id, index: 0, expandParentId}
		: {nodeId: node.id, parent_id: previous.id, expandParentId};
}

/**
 * The previous sibling whose children Tab on `node` would have to load before it can move (a collapsed row that was
 * never opened), or null. Loading them while the row is edited lets Tab move at once instead of after a round trip.
 */
export function indentChildrenToLoad(queryClient: QueryClient, node: PlanNode): string | null {
	const target = planIndent(queryClient, node, new Set())?.parent_id;
	return target === undefined || target === null || childrenCached(queryClient, target) ? null : target;
}

/** Whether `id`'s children are known: cached, or none at all. */
function childrenCached(queryClient: QueryClient, id: string): boolean {
	return readChildren(queryClient, id) !== undefined || readNode(queryClient, id)?.hasChildren === false;
}

/**
 * Outdent `node` to sit right after its parent among the grandparent's children.
 * Null at root, or when the parent is the zoom root (the node would leave the page).
 */
export function planOutdent(
	queryClient: QueryClient,
	node: PlanNode,
	zoomedNodeId: string | null,
): MoveNodePayload | null {
	if (node.parent_id === null || node.parent_id === zoomedNodeId) {
		return null;
	}
	const parent = readNode(queryClient, node.parent_id);
	if (parent === undefined) {
		return null;
	}
	const grandparentId = parent.parent_id;
	return {nodeId: node.id, parent_id: grandparentId, ...indexAfter(queryClient, grandparentId, node.parent_id)};
}

/** The outline as `planVerticalMove` sees it. `childrenOf` lists ALL children in priority order. */
export interface VerticalMoveTree {
	parentOf(id: string): string | null;
	childrenOf(id: string | null): string[];
	isExpanded(id: string): boolean;
	/** False for a completed row hidden while completed rows are hidden. */
	isVisible(id: string): boolean;
}

/** Move up/down plan: an exact move-endpoint `index`, plus the new parent to expand (or null). */
export interface VerticalMovePlan {
	nodeId: string;
	parentId: string | null;
	index: number;
	expandParentId: string | null;
}

/** The nearest visible sibling of `id` in `direction`, or undefined. */
function visibleSibling(tree: VerticalMoveTree, id: string, direction: "up" | "down"): string | undefined {
	const siblings = tree.childrenOf(tree.parentOf(id));
	const at = siblings.indexOf(id);
	const candidates = direction === "up" ? siblings.slice(0, at).toReversed() : siblings.slice(at + 1);
	return candidates.find((sibling) => tree.isVisible(sibling));
}

/**
 * Upstream Shift+Cmd+Up/Down. Swap with the nearest visible sibling; at the edge, leave the
 * parent for the parent's visible sibling in that direction (the "uncle"): moving up lands
 * after the uncle's last rendered child when it is open, else at its top; moving down lands
 * at its top. The uncle is expanded when it is not already. Null when there is nowhere to go,
 * and the move never leaves the zoomed page. `index` follows the move endpoint: a slot among
 * ALL of the target's children (hidden completed ones included), counted before removal.
 */
export function planVerticalMove({
	nodeId,
	direction,
	zoomRootId,
	tree,
}: {
	nodeId: string;
	direction: "up" | "down";
	zoomRootId: string | null;
	tree: VerticalMoveTree;
}): VerticalMovePlan | null {
	if (nodeId === zoomRootId) {
		return null;
	}
	const parentId = tree.parentOf(nodeId);
	const sibling = visibleSibling(tree, nodeId, direction);
	if (sibling !== undefined) {
		const siblingIndex = tree.childrenOf(parentId).indexOf(sibling);
		const index = direction === "up" ? siblingIndex : siblingIndex + 1;
		return {nodeId, parentId, index, expandParentId: null};
	}
	if (parentId === null || parentId === zoomRootId) {
		return null;
	}
	const uncle = visibleSibling(tree, parentId, direction);
	if (uncle === undefined) {
		return null;
	}
	const cousins = tree.childrenOf(uncle);
	const open = tree.isExpanded(uncle) && cousins.length > 0;
	const lastRendered = cousins.findLastIndex((cousin) => tree.isVisible(cousin));
	const index = direction === "up" && open ? lastRendered + 1 : 0;
	return {nodeId, parentId: uncle, index, expandParentId: open ? null : uncle};
}

/** A `BlockMoveTree` over the React Query cache and the outline's expansion/visibility state. */
export function cacheMoveTree(
	queryClient: QueryClient,
	{
		expandedIds,
		showCompleted,
		animatingCompletionIds,
	}: {expandedIds: ReadonlySet<string>; showCompleted: boolean; animatingCompletionIds: ReadonlySet<string>},
): BlockMoveTree {
	return {
		parentOf: (id) => readNode(queryClient, id)?.parent_id ?? null,
		childrenLoaded: (id) => childrenCached(queryClient, id),
		childrenOf: (id) => sortByPriority(readChildren(queryClient, id) ?? []).map((child) => child.id),
		isExpanded: (id) => expandedIds.has(id),
		isVisible: (id) => {
			const found = readNode(queryClient, id);
			return found === undefined || isPotentiallyVisible(found, showCompleted, animatingCompletionIds);
		},
	};
}

/** The outline as `planBlockMove` sees it; `childrenLoaded` (default true) is false while a row's children are uncached. */
export interface BlockMoveTree extends VerticalMoveTree {
	childrenLoaded?(id: string): boolean;
}

/** One `POST /api/v1/nodes/move`: `ids` in order, landing at `index` (a slot counted before removal; omitted = bottom). */
export interface BlockMove {
	ids: string[];
	parentId: string | null;
	index?: number;
}

/**
 * Whether a move into `parentId` must first load that row's children: a collapsed row that has never been opened
 * has none cached, so the planner could not place the moved row among them and the row would vanish until the
 * children landed. False for home (`null`), a loaded row and a leaf.
 */
export function needsChildrenBeforeMove(tree: BlockMoveTree, parentId: string | null): boolean {
	return parentId !== null && tree.childrenLoaded?.(parentId) === false;
}

export type BlockMoveDirection = "up" | "down" | "indent" | "outdent";

/** Upstream `aY1`: split display-ordered `ids` into runs of rows that are each other's visible siblings. */
function siblingRuns(tree: VerticalMoveTree, ids: readonly string[]): string[][] {
	const runs: string[][] = [];
	let previous: string | undefined;
	for (const id of ids) {
		const run = runs.at(-1);
		if (run !== undefined && previous !== undefined && visibleSibling(tree, id, "up") === previous) {
			run.push(id);
		} else {
			runs.push([id]);
		}
		previous = id;
	}
	return runs;
}

/** Whether `id` is `ancestorId` or sits inside it. */
function isWithin(tree: VerticalMoveTree, id: string | null, ancestorId: string): boolean {
	for (let current = id; current !== null; current = tree.parentOf(current)) {
		if (current === ancestorId) {
			return true;
		}
	}
	return false;
}

/** Tab for one run (upstream `Gs1`): the last children of the first row's visible previous sibling. */
function indentRun(tree: BlockMoveTree, run: string[]): BlockMove | null {
	const [first] = run;
	const previous = first === undefined ? undefined : visibleSibling(tree, first, "up");
	if (previous === undefined) {
		return null;
	}
	return tree.childrenLoaded?.(previous) === false
		? {ids: run, parentId: previous}
		: {ids: run, parentId: previous, index: tree.childrenOf(previous).length};
}

/** Shift+Tab for one run (upstream `Vs1`): right after the parent, never out of Home or the zoomed page. */
function outdentRun(tree: BlockMoveTree, run: string[], zoomRootId: string | null): BlockMove | null {
	const [first] = run;
	const parentId = first === undefined ? null : tree.parentOf(first);
	if (parentId === null || parentId === zoomRootId) {
		return null;
	}
	const grandparentId = tree.parentOf(parentId);
	return {ids: run, parentId: grandparentId, index: tree.childrenOf(grandparentId).indexOf(parentId) + 1};
}

/**
 * `tree` as it stands after `move`: the moved rows leave their parents and land, in order, before the
 * target's child now at `index` (the bottom when it is omitted or past the end), as `spliceBlock` does.
 */
export function applyBlockMove(tree: BlockMoveTree, move: BlockMove): BlockMoveTree {
	const moving = new Set(move.ids);
	const childrenOf = (id: string | null): string[] => {
		const others = tree.childrenOf(id).filter((child) => !moving.has(child));
		if (id !== move.parentId) {
			return others;
		}
		const all = tree.childrenOf(id);
		const at = all.slice(0, move.index ?? all.length).filter((child) => !moving.has(child)).length;
		return [...others.slice(0, at), ...move.ids, ...others.slice(at)];
	};
	return {
		...tree,
		parentOf: (id) => (moving.has(id) ? move.parentId : tree.parentOf(id)),
		childrenOf,
	};
}

/**
 * Upstream's multi-selection moves: the display-ordered `ids` split into runs of consecutive visible siblings.
 * Up/down move every row as one block to where the first run's first row (up) or the last run's last row (down)
 * would go alone. Tab/Shift+Tab move each run as a block, last run first, planning each against the outline as
 * the earlier moves left it; a run with nowhere to go is skipped. Nothing moves the zoom root.
 */
export function planBlockMove(
	ids: readonly string[],
	direction: BlockMoveDirection,
	tree: BlockMoveTree,
	zoomRootId: string | null = null,
): BlockMove[] {
	if (ids.length === 0 || (zoomRootId !== null && ids.includes(zoomRootId))) {
		return [];
	}
	const runs = siblingRuns(tree, ids);
	if (direction === "up" || direction === "down") {
		const decider = direction === "up" ? runs[0]?.[0] : runs.at(-1)?.at(-1);
		const plan = decider === undefined ? null : planVerticalMove({nodeId: decider, direction, zoomRootId, tree});
		if (plan === null) {
			return [];
		}
		const movable = ids.filter((id) => !isWithin(tree, plan.parentId, id));
		return movable.length === 0 ? [] : [{ids: movable, parentId: plan.parentId, index: plan.index}];
	}
	const moves: BlockMove[] = [];
	let current = tree;
	for (const run of runs.toReversed()) {
		const move = direction === "indent" ? indentRun(current, run) : outdentRun(current, run, zoomRootId);
		if (move !== null) {
			moves.push(move);
			current = applyBlockMove(current, move);
		}
	}
	return moves;
}

export interface ToggleCompletePlan {
	action: "complete" | "uncomplete" | "none";
	ids: string[];
}

/**
 * Upstream multi-item toggle: if any item is not completed, complete them all;
 * otherwise uncomplete them all. An empty list does nothing, nor does a list with a blocked (read-only or backlink-root) item.
 */
export function planToggleComplete(
	nodes: Pick<NodeResponse, "id" | "completedAt">[],
	isBlocked: (id: string) => boolean = () => false,
): ToggleCompletePlan {
	const ids = nodes.map((node) => node.id);
	if (ids.length === 0 || ids.some((id) => isBlocked(id))) {
		return {action: "none", ids: []};
	}
	const allCompleted = nodes.every((node) => node.completedAt !== null);
	return {action: allCompleted ? "uncomplete" : "complete", ids};
}

/**
 * Upstream's hidden test inverted: a row hides only when it is completed, completed
 * rows are hidden, and its completion is not still animating. Descendants of a hidden
 * row hide with it because callers stop recursing there.
 */
export function isPotentiallyVisible(
	node: Pick<NodeResponse, "id" | "completedAt">,
	showCompleted: boolean,
	animatingCompletionIds: ReadonlySet<string>,
): boolean {
	return node.completedAt === null || showCompleted || animatingCompletionIds.has(node.id);
}

/**
 * Upstream `nextPotentiallyVisibleSibling`: the id of the sibling `step` places from `id` in priority order,
 * skipping completed siblings while completed rows are hidden, or null past either end.
 */
export function nextPotentiallyVisibleSibling(
	siblings: Pick<NodeResponse, "id" | "priority" | "completedAt">[],
	id: string,
	step: -1 | 1,
	showCompleted: boolean,
): string | null {
	const sorted = sortByPriority(siblings);
	const start = sorted.findIndex((sibling) => sibling.id === id);
	if (start === -1) {
		return null;
	}
	for (let index = start + step; index >= 0 && index < sorted.length; index += step) {
		const sibling = sorted[index];
		if (sibling !== undefined && isPotentiallyVisible(sibling, showCompleted, new Set())) {
			return sibling.id;
		}
	}
	return null;
}

/**
 * Upstream `focus_next_sibling` / `focus_prev_sibling`: where the caret goes. With no current row, either key goes to
 * the first child in the viewport. On the zoomed title, next goes to the zoomed page's first visible child; otherwise
 * the caret steps to the current row's focusable sibling (`siblings`, in order), skipping children. Previous never
 * reaches the title.
 */
export function planFocusSibling(
	{
		zoomedId,
		currentId,
		firstChildId,
		firstInViewChildId,
		siblings,
	}: {
		zoomedId: string | null;
		currentId: string | null;
		firstChildId: string | null;
		/** The first focusable child of the zoom root whose row is in the viewport. */
		firstInViewChildId: string | null;
		siblings: readonly string[];
	},
	step: -1 | 1,
): string | null {
	if (currentId === null) {
		return firstInViewChildId;
	}
	if (currentId === zoomedId) {
		return step === 1 ? firstChildId : null;
	}
	const index = siblings.indexOf(currentId);
	return index === -1 ? null : (siblings[index + step] ?? null);
}

/**
 * Upstream `focus_parent`: where the caret goes. With nothing focused it goes to the zoom title; on the title it
 * does nothing; on a row it goes to the row's parent (the title when the parent is the zoom root).
 */
export function planFocusParent({
	zoomedId,
	currentId,
	parentOf,
}: {
	zoomedId: string | null;
	currentId: string | null;
	parentOf: Readonly<Record<string, string | null | undefined>>;
}): string | null {
	if (currentId === null) {
		return zoomedId;
	}
	if (currentId === zoomedId) {
		return null;
	}
	return parentOf[currentId] ?? null;
}

/** A mutation as `toUndoOps` reads it; `index` follows the create/move endpoints (omitted = bottom). */
export type UndoableMutation =
	| {kind: "create"; nodeId: string; parentId: string | null; index?: number}
	| {kind: "mirror"; nodeIds: readonly string[]; parentId: string | null; index?: number}
	| {kind: "delete"; nodeId: string}
	| {kind: "edit"; nodeId: string; name?: string; note?: string; layoutMode?: string; numberedStart?: number | null}
	| {kind: "move"; ids: readonly string[]; parentId: string | null; index?: number}
	/** Several block moves applied in order, each `index` counted against the lists the earlier ones leave. */
	| {kind: "moves"; moves: readonly {ids: readonly string[]; parentId: string | null; index?: number}[]}
	| {kind: "complete" | "uncomplete"; nodeId: string}
	| {kind: "restore"; nodeId: string; parentId: string | null; index: number};

/** A move index the endpoints read as the bottom of a list whose length is unknown. */
const BOTTOM_INDEX = Number.MAX_SAFE_INTEGER;

function sortedIds(queryClient: QueryClient, parentId: string | null): string[] | undefined {
	const children = readChildren(queryClient, parentId);
	return children && sortByPriority(children).map((child) => child.id);
}

/**
 * The move endpoint's index (a slot counted before removal) that takes a node from
 * position `from` to position `to` of one list.
 */
function sameListIndex(from: number, to: number): number {
	return to <= from ? to : to + 1;
}

/** The sibling lists and parents as a run of block moves leaves them, read from the cache on first use. */
interface MoveOutline {
	lists: Map<string | null, string[] | undefined>;
	parents: Map<string, string | null>;
}

function moveOutline(): MoveOutline {
	return {lists: new Map(), parents: new Map()};
}

/**
 * One move op per id, issued in order, that together reproduce the block splice.
 * Each id is placed right after its final predecessor among the rows already in
 * their final order, so every op's slots are exact for the list as it stands then,
 * and the inverse batch (reversed) restores every id's own from-slot.
 */
function moveOps(
	queryClient: QueryClient,
	ids: readonly string[],
	parentId: string | null,
	index: number | undefined,
	outline: MoveOutline = moveOutline(),
): UndoOp[] {
	const {lists, parents} = outline;
	const list = (id: string | null): string[] | undefined => {
		if (!lists.has(id)) {
			lists.set(id, sortedIds(queryClient, id));
		}
		return lists.get(id);
	};
	const target = list(parentId);
	const final =
		target &&
		spliceBlock(
			target.map((id, priority) => ({id, priority})),
			ids.map((id) => ({id, priority: 0})),
			index ?? target.length,
		).map((row) => row.id);
	const ops: UndoOp[] = [];
	for (const [k, nodeId] of ids.entries()) {
		const sourceParent = parents.has(nodeId)
			? (parents.get(nodeId) ?? null)
			: (readNode(queryClient, nodeId)?.parent_id ?? null);
		const source = list(sourceParent);
		const from = source?.indexOf(nodeId) ?? -1;
		if (source === undefined || from === -1) {
			continue;
		}
		source.splice(from, 1);
		parents.set(nodeId, parentId);
		if (target === undefined || final === undefined) {
			ops.push({
				kind: "move",
				nodeId,
				from: {parentId: sourceParent, index: from},
				to: {parentId, index: BOTTOM_INDEX},
			});
			continue;
		}
		const unsettled = new Set(ids.slice(k));
		const predecessor = final.slice(0, final.indexOf(nodeId)).findLast((id) => !unsettled.has(id));
		const to = predecessor === undefined ? 0 : target.indexOf(predecessor) + 1;
		target.splice(to, 0, nodeId);
		const same = sourceParent === parentId;
		ops.push({
			kind: "move",
			nodeId,
			from: {parentId: sourceParent, index: same ? sameListIndex(to, from) : from},
			to: {parentId, index: same ? sameListIndex(from, to) : to},
		});
	}
	return ops;
}

/** A layout mode as stored: bullets are the absence of one. */
function storedLayoutMode(layoutMode: string | null | undefined): string | null {
	return layoutMode === undefined || layoutMode === "bullets" ? null : layoutMode;
}

/**
 * The edits `mutation` makes to `nodeId`, each with its cached before-value: one op per changed text field, then a
 * layout op when its layoutMode (bullets equal null) or numberedStart changes.
 */
function editOps(
	queryClient: QueryClient,
	nodeId: string,
	changes: {name?: string; note?: string; layoutMode?: string; numberedStart?: number | null},
): UndoOp[] {
	const node = readNode(queryClient, nodeId);
	const texts = (["name", "note"] as const).flatMap((field): UndoOp[] => {
		const after = changes[field];
		const before = node?.[field] ?? "";
		return after === undefined || after === before ? [] : [{kind: "edit", nodeId, field, before, after}];
	});
	const before = {layoutMode: storedLayoutMode(node?.data.layoutMode), numberedStart: node?.numberedStart ?? null};
	const after = {
		layoutMode: changes.layoutMode === undefined ? before.layoutMode : storedLayoutMode(changes.layoutMode),
		numberedStart: changes.numberedStart === undefined ? before.numberedStart : changes.numberedStart,
	};
	const layoutChanged = after.layoutMode !== before.layoutMode || after.numberedStart !== before.numberedStart;
	return layoutChanged ? [...texts, {kind: "layout", nodeId, before, after}] : texts;
}

/**
 * The undo ops for `mutation`, read from the cache BEFORE it applies: a delete keeps its
 * parent and slot among all children (completed included; restore brings the same id back),
 * a block move one op per id with that id's own from-slot, an edit the cached old text.
 */
export function toUndoOps(mutation: UndoableMutation, queryClient: QueryClient): UndoOp[] {
	switch (mutation.kind) {
		case "create": {
			const index = mutation.index ?? readChildren(queryClient, mutation.parentId)?.length ?? BOTTOM_INDEX;
			return [{kind: "create", nodeId: mutation.nodeId, parentId: mutation.parentId, index}];
		}
		case "mirror": {
			const start = mutation.index ?? readChildren(queryClient, mutation.parentId)?.length ?? BOTTOM_INDEX;
			return mutation.nodeIds.map((nodeId, offset) => ({
				kind: "create",
				nodeId,
				parentId: mutation.parentId,
				index: start === BOTTOM_INDEX ? start : start + offset,
			}));
		}
		case "delete": {
			const parentId = readNode(queryClient, mutation.nodeId)?.parent_id ?? null;
			const index = sortedIds(queryClient, parentId)?.indexOf(mutation.nodeId) ?? -1;
			return index === -1 ? [] : [{kind: "delete", nodeId: mutation.nodeId, parentId, index}];
		}
		case "edit":
			return editOps(queryClient, mutation.nodeId, mutation);
		case "move":
			return moveOps(queryClient, mutation.ids, mutation.parentId, mutation.index);
		case "moves": {
			const outline = moveOutline();
			return mutation.moves.flatMap(({ids, parentId, index}) =>
				moveOps(queryClient, ids, parentId, index, outline),
			);
		}
		case "restore":
			return [{kind: "undelete", nodeId: mutation.nodeId, parentId: mutation.parentId, index: mutation.index}];
		case "complete":
		case "uncomplete":
		default:
			return [{kind: mutation.kind, nodeId: mutation.nodeId}];
	}
}

/**
 * Whether a row is a parent (triangle, `.children`, collapsed halo): upstream
 * counts only potentially visible children, so with completed items hidden a
 * parent whose children are all completed is a plain task. A node built
 * optimistically without the server flags counts as a parent.
 */
export function rowHasChildren(
	node: Pick<NodeResponse, "hasChildren" | "hasUncompletedChildren">,
	showCompleted: boolean,
): boolean {
	const flag = showCompleted ? node.hasChildren : (node.hasUncompletedChildren ?? node.hasChildren);
	return flag !== false;
}
