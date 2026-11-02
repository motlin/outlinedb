import type {MetadataPatch} from "./metadata-patch.js";
import type {InternalOp} from "./push-and-poll.js";

/** The `projectid` upstream uses for the Home (root) item. */
export const ROOT_PROJECT_ID = "None";

export interface OpClock
{
	/** Wall-clock time in epoch milliseconds. */
	now: number;
	/** The account's `dateJoinedTimestampInSeconds`. */
	dateJoinedSec: number;
}

/** The item's `lm`/`lmb` before this op, echoed into `undo_data`. */
export interface PreviousModified
{
	lastModified?: number | null;
	lastModifiedBy?: number | null;
}

export interface Location
{
	parentId: string;
	/** 0-based index among all siblings, completed ones included. */
	index: number;
}

/** Upstream's `getClientTimestampForTimestamp`: whole seconds since the account join date. */
export function clientTimestamp({now, dateJoinedSec}: OpClock): number
{
	return Math.floor(now / 1000 - dateJoinedSec);
}

function envelope(type: string, data: Record<string, unknown>, undoData: Record<string, unknown>, clock: OpClock)
{
	return {
		type,
		data,
		client_timestamp: clientTimestamp(clock),
		undo_data: undoData,
	} satisfies InternalOp;
}

function previousModified(previous: PreviousModified | undefined)
{
	return {
		previous_last_modified: previous?.lastModified ?? null,
		previous_last_modified_by: previous?.lastModifiedBy ?? null,
	};
}

export interface EditInput extends OpClock
{
	/** Use `ROOT_PROJECT_ID` for Home. */
	id: string;
	name?: string;
	note?: string;
	metadataPatches?: MetadataPatch[];
	metadataInversePatches?: MetadataPatch[];
	previous?: PreviousModified &
	{
		name?: string;
		note?: string;
	};
}

export function editOp(input: EditInput): InternalOp
{
	const patches = input.metadataPatches ?? [];
	const inverse = input.metadataInversePatches ?? [];
	const data: Record<string, unknown> =
	{
		projectid: input.id,
	};
	const undo: Record<string, unknown> = previousModified(input.previous);
	if (input.name !== undefined)
	{
		data.name = input.name;
		undo.previous_name = input.previous?.name ?? "";
	}
	if (input.note !== undefined)
	{
		data.description = input.note;
		undo.previous_description = input.previous?.note ?? "";
	}
	data.metadataPatches = patches;
	data.metadataInversePatches = inverse;
	undo.metadataPatches = inverse;
	return envelope("edit", data, undo, input);
}

export interface NewTree
{
	/** Client-chosen id; generated when absent. */
	id?: string;
	name: string;
	note?: string;
	metadata?: Record<string, unknown>;
	/** Created already completed: `cp` is the creation client timestamp. */
	completed?: boolean;
	children?: NewTree[];
}

export interface BulkCreateInput extends OpClock
{
	parentId: string;
	index: number;
	trees: NewTree[];
	/** Written as each tree's `cb`. */
	userId: number;
	/** Defaults to `crypto.randomUUID`. */
	generateId?: () => string;
}

interface ProjectTree
{
	id: string;
	nm: string;
	no?: string;
	metadata?: Record<string, unknown>;
	ct: number;
	cb: number;
	cp?: number;
	ch: ProjectTree[];
}

/** Build a `bulk_create`; returns the op and the ids of the top-level trees in order. */
export function bulkCreateOp(input: BulkCreateInput):
{
	op: InternalOp;
	ids: string[];
}
{
	const generateId = input.generateId ?? (() => crypto.randomUUID());
	const ct = clientTimestamp(input);
	const toProjectTree = (tree: NewTree): ProjectTree =>
	{
		const id = tree.id ?? generateId();
		return {
			id,
			nm: tree.name,
			...(tree.note === undefined
				? {}
				:
					{
						no: tree.note,
					}),
			...(tree.metadata === undefined
				? {}
				:
					{
						metadata: tree.metadata,
					}),
			ct,
			cb: input.userId,
			...(tree.completed === true
				?
					{
						cp: ct,
					}
				: {}),
			ch: (tree.children ?? []).map(toProjectTree),
		};
	};
	const projectTrees = input.trees.map(toProjectTree);
	const op = envelope(
		"bulk_create",
		{
			parentid: input.parentId,
			starting_priority: input.index,
			project_trees: JSON.stringify(projectTrees),
			isForSearch: false,
		},
		{},
		input,
	);
	return {
		op,
		ids: projectTrees.map((tree) => tree.id),
	};
}

export interface MoveInput extends OpClock
{
	id: string;
	parentId: string;
	/** Insertion slot among the target parent's current children (before removal of the moved item). */
	index: number;
	from: Location;
	previous?: PreviousModified;
}

export function moveOp(input: MoveInput): InternalOp
{
	const movingDownInSameParent = input.from.parentId === input.parentId && input.from.index < input.index;
	const priority = movingDownInSameParent ? input.index - 1 : input.index;
	return envelope(
		"move",
		{
			projectid: input.id,
			parentid: input.parentId,
			priority,
		},
		{
			previous_parentid: input.from.parentId,
			previous_priority: input.from.index,
			...previousModified(input.previous),
		},
		input,
	);
}

export interface BulkMoveInput extends OpClock
{
	items:
	{
		id: string;
		from: Location;
		previous?: PreviousModified;
	}[];
	parentId: string;
	/** The target parent's current child ids in order, moved items included. */
	siblings: string[];
	/** Insertion slot in `siblings`. */
	index: number;
}

export function bulkMoveOp(input: BulkMoveInput): InternalOp
{
	const moved = new Set(input.items.map((item) => item.id));
	const priority = input.siblings.slice(0, input.index).filter((id) => !moved.has(id)).length;
	return envelope(
		"bulk_move",
		{
			projectids_json: JSON.stringify(input.items.map((item) => item.id)),
			parentid: input.parentId,
			priority,
		},
		{
			move_undo_datas: input.items.map((item, offset) => (
			{
				previous_parentid: item.from.parentId,
				previous_priority: item.from.index,
				...previousModified(item.previous),
				priority_used_for_move: priority + offset,
			})),
		},
		input,
	);
}

export interface DeleteInput extends OpClock
{
	id: string;
	from: Location;
	previous?: PreviousModified;
}

export function deleteOp(input: DeleteInput): InternalOp
{
	return envelope(
		"delete",
		{
			projectid: input.id,
		},
		{
			...previousModified(input.previous),
			parentid: input.from.parentId,
			priority: input.from.index,
		},
		input,
	);
}

export interface UndeleteInput extends OpClock
{
	id: string;
	parentId: string;
	index: number;
	previous?: PreviousModified;
}

export function undeleteOp(input: UndeleteInput): InternalOp
{
	return envelope(
		"undelete",
		{
			projectid: input.id,
			parentid: input.parentId,
			priority: input.index,
		},
		previousModified(input.previous),
		input,
	);
}

export interface CompletionInput extends OpClock
{
	id: string;
	/** The item's previous `cp`: `false` when it was open, else its completion client timestamp. */
	previousCompleted: number | false;
	previous?: PreviousModified;
}

function completionOp(type: "complete" | "uncomplete", input: CompletionInput): InternalOp
{
	return envelope(
		type,
		{
			projectid: input.id,
		},
		{
			...previousModified(input.previous),
			previous_completed: input.previousCompleted,
		},
		input,
	);
}

export function completeOp(input: CompletionInput): InternalOp
{
	return completionOp("complete", input);
}

export function uncompleteOp(input: CompletionInput): InternalOp
{
	return completionOp("uncomplete", input);
}
