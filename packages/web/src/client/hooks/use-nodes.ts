import type {MirrorInstance} from "../../mirror-path.js";
import {
	MutationObserver,
	mutationOptions,
	notifyManager,
	skipToken,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {useCallback} from "react";
import {useMutationRunner} from "./use-mutation-runner.js";
import {HOME_TARGET} from "@workflowy/shared/types";
import type {MutateOptions, MutationObserverOptions, QueryClient} from "@tanstack/react-query";
import type {
	AncestorsResponse,
	BacklinksResponse,
	CreatedIdsResponse,
	DetachMirrorResponse,
	NodeChangesResponse,
	NodeChildrenResponse,
	NodeEnvelope,
	FoundDatesResponse,
	HomeResponse,
	NodeListResponse,
	NodeResponse,
	OutlineViewResponse,
	SubtreeItem,
	SubtreeItemsResponse,
	SwapMirrorOriginResponse,
	UpdateNodeResponse,
} from "../../node-types.js";
import type {OutlineViewRequest} from "../outline-view.js";
import {expandOrCollapseAll} from "../expansion.js";
import type {TreeIndex} from "../expansion.js";
import {
	applySavedText,
	cachedAncestors,
	invalidateSaveEffects,
	nodeKeys,
	patchCachedNode,
	cachedCopyParentIds,
	cachedInstanceAncestors,
	instanceAncestorsKey,
	patchMirrors,
	readChildren,
	readNode,
	snapshotCachedNode,
	spliceBlock,
	spliceChildren,
	syncParentFlags,
	removeOptimistic,
} from "../node-cache.js";
import {affectedKeys, verifyAgainstServer} from "../cache-verify.js";
import {backlinkEditFallback, readNavigableRows} from "../backlink-edit.js";
import {activePaneView, localExpansionChangeState, useOutlineStore} from "../stores/outline.js";
import {removeDeletedRow, textReplayPending} from "../undo-cache.js";
import {createChildrenBatcher} from "../children-batcher.js";
import {ChangeFeed} from "../change-feed.js";
import {readJson} from "../read-json.js";
import {pendingCreates} from "../pending-creates.js";
import {pendingMoves} from "../pending-moves.js";
import {toUndoOps} from "../tree-ops.js";
import {serializeWrite} from "../write-order.js";
import type {BlockMove, UndoableMutation} from "../tree-ops.js";
import {toRequestStatusError} from "../request-error.js";
import {trackReplay} from "./use-saving.js";
import {removeTagColor, setTagColor} from "./use-tag-colors.js";
import {holdUndoSlot, recordOp} from "../undo-batch.js";
import {swapMoveOps} from "../../swap-origin.js";
import {sortByPriority} from "../tree-position.js";
import {applyTableSet} from "../table.js";
import type {UndoAdapter, UndoSlot} from "../undo-batch.js";
import type {UndoOp} from "../undo-history.js";

interface CreateNodeRequest {
	/** A client-generated UUID: the optimistic row carries it, so it can be edited before the reply. */
	id?: string;
	parent_id?: string;
	name: string;
	note?: string;
	layoutMode?: string;
	/** Exact slot among all siblings (completed included); omitted = bottom. */
	index?: number;
	/** Legacy priority hint: negative = top, else bottom. */
	position?: number;
	/** Append after the server's live last child: the POST sends no `index` and no `after_id`. The optimistic row still splices at `index`. */
	at_end?: boolean;
}

interface UpdateNodeRequest {
	name?: string;
	note?: string;
	layoutMode?: string;
	/** The first number of a numbered list; null clears it. */
	numberedStart?: number | null;
	/** Metadata changes under `table` (header flag, column widths, cell color); needs the internal API. */
	tableSet?: {path: string[]; value: unknown}[];
}

const loadChildren = createChildrenBatcher(async (parentIds) => {
	const response = await fetch("/api/v1/nodes/children", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({parentIds}),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch children", response);
	}
	return (await readJson<NodeChildrenResponse>(response)).children;
});

async function fetchChanges(since: string | undefined): Promise<NodeChangesResponse> {
	const query = since === undefined ? "" : `?since=${encodeURIComponent(since)}`;
	const response = await fetch(`/api/v1/nodes/changes${query}`);
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch changes", response);
	}
	return readJson<NodeChangesResponse>(response);
}

/**
 * The tree's high-water mark: after a write, the cache is patched with what changed since it instead of refetching
 * every node query. A list of a parent with a move in flight is left for that move's own sync; creates in flight keep
 * their optimistic rows, as in `fetchChildren`.
 */
const changeFeed = new ChangeFeed(fetchChanges, (parentId, nodes) =>
	pendingMoves.has(parentId) ? undefined : pendingCreates.withPending(parentId, nodes),
);

/** Patch the cache with every tree change since the last sync; the settle step of each successful tree write. */
export async function syncNodeChanges(queryClient: QueryClient): Promise<void> {
	await changeFeed.sync(queryClient);
}

/** A parent's children (Home's for `null`); loads requested in the same tick share one batch request. */
export async function fetchChildren(parentId: string | null): Promise<NodeResponse[]> {
	void changeFeed.seed();
	await pendingMoves.settled(parentId);
	if (parentId !== null) {
		return pendingCreates.withPending(parentId, await loadChildren(parentId));
	}
	const response = await fetch("/api/v1/nodes");
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch children", response);
	}
	const data = await readJson<NodeListResponse>(response);
	return pendingCreates.withPending(parentId, data.nodes);
}

/** Everything an outline view first renders, in one round trip (see `loadOutlineView`). */
export async function fetchOutlineView(request: OutlineViewRequest): Promise<OutlineViewResponse> {
	void changeFeed.seed();
	const response = await fetch("/api/v1/nodes/view", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(request),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch outline view", response);
	}
	return readJson<OutlineViewResponse>(response);
}

export async function fetchNode(nodeId: string): Promise<NodeResponse> {
	await pendingCreates.settled([nodeId]);
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}`);
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch node", response);
	}
	const data = await readJson<NodeEnvelope>(response);
	return data.node;
}

export async function fetchAncestors(nodeId: string): Promise<NodeResponse[]> {
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/ancestors`);
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch ancestors", response);
	}
	const data = await readJson<AncestorsResponse>(response);
	return data.ancestors;
}

/** The POST body for a create: an at-end request names no slot, so the server resolves its live bottom. */
function createBody(request: CreateNodeRequest): string {
	if (request.at_end === true) {
		const {index: _index, at_end: _atEnd, ...rest} = request;
		return JSON.stringify(rest);
	}
	const afterId = createAnchors.get(request);
	return JSON.stringify(afterId === undefined ? request : {...request, after_id: afterId});
}

export async function createNode(request: CreateNodeRequest): Promise<NodeResponse> {
	await pendingCreates.prior(request.id);
	const response = await fetch("/api/v1/nodes", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: createBody(request),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to create node", response);
	}
	const data = await readJson<NodeEnvelope>(response);
	return data.node;
}

async function updateNode(nodeId: string, request: UpdateNodeRequest): Promise<UpdateNodeResponse> {
	await pendingCreates.settled([nodeId]);
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(request),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to update node", response);
	}
	return readJson<UpdateNodeResponse>(response);
}

/** A layout mode as an undo step stores it: bullets are the absence of one. */
function storedLayout(layoutMode: string | undefined): string | null {
	return layoutMode === undefined || layoutMode === "bullets" ? null : layoutMode;
}

async function fetchHome(): Promise<HomeResponse> {
	const response = await fetch("/api/v1/home");
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch home", response);
	}
	return readJson<HomeResponse>(response);
}

/** Home accepts only a layoutMode (Bullets or Board). */
async function updateHome(layoutMode: string): Promise<HomeResponse> {
	const response = await fetch(`/api/v1/nodes/${HOME_TARGET}`, {
		method: "PATCH",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({layoutMode}),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to update home", response);
	}
	return readJson<HomeResponse>(response);
}

async function deleteNode(nodeId: string): Promise<void> {
	await pendingCreates.settled([nodeId]);
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, {
		method: "DELETE",
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to delete node", response);
	}
}

interface MoveNodeRequest {
	parent_id: string | null;
	/** Exact slot among the new parent's children (completed included, moved node excluded); omitted = bottom. */
	index?: number;
	/** Legacy priority hint: negative = top, else bottom. */
	position?: number;
}

async function moveNode(nodeId: string, request: MoveNodeRequest): Promise<NodeListResponse> {
	await pendingCreates.settled([nodeId, request.parent_id]);
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/move`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(request),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to move node", response);
	}
	return readJson<NodeListResponse>(response);
}

interface RestoreNodeRequest {
	parent_id: string | null;
	/** Exact slot among the parent's children (completed included). */
	index: number;
}

/**
 * Brings a deleted node back under its ORIGINAL id (subtree, note and completion as the server kept
 * them). Needs the Workflowy internal API: the server answers 503 without it, kept as `status`.
 */
export async function restoreNode(nodeId: string, request: RestoreNodeRequest): Promise<NodeResponse> {
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/restore`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(request),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to restore node", response);
	}
	const data = await readJson<NodeEnvelope>(response);
	return data.node;
}

async function completeNode(nodeId: string): Promise<NodeResponse> {
	await pendingCreates.settled([nodeId]);
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/complete`, {
		method: "POST",
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to complete node", response);
	}
	const data = await readJson<NodeEnvelope>(response);
	return data.node;
}

async function uncompleteNode(nodeId: string): Promise<NodeResponse> {
	await pendingCreates.settled([nodeId]);
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/uncomplete`, {
		method: "POST",
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to uncomplete node", response);
	}
	const data = await readJson<NodeEnvelope>(response);
	return data.node;
}

/** The raw server calls `applyOps` replays an undo step through (no optimistic cache writes). */
export const undoAdapter: UndoAdapter = {
	updateNode: async (...args) => trackReplay(updateNode(...args)),
	deleteNode: async (...args) => trackReplay(deleteNode(...args)),
	restoreNode: async (...args) => trackReplay(restoreNode(...args)),
	moveNode: async (...args) => trackReplay(moveNode(...args)),
	completeNode: async (...args) => trackReplay(completeNode(...args)),
	uncompleteNode: async (...args) => trackReplay(uncompleteNode(...args)),
	setTagColor: async (tag, color) => trackReplay(setTagColor(tag, color)),
	removeTagColor: async (tag) => trackReplay(removeTagColor(tag)),
	updateLayout: async (nodeId, layout) =>
		trackReplay(
			(async () => {
				if (nodeId === HOME_TARGET) {
					await updateHome(layout.layoutMode);
				} else {
					await updateNode(nodeId, layout);
				}
			})(),
		),
};

/**
 * Fetches children of a parent node (or root nodes if parentId is null).
 */
async function fetchBacklinks(nodeId: string): Promise<BacklinksResponse> {
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/backlinks`);
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch backlinks", response);
	}
	return readJson<BacklinksResponse>(response);
}

/** Fetches an item's Backlinks section (disabled for the main-tree root). */
export function useBacklinks(nodeId: string | null) {
	return useQuery({
		queryKey: nodeKeys.backlinks(nodeId ?? ""),
		queryFn: nodeId === null ? skipToken : async () => fetchBacklinks(nodeId),
	});
}

async function fetchFoundDates(dayId: string): Promise<FoundDatesResponse> {
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(dayId)}/found-dates`);
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch found dates", response);
	}
	return readJson<FoundDatesResponse>(response);
}

/** Fetches a day page's Found Dates (disabled when `dayId` is null). */
export function useFoundDates(dayId: string | null) {
	return useQuery({
		queryKey: nodeKeys.foundDates(dayId ?? ""),
		queryFn: dayId === null ? skipToken : async () => fetchFoundDates(dayId),
	});
}

export function useChildren(parentId: string | null, enabled = true) {
	return useQuery({
		queryKey: nodeKeys.children(parentId),
		queryFn: async () => fetchChildren(parentId),
		enabled,
	});
}

/**
 * Fetches a single node by ID.
 * Returns null data if nodeId is empty (disabled query).
 */
export function useNode(nodeId: string | null) {
	const queryClient = useQueryClient();
	return useQuery({
		queryKey: nodeKeys.detail(nodeId ?? ""),
		queryFn: nodeId === null || nodeId === "" ? skipToken : async () => fetchNode(nodeId),
		// A row the outline has shown already holds the detail: the zoomed title renders with the swap.
		initialData: () => (nodeId === null || nodeId === "" ? undefined : readNode(queryClient, nodeId)),
	});
}

/** Home's layoutMode from `GET /api/v1/home` (the zoom root's layout when not zoomed). */
export function useHome() {
	return useQuery({queryKey: nodeKeys.home(), queryFn: fetchHome});
}

/**
 * Fetches all ancestors of a node from root to the node itself.
 * Returns empty array if nodeId is null (at root level).
 */
export function useAncestors(nodeId: string | null, instance: MirrorInstance | null = null) {
	const queryClient = useQueryClient();
	// A row met inside a mirror has the mirror's chain: it is cached and fetched under its virtual location id.
	const key = nodeId === null || instance === null ? nodeId : instanceAncestorsKey(nodeId, instance);
	return useQuery({
		queryKey: nodeKeys.ancestors(key ?? ""),
		queryFn: key === null || key === "" ? skipToken : async () => fetchAncestors(key),
		// Built from cached chains and rows, so the breadcrumbs render with the swap.
		initialData: () =>
			nodeId === null || nodeId === ""
				? undefined
				: instance === null
					? cachedAncestors(queryClient, nodeId)
					: cachedInstanceAncestors(queryClient, nodeId, instance),
	});
}

function ignoreFailure(): void {}

/**
 * Load what a zoom into `nodeId` renders besides its tree (the view load brings its lists and Backlinks sections), so
 * the new view lands in one commit: its detail and ancestor chain unless the cache already holds them (`useNode` and
 * `useAncestors` then seed from it). Failures are left to the hooks to retry; this never rejects.
 */
export async function prefetchZoomView(queryClient: QueryClient, nodeId: string): Promise<void> {
	await Promise.all([
		readNode(queryClient, nodeId) === undefined
			? queryClient
					.query({queryKey: nodeKeys.detail(nodeId), queryFn: async () => fetchNode(nodeId)})
					.catch(ignoreFailure)
			: undefined,
		cachedAncestors(queryClient, nodeId) === undefined
			? queryClient
					.query({queryKey: nodeKeys.ancestors(nodeId), queryFn: async () => fetchAncestors(nodeId)})
					.catch(ignoreFailure)
			: undefined,
	]);
}

/** The slot a create/move lands in: the exact `index`, else the legacy hint (negative = top, else bottom). */
function requestedIndex(request: {index?: number; position?: number}, count: number): number {
	if (request.index !== undefined) {
		return request.index;
	}
	return request.position !== undefined && request.position < 0 ? 0 : count;
}

/** The exact `index` a create/move asks for, or undefined for the bottom (see `requestedIndex`). */
function exactIndex(request: {index?: number; position?: number}): number | undefined {
	return request.index ?? (request.position !== undefined && request.position < 0 ? 0 : undefined);
}

type Mutate<TData, TVariables, TContext> = (
	variables: TVariables,
	options?: MutateOptions<TData, Error, TVariables, TContext>,
) => void;

interface HeldUndo<TData> {
	slot: UndoSlot;
	finish(data: TData): UndoOp[];
}

/**
 * How a mutation's undo ops come from its reply; `provisional` is what they are as far as the cache
 * knows at issue time, so an undo pressed before the reply need not wait for it.
 */
type UndoPlan<TData> = ((data: TData) => UndoOp[]) & {provisional?: readonly UndoOp[]};

/** One hook's undo slots of mutations in flight, keyed by their variables (first in, first out). */
class HeldUndos<TData, TVariables> {
	readonly #held = new Map<TVariables, HeldUndo<TData>[]>();

	hold(variables: TVariables, finish: UndoPlan<TData>): void {
		const held = this.#held.get(variables) ?? [];
		held.push({slot: holdUndoSlot(finish.provisional), finish});
		this.#held.set(variables, held);
	}

	/** Settles the oldest slot for `variables`: its ops on success, none on failure. */
	settle(variables: TVariables, outcome: {data: TData} | "failed"): void {
		const held = this.#held.get(variables);
		const next = held?.shift();
		if (held?.length === 0) {
			this.#held.delete(variables);
		}
		next?.slot.settle(outcome === "failed" ? [] : next.finish(outcome.data));
	}
}

/**
 * Wraps `mutate` so each call reserves its undo slot NOW, reading the before-values from the
 * cache before any optimistic write; the hook's `onSuccess`/`onError` settle it through `held`.
 */
function useUndoableMutate<TData, TVariables, TContext>(
	mutate: Mutate<TData, TVariables, TContext>,
	held: HeldUndos<TData, TVariables>,
	plan: (variables: TVariables, queryClient: QueryClient) => UndoPlan<TData>,
): Mutate<TData, TVariables, TContext> {
	const queryClient = useQueryClient();
	return useCallback<Mutate<TData, TVariables, TContext>>(
		(variables, options) => {
			held.hold(variables, plan(variables, queryClient));
			mutate(variables, options);
		},
		[mutate, held, plan, queryClient],
	);
}

/**
 * One undoable mutation run without a hook: reserve its undo slot as `useUndoableMutate` does, then run it on an
 * observer of its own. Its failure is reported by the options' `onError`.
 */
function runUndoableMutation<TData, TVariables, TContext>(
	queryClient: QueryClient,
	options: MutationObserverOptions<TData, Error, TVariables, TContext>,
	held: HeldUndos<TData, TVariables>,
	plan: (variables: TVariables, queryClient: QueryClient) => UndoPlan<TData>,
	variables: TVariables,
): void {
	held.hold(variables, plan(variables, queryClient));
	new MutationObserver(queryClient, options).mutate(variables).catch(() => {});
}

/** A plan for mutations whose ops are fully known from the cache before they run. */
function cachedOps(queryClient: QueryClient, mutation: UndoableMutation): UndoPlan<unknown> {
	const ops = toUndoOps(mutation, queryClient);
	return Object.assign(() => ops, {provisional: ops});
}

const createUndos = new HeldUndos<NodeResponse, CreateNodeRequest>();

function planCreate(request: CreateNodeRequest, queryClient: QueryClient): UndoPlan<NodeResponse> {
	const parentId = request.parent_id ?? null;
	const [first] = toUndoOps({kind: "create", nodeId: "", parentId, index: exactIndex(request)}, queryClient);
	const op = first?.kind === "tagColor" ? undefined : first;
	// The public-API fallback may answer another id than the client one.
	const finish = (created: NodeResponse): UndoOp[] => (op === undefined ? [] : [{...op, nodeId: created.id}]);
	return op === undefined || request.id === undefined
		? finish
		: Object.assign(finish, {provisional: [{...op, nodeId: request.id}]});
}

/**
 * Creates a new node with optimistic update.
 */
export function useCreateNode() {
	const queryClient = useQueryClient();
	const addErrorNotification = useOutlineStore((state) => state.addErrorNotification);

	const mutation = useMutationRunner({
		mutationFn: createNode,
		async onMutate(newNode) {
			const early = earlyCreates.get(newNode);
			if (early) {
				return early;
			}
			// Cancel outgoing refetches to avoid overwriting optimistic update
			await queryClient.cancelQueries({queryKey: nodeKeys.children(newNode.parent_id ?? null)});
			return insertOptimisticCreate(queryClient, newNode);
		},
		onSuccess(createdNode, variables) {
			createUndos.settle(variables, {data: createdNode});
			// The public-API fallback cannot honor a client id: follow the caret to the real one.
			const {editingId, startEditing, markCreatedForSearch} = useOutlineStore.getState();
			markCreatedForSearch(createdNode.id);
			if (variables.id !== undefined && createdNode.id !== variables.id && editingId === variables.id) {
				startEditing(createdNode.id);
			}
		},
		onError(error, variables, context) {
			createUndos.settle(variables, "failed");
			// Roll back to previous value on error
			if (context !== undefined) {
				rollbackCreate(queryClient, context);
			}
			addErrorNotification(`Failed to create node: ${error.message}`);
		},
		async onSettled(data, error, variables) {
			if (variables.id !== undefined) {
				pendingCreates.end(variables.id);
			}
			const parentId = variables.parent_id ?? null;
			if (error === null && data !== undefined) {
				verifyAgainstServer(queryClient, "create", affectedKeys(queryClient, [data.id], [parentId]));
				await syncNodeChanges(queryClient);
				return;
			}
			await queryClient.invalidateQueries({queryKey: nodeKeys.children(parentId)});
		},
	});
	const {mutate} = mutation;

	/**
	 * A create under a client id inserts its optimistic row synchronously, in the same
	 * render as the caller's startEditing, so the row's editor mounts at once (no keystroke
	 * gap) and the edited node's reads already wait on pendingCreates.
	 */
	const mutateNow = useCallback<typeof mutate>(
		(request, options) => {
			if (request.id !== undefined) {
				earlyCreates.set(request, insertOptimisticCreate(queryClient, request));
			}
			mutate(request, options);
		},
		[mutate, queryClient],
	);
	// Outermost, so the slot is read before `mutateNow`'s optimistic insert.
	const undoableMutate = useUndoableMutate(mutateNow, createUndos, planCreate);
	return {...mutation, mutate: undoableMutate};
}

interface CreateContext {
	optimisticId: string;
	parentId: string | null;
	restoreParentFlags: () => void;
}

/** Optimistic inserts `mutate` already made, handed to `onMutate` by request identity. */
const earlyCreates = new WeakMap<CreateNodeRequest, CreateContext>();

/**
 * The row an exact-index create's optimistic row landed below (null: first), by request identity. The server places
 * the node below it, so a sibling another client added that this cache has not seen does not shift the slot.
 */
const createAnchors = new WeakMap<CreateNodeRequest, string | null>();

/** Splice the optimistic row for `newNode` into its parent's cached children (tracking it when it has a client id). */
export function insertOptimisticCreate(queryClient: QueryClient, newNode: CreateNodeRequest): CreateContext {
	const parentId = newNode.parent_id ?? null;
	const previousChildren = queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId));
	const now = Math.floor(Date.now() / 1000);
	const optimisticNode: NodeResponse = {
		id: newNode.id ?? `temp-${Date.now()}`,
		parent_id: parentId,
		name: newNode.name,
		note: newNode.note ?? null,
		priority: 0,
		data: {layoutMode: newNode.layoutMode ?? null},
		createdAt: now,
		modifiedAt: now,
		completedAt: null,
		// A new bullet is a plain leaf: without the flags its row would render as a parent until the refetch.
		hasChildren: false,
		hasUncompletedChildren: false,
		isMirror: false,
	};
	const siblings = previousChildren ?? [];
	const index = requestedIndex(newNode, siblings.length);
	if (newNode.id !== undefined) {
		pendingCreates.begin(optimisticNode, index);
		// The editor mounts on this row at once, so a search must show it before the server answers.
		useOutlineStore.getState().markCreatedForSearch(newNode.id);
	}
	// One notification for the row and its parent's flags, so the outline never renders one without the other.
	const children = spliceChildren(siblings, optimisticNode, index);
	if (exactIndex(newNode) !== undefined && newNode.at_end !== true) {
		createAnchors.set(
			newNode,
			children[children.findIndex((child) => child.id === optimisticNode.id) - 1]?.id ?? null,
		);
	}
	const restoreParentFlags = notifyManager.batch(() => {
		queryClient.setQueryData<NodeResponse[]>(nodeKeys.children(parentId), children);
		return syncParentFlags(queryClient, parentId);
	});
	return {optimisticId: optimisticNode.id, parentId, restoreParentFlags};
}

/** Undo one failed create: drop its own optimistic row (not a snapshot, which would clobber parallel creates). */
export function rollbackCreate(queryClient: QueryClient, context: CreateContext): void {
	queryClient.setQueryData<NodeResponse[] | undefined>(nodeKeys.children(context.parentId), (old) =>
		removeOptimistic(old, context.optimisticId),
	);
	context.restoreParentFlags();
}

const updateUndos = new HeldUndos<UpdateNodeResponse, UpdateNodeRequest & {nodeId: string}>();

function planEdit(
	{nodeId, name, note, layoutMode, numberedStart}: UpdateNodeRequest & {nodeId: string},
	queryClient: QueryClient,
): UndoPlan<unknown> {
	return cachedOps(queryClient, {kind: "edit", nodeId, name, note, layoutMode, numberedStart});
}

/**
 * The cache as it stood when `mutate` was called, keyed by its variables. `onMutate` runs a
 * tick later, after callers may already have previewed the edit in the cache (tag explode does),
 * so a snapshot taken there would roll a failed save back to the edited value.
 */
/** Saves of each node still in flight; only the last one to answer writes the server's text into the cache. */
const pendingSaves = new Map<string, number>();

const preEditSnapshots = new WeakMap<UpdateNodeRequest & {nodeId: string}, () => void>();

/** Each save's rollback of its optimistic patch, made at `mutate` time and handed to `onMutate` by request identity. */
const earlyUpdates = new WeakMap<UpdateNodeRequest & {nodeId: string}, () => void>();

/** Counts the save as pending and writes it into the cache; returns the rollback. */
function patchOptimisticUpdate(queryClient: QueryClient, variables: UpdateNodeRequest & {nodeId: string}): () => void {
	const {nodeId, ...updates} = variables;
	pendingSaves.set(nodeId, (pendingSaves.get(nodeId) ?? 0) + 1);
	// A detail refetch in flight would answer the old text; a cancel reverts to the data as patched below.
	void queryClient.cancelQueries({queryKey: nodeKeys.detail(nodeId)});
	// Patch the row in its parent's list too: an empty row's name drives whether its editor stays mounted.
	const restorePatched = patchCachedNode(queryClient, nodeId, (node) => ({
		...node,
		name: updates.name ?? node.name,
		note: updates.note ?? node.note,
		data: {...node.data, layoutMode: updates.layoutMode ?? node.data.layoutMode},
		...(updates.numberedStart === undefined ? {} : {numberedStart: updates.numberedStart}),
		...(updates.tableSet === undefined ? {} : {table: applyTableSet(node.table, updates.tableSet)}),
		modifiedAt: Math.floor(Date.now() / 1000),
	}));
	// A mirror's row shows its original's text.
	const restoreMirrors = patchMirrors(queryClient, nodeId, (node) => ({
		...node,
		name: updates.name ?? node.name,
		note: updates.note ?? node.note,
	}));
	return () => {
		restoreMirrors();
		restorePatched();
	};
}

/**
 * Updates a node with optimistic update.
 */
/**
 * An edit made through a backlink row can remove the link that made the row. Captured before the targets' Backlinks
 * refetch, this returns what to do after it: put the caret on the neighbouring row, or go Home when the item was zoomed
 * (history replaced). Undefined when the node is not a backlink item of a changed target.
 */
function backlinkRowFallback(queryClient: QueryClient, nodeId: string, targets: string[]): (() => void) | undefined {
	const target = targets.find((id) =>
		queryClient
			.getQueryData<BacklinksResponse>(nodeKeys.backlinks(id))
			?.items.some((item) => item.node.id === nodeId),
	);
	const {editingId} = useOutlineStore.getState();
	if (target === undefined || editingId !== nodeId) {
		return undefined;
	}
	const rows = readNavigableRows(queryClient);
	const zoomedId = activePaneView().zoomedNodeId;
	return () => {
		const stillThere = queryClient
			.getQueryData<BacklinksResponse>(nodeKeys.backlinks(target))
			?.items.some((item) => item.node.id === nodeId);
		if (stillThere === true || useOutlineStore.getState().editingId !== nodeId) {
			return;
		}
		const plan = backlinkEditFallback(rows, nodeId, zoomedId);
		if ("home" in plan) {
			globalThis.location.replace("/#/");
		} else {
			useOutlineStore.getState().resumeEditing(plan.id, plan.offset === "end" ? Number.MAX_SAFE_INTEGER : 0);
		}
	};
}

export function useUpdateNode() {
	const queryClient = useQueryClient();
	const addErrorNotification = useOutlineStore((state) => state.addErrorNotification);

	const mutation = useMutationRunner({
		// In line with undo replays: a save and a replay of the same text must land in issue order.
		mutationFn: async ({nodeId, ...request}: UpdateNodeRequest & {nodeId: string}) =>
			serializeWrite(async () => updateNode(nodeId, request)),
		onMutate(variables) {
			const restore = earlyUpdates.get(variables) ?? (() => {});
			earlyUpdates.delete(variables);
			return {restore};
		},
		onSuccess(data, variables) {
			updateUndos.settle(variables, {data});
		},
		onError(error, variables, context) {
			updateUndos.settle(variables, "failed");
			// Roll back to previous value on error
			context?.restore();
			addErrorNotification(`Failed to update node: ${error.message}`);
		},
		async onSettled(data, error, variables) {
			const {nodeId} = variables;
			const pending = (pendingSaves.get(nodeId) ?? 1) - 1;
			if (pending === 0) {
				pendingSaves.delete(nodeId);
			} else {
				pendingSaves.set(nodeId, pending);
			}
			if (error !== null || data === undefined) {
				// The rollback may not match the server: refetch everything that could hold the node.
				await queryClient.invalidateQueries({queryKey: nodeKeys.all});
				return;
			}
			// A later save of the same node still in flight owns the cached text until it answers, and so does an
			// undo already previewed over this save.
			if (pending === 0 && !textReplayPending(nodeId)) {
				applySavedText(queryClient, data.node);
				verifyAgainstServer(queryClient, "update", affectedKeys(queryClient, [nodeId], []));
			}
			const fallback = backlinkRowFallback(queryClient, nodeId, data.effects.backlinkTargets);
			await invalidateSaveEffects(queryClient, data.effects);
			fallback?.();
		},
	});
	const {mutate: sendUpdate} = mutation;
	/**
	 * Patches the cache in the same call as `mutate`, not a tick later in `onMutate`, so an undo pressed right
	 * after the save (it flushes the pending text) previews over the saved text rather than under it.
	 */
	const mutateNow = useCallback<typeof sendUpdate>(
		(variables, options) => {
			const restorePreEdit = preEditSnapshots.get(variables);
			preEditSnapshots.delete(variables);
			const restorePatched = patchOptimisticUpdate(queryClient, variables);
			earlyUpdates.set(variables, () => {
				restorePatched();
				restorePreEdit?.();
			});
			sendUpdate(variables, options);
		},
		[queryClient, sendUpdate],
	);
	// Outermost, so the slot reads the before-text ahead of `mutateNow`'s optimistic patch.
	const nodeMutate = useUndoableMutate(mutateNow, updateUndos, planEdit);
	const homeMutation = useMutationRunner({
		mutationFn: updateHome,
		async onMutate(layoutMode) {
			await queryClient.cancelQueries({queryKey: nodeKeys.home()});
			const previous = queryClient.getQueryData<HomeResponse>(nodeKeys.home());
			queryClient.setQueryData<HomeResponse>(nodeKeys.home(), {layoutMode});
			return {previous};
		},
		onError(error, _layoutMode, context) {
			queryClient.setQueryData(nodeKeys.home(), context?.previous);
			addErrorNotification(`Failed to update home: ${error.message}`);
		},
		async onSettled() {
			await queryClient.invalidateQueries({queryKey: nodeKeys.home()});
		},
	});
	const homeMutate = homeMutation.mutate;
	// `nodeId: "home"` writes Home's layoutMode, the only field Home has.
	const mutate = useCallback<typeof nodeMutate>(
		(variables, options) => {
			if (variables.nodeId === HOME_TARGET) {
				if (variables.layoutMode !== undefined) {
					const before = storedLayout(queryClient.getQueryData<HomeResponse>(nodeKeys.home())?.layoutMode);
					const after = storedLayout(variables.layoutMode);
					if (before !== after) {
						recordOp({
							kind: "layout",
							nodeId: HOME_TARGET,
							before: {layoutMode: before, numberedStart: null},
							after: {layoutMode: after, numberedStart: null},
						});
					}
					homeMutate(variables.layoutMode);
				}
				return;
			}
			preEditSnapshots.set(variables, snapshotCachedNode(queryClient, variables.nodeId));
			nodeMutate(variables, options);
		},
		[homeMutate, nodeMutate, queryClient],
	);
	return {...mutation, mutate};
}

const deleteUndos = new HeldUndos<void, string>();

function planDelete(nodeId: string, queryClient: QueryClient): UndoPlan<unknown> {
	return cachedOps(queryClient, {kind: "delete", nodeId});
}

/**
 * Deletes a node with optimistic update.
 */
export function useDeleteNode() {
	const queryClient = useQueryClient();
	const addErrorNotification = useOutlineStore((state) => state.addErrorNotification);

	const mutation = useMutationRunner({
		mutationFn: deleteNode,
		async onMutate(nodeId) {
			// Cancel first: a cancelled refetch reverts to the data it started from, row included.
			await queryClient.cancelQueries({queryKey: nodeKeys.all});
			const parentId = readNode(queryClient, nodeId)?.parent_id ?? null;
			removeDeletedRow(queryClient, nodeId);
			return {parentId};
		},
		onSuccess(data, nodeId) {
			deleteUndos.settle(nodeId, {data});
		},
		onError(error, nodeId) {
			deleteUndos.settle(nodeId, "failed");
			// onSettled's refetch puts the optimistically removed row back.
			addErrorNotification(`Failed to delete node: ${error.message}`);
		},
		async onSettled(_data, error, _nodeId, context) {
			if (error === null && context !== undefined) {
				verifyAgainstServer(queryClient, "delete", affectedKeys(queryClient, [], [context.parentId]));
			}
			// A failed delete refetches everything, which puts the optimistically removed row back.
			await (error === null
				? syncNodeChanges(queryClient)
				: queryClient.invalidateQueries({queryKey: nodeKeys.all}));
		},
	});
	const mutate = useUndoableMutate(mutation.mutate, deleteUndos, planDelete);
	return {...mutation, mutate};
}

const moveUndos = new HeldUndos<NodeListResponse, MoveNodeRequest & {nodeId: string}>();

function planMove(request: MoveNodeRequest & {nodeId: string}, queryClient: QueryClient): UndoPlan<unknown> {
	return cachedOps(queryClient, {
		kind: "move",
		ids: [request.nodeId],
		parentId: request.parent_id,
		index: exactIndex(request),
	});
}

/**
 * Moves a node to `index` under `parent_id` (same parent or another) with an
 * optimistic splice: the row is removed then inserted at the index, never duplicated.
 */
export function useMoveNode() {
	const queryClient = useQueryClient();
	const addErrorNotification = useOutlineStore((state) => state.addErrorNotification);

	const mutation = useMutationRunner({
		mutationFn: async ({nodeId, ...request}: MoveNodeRequest & {nodeId: string}) => moveNode(nodeId, request),
		async onMutate(request) {
			pendingMoves.begin(request, [readNode(queryClient, request.nodeId)?.parent_id ?? null, request.parent_id]);
			await queryClient.cancelQueries({queryKey: nodeKeys.all});
			const node = readNode(queryClient, request.nodeId);
			return node
				? notifyManager.batch(() =>
						spliceMovedRows(queryClient, [node], request.parent_id, (count) =>
							requestedIndex(request, count),
						),
					)
				: [];
		},
		onSuccess(data, variables) {
			moveUndos.settle(variables, {data});
		},
		onError(error, variables, snapshots) {
			moveUndos.settle(variables, "failed");
			restoreSnapshots(queryClient, snapshots);
			addErrorNotification(`Failed to move node: ${error.message}`);
		},
		async onSettled(_data, error, variables, snapshots) {
			pendingMoves.end(variables);
			if (error === null) {
				// The pre-move cache knows the old parent; the move endpoint answers only the sibling lists.
				const parentIds = (snapshots ?? []).flatMap((snapshot) =>
					snapshot.kind === "children" ? [snapshot.parentId] : [],
				);
				verifyAgainstServer(
					queryClient,
					"move",
					affectedKeys(queryClient, [variables.nodeId], [...parentIds, variables.parent_id]),
				);
			}
			await (error === null
				? syncNodeChanges(queryClient)
				: queryClient.invalidateQueries({queryKey: nodeKeys.all}));
		},
	});
	const mutate = useUndoableMutate(mutation.mutate, moveUndos, planMove);
	return {...mutation, mutate};
}

interface BlockMoveRequest {
	ids: string[];
	parent_id: string | null;
	/** Slot among ALL of the new parent's children, moved ones included (see `spliceBlock`); omitted = bottom. */
	index?: number;
	/** Client only: expand the new parent in the same render as the optimistic splice (Tab's auto-expand). */
	expandParent?: boolean;
}

/** One block, or several moved in order in one request, each slot counted after the earlier blocks moved. */
type MoveNodesRequest = BlockMoveRequest | {moves: BlockMoveRequest[]};

function blocksOf(request: MoveNodesRequest): BlockMoveRequest[] {
	return "moves" in request ? request.moves : [request];
}

async function moveNodes(request: MoveNodesRequest): Promise<NodeResponse[]> {
	const blocks = blocksOf(request).map(({expandParent: _expandParent, ...block}) => block);
	await pendingCreates.settled(blocks.flatMap((block) => [...block.ids, block.parent_id]));
	const response = await fetch("/api/v1/nodes/move", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(blocks.length === 1 ? blocks[0] : {moves: blocks}),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to move nodes", response);
	}
	const data = await readJson<NodeListResponse>(response);
	return data.nodes;
}

const moveNodesUndos = new HeldUndos<NodeResponse[], MoveNodesRequest>();

function planMoveNodes(request: MoveNodesRequest, queryClient: QueryClient): UndoPlan<unknown> {
	const moves = blocksOf(request).map(({ids, parent_id: parentId, index}) => ({ids, parentId, index}));
	return cachedOps(queryClient, {kind: "moves", moves});
}

/**
 * Whether a block move started while another move was still in flight since the moves last all settled. Each reply
 * describes the tree as of its own move, so an overtaken reply would put back rows a later optimistic move took away;
 * once overlapped, replies are dropped and the last one to settle reads the change feed instead.
 */
let blockMovesOverlapped = false;

/**
 * Moves a contiguous block of nodes, in the given order, to `index` under `parent_id`
 * in one call (multi-select, drag, Sort). Splices optimistically (expanding the new parent in the same
 * notification flush when asked), then applies the server's sibling lists for every touched parent in one flush,
 * or, when moves overlapped, patches the cache from the change feed once the last one settles.
 */
function moveNodesOptions(queryClient: QueryClient) {
	return mutationOptions({
		mutationFn: moveNodes,
		async onMutate(request: MoveNodesRequest) {
			const blocks = blocksOf(request);
			const readRows = (ids: string[]) =>
				ids.map((id) => readNode(queryClient, id)).filter((row): row is NodeResponse => row !== undefined);
			blockMovesOverlapped ||= pendingMoves.size > 0;
			pendingMoves.begin(
				request,
				blocks.flatMap((block) => [...readRows(block.ids).map((row) => row.parent_id), block.parent_id]),
			);
			await queryClient.cancelQueries({queryKey: nodeKeys.all});
			// Every block splices in one notification flush, so a non-contiguous selection paints once.
			return notifyManager.batch(() =>
				blocks.flatMap(({ids, parent_id: parentId, index, expandParent}) => {
					if (expandParent === true && parentId !== null) {
						// In the same task as the splice: React's sync render for the store change runs in a microtask,
						// after the splice below, so the expansion and the move paint together.
						useOutlineStore.getState().expand(parentId);
					}
					// Read again: a move sent just before this one, or an earlier block, may have spliced the rows meanwhile.
					return spliceMovedRows(queryClient, readRows(ids), parentId, (count) => index ?? count);
				}),
			);
		},
		onSuccess(nodes, variables, snapshots) {
			pendingMoves.end(variables);
			moveNodesUndos.settle(variables, {data: nodes});
			if (blockMovesOverlapped) {
				if (pendingMoves.size === 0) {
					blockMovesOverlapped = false;
					void syncNodeChanges(queryClient);
				}
				return;
			}
			notifyManager.batch(() => {
				// A move can bring a dated node into or out of a day, so Found Dates lists are refetched.
				void queryClient.invalidateQueries({queryKey: [...nodeKeys.all, "found-dates"]});
				for (const {parentId} of snapshots.filter((snapshot) => snapshot.kind === "children")) {
					queryClient.setQueryData<NodeResponse[]>(
						nodeKeys.children(parentId),
						nodes.filter((node) => node.parent_id === parentId),
					);
				}
				for (const node of nodes) {
					queryClient.setQueryData<NodeResponse>(nodeKeys.detail(node.id), (old) => (old ? node : old));
				}
			});
		},
		async onError(error, variables, snapshots) {
			pendingMoves.end(variables);
			if (pendingMoves.size === 0) {
				blockMovesOverlapped = false;
			}
			moveNodesUndos.settle(variables, "failed");
			restoreSnapshots(queryClient, snapshots);
			useOutlineStore.getState().addErrorNotification(`Failed to move nodes: ${error.message}`);
			await queryClient.invalidateQueries({queryKey: nodeKeys.all});
		},
		onSettled(_nodes, error, variables, snapshots) {
			if (error === null) {
				const parentIds = (snapshots ?? []).flatMap((snapshot) =>
					snapshot.kind === "children" ? [snapshot.parentId] : [],
				);
				verifyAgainstServer(
					queryClient,
					"move nodes",
					affectedKeys(
						queryClient,
						blocksOf(variables).flatMap((block) => block.ids),
						parentIds,
					),
				);
			}
		},
	});
}

export function useMoveNodes() {
	const queryClient = useQueryClient();
	const mutation = useMutationRunner(moveNodesOptions(queryClient));
	const mutate = useUndoableMutate(mutation.mutate, moveNodesUndos, planMoveNodes);
	return {...mutation, mutate};
}

/** `useMoveNodes().mutate` without a hook, for a bullet drag's drop: a resting row holds no observer. */
export function moveNodesNow(queryClient: QueryClient, request: MoveNodesRequest): void {
	runUndoableMutation(queryClient, moveNodesOptions(queryClient), moveNodesUndos, planMoveNodes, request);
}

type CacheSnapshot =
	| {kind: "children"; parentId: string | null; previous: NodeResponse[] | undefined}
	| {kind: "detail"; nodeId: string; previous: NodeResponse | undefined}
	| {kind: "flags"; restore: () => void};

/**
 * Optimistically move `rows` under `newParentId` at `indexFor(siblingCount)`: remove them
 * from their old parents' cached lists, splice them into the new parent's, and repoint
 * their detail caches. Returns snapshots of every touched entry for rollback.
 */
function spliceMovedRows(
	queryClient: QueryClient,
	rows: NodeResponse[],
	newParentId: string | null,
	indexFor: (count: number) => number,
): CacheSnapshot[] {
	const movedIds = new Set(rows.map((row) => row.id));
	const parentIds = [...new Set([...rows.map((row) => row.parent_id), newParentId])];
	const snapshots: CacheSnapshot[] = parentIds.map((parentId) => ({
		kind: "children",
		parentId,
		previous: queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId)),
	}));
	for (const snapshot of snapshots) {
		if (snapshot.kind === "children" && snapshot.previous && snapshot.parentId !== newParentId) {
			queryClient.setQueryData<NodeResponse[]>(
				nodeKeys.children(snapshot.parentId),
				snapshot.previous.filter((child) => !movedIds.has(child.id)),
			);
		}
	}
	const moved = rows.map((row) => ({...row, parent_id: newParentId}));
	// A leaf gaining its first child has no list to splice into: seed it, so the expanded row shows
	// the moved rows at once instead of an empty list until the refetch.
	const target =
		queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(newParentId)) ??
		(newParentId !== null && readNode(queryClient, newParentId)?.hasChildren === false ? [] : undefined);
	if (target) {
		queryClient.setQueryData<NodeResponse[]>(
			nodeKeys.children(newParentId),
			spliceBlock(target, moved, indexFor(target.length)),
		);
	}
	for (const row of moved) {
		const previous = queryClient.getQueryData<NodeResponse>(nodeKeys.detail(row.id));
		snapshots.push({kind: "detail", nodeId: row.id, previous});
		if (previous) {
			queryClient.setQueryData<NodeResponse>(nodeKeys.detail(row.id), {...previous, parent_id: newParentId});
		}
	}
	for (const parentId of parentIds) {
		snapshots.push({kind: "flags", restore: syncParentFlags(queryClient, parentId)});
	}
	return snapshots;
}

/** Roll every snapshotted cache entry back to its pre-mutation value. */
function restoreSnapshots(queryClient: QueryClient, snapshots: CacheSnapshot[] | undefined): void {
	// Newest first: a flags restore writes back lists as they stood after the splice.
	for (const snapshot of (snapshots ?? []).toReversed()) {
		if (snapshot.kind === "flags") {
			snapshot.restore();
			continue;
		}
		if (snapshot.previous === undefined) {
			continue;
		}
		const key =
			snapshot.kind === "children" ? nodeKeys.children(snapshot.parentId) : nodeKeys.detail(snapshot.nodeId);
		queryClient.setQueryData(key, snapshot.previous);
	}
}

const toggleUndos = new HeldUndos<NodeResponse, {nodeId: string; isCurrentlyCompleted: boolean}>();

function planToggle(
	{nodeId, isCurrentlyCompleted}: {nodeId: string; isCurrentlyCompleted: boolean},
	queryClient: QueryClient,
): UndoPlan<unknown> {
	return cachedOps(queryClient, {kind: isCurrentlyCompleted ? "uncomplete" : "complete", nodeId});
}

/**
 * Toggles node completion status with optimistic update.
 * If completed, uncompletes. If not completed, completes.
 */
function toggleCompleteOptions(queryClient: QueryClient) {
	return mutationOptions({
		mutationFn: async ({nodeId, isCurrentlyCompleted}: {nodeId: string; isCurrentlyCompleted: boolean}) =>
			isCurrentlyCompleted ? uncompleteNode(nodeId) : completeNode(nodeId),
		async onMutate({nodeId, isCurrentlyCompleted}) {
			// Cancel outgoing refetches
			await queryClient.cancelQueries({queryKey: nodeKeys.all});
			const now = Math.floor(Date.now() / 1000);
			const completedAt = isCurrentlyCompleted ? null : now;
			// A mirror's completion is its original's: the write goes to the original, so the original and
			// every rendered mirror change together.
			const originalId = readNode(queryClient, nodeId)?.originalNodeId ?? nodeId;
			const parentIds = cachedCopyParentIds(queryClient, originalId);
			const parentId = readNode(queryClient, nodeId)?.parent_id ?? null;
			const complete = (node: NodeResponse): NodeResponse => ({...node, completedAt, modifiedAt: now});
			// Every cached copy of the row, then each copy's parent flags: completing the last open child makes it a done parent.
			return notifyManager.batch(() => {
				const restoreRow = patchCachedNode(queryClient, originalId, complete);
				const restoreMirrors = patchMirrors(queryClient, originalId, complete);
				const restoreFlags = parentIds.map((id) => syncParentFlags(queryClient, id));
				return {
					parentId,
					originalId,
					parentIds,
					restore() {
						for (const restoreParent of restoreFlags.toReversed()) {
							restoreParent();
						}
						restoreMirrors();
						restoreRow();
					},
				};
			});
		},
		onSuccess(data, variables) {
			toggleUndos.settle(variables, {data});
		},
		onError(error, variables, context) {
			toggleUndos.settle(variables, "failed");
			// Roll back to previous values on error
			context?.restore();
			useOutlineStore.getState().addErrorNotification(`Failed to toggle completion: ${error.message}`);
		},
		async onSettled(_data, error, variables, context) {
			if (error === null && context !== undefined) {
				verifyAgainstServer(
					queryClient,
					"complete",
					affectedKeys(queryClient, [variables.nodeId, context.originalId], context.parentIds),
				);
			}
			await (error === null
				? syncNodeChanges(queryClient)
				: queryClient.invalidateQueries({queryKey: nodeKeys.all}));
		},
	});
}

export function useToggleComplete() {
	const queryClient = useQueryClient();
	const mutation = useMutationRunner(toggleCompleteOptions(queryClient));
	const mutate = useUndoableMutate(mutation.mutate, toggleUndos, planToggle);
	return {...mutation, mutate};
}

/** `useToggleComplete().mutate` without a hook, for a row's checkbox or menu: a resting row holds no observer. */
export function toggleComplete(
	queryClient: QueryClient,
	variables: {nodeId: string; isCurrentlyCompleted: boolean},
): void {
	runUndoableMutation(queryClient, toggleCompleteOptions(queryClient), toggleUndos, planToggle, variables);
}

const restoreUndos = new HeldUndos<NodeResponse, RestoreNodeRequest & {nodeId: string}>();

function planRestore(
	{nodeId, parent_id: parentId, index}: RestoreNodeRequest & {nodeId: string},
	queryClient: QueryClient,
): UndoPlan<unknown> {
	return cachedOps(queryClient, {kind: "restore", nodeId, parentId, index});
}

/** Restores a deleted node under its original id, then patches the cache with the change. */
// fallow-ignore-next-line unused-export -- callers land with undo/redo commands (M2-60, M2-61)
export function useRestoreNode() {
	const queryClient = useQueryClient();
	const addErrorNotification = useOutlineStore((state) => state.addErrorNotification);

	const mutation = useMutationRunner({
		mutationFn: async ({nodeId, ...request}: RestoreNodeRequest & {nodeId: string}) => restoreNode(nodeId, request),
		onSuccess(data, variables) {
			restoreUndos.settle(variables, {data});
		},
		onError(error, variables) {
			restoreUndos.settle(variables, "failed");
			addErrorNotification(error.message);
		},
		async onSettled(_data, error) {
			await (error === null
				? syncNodeChanges(queryClient)
				: queryClient.invalidateQueries({queryKey: nodeKeys.all}));
		},
	});
	const mutate = useUndoableMutate(mutation.mutate, restoreUndos, planRestore);
	return {...mutation, mutate};
}

interface MirrorNodesRequest {
	/** The items to mirror; a mirror resolves to its original on the server. */
	item_ids: string[];
	parent_id: string | null;
	/** Slot among ALL of the parent's children; omitted = bottom. */
	index?: number;
}

async function mirrorNodes(request: MirrorNodesRequest): Promise<NodeResponse[]> {
	await pendingCreates.settled([...request.item_ids, request.parent_id]);
	const response = await fetch("/api/v1/nodes/mirror", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(request),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to mirror nodes", response);
	}
	const data = await readJson<NodeListResponse>(response);
	return data.nodes;
}

/** Mirrors `originalId` under `parentId` at `index` inside the open undo step (paste of a mirrored row); the new id. */
export async function mirrorNodeAt(
	queryClient: QueryClient,
	originalId: string,
	parentId: string | null,
	index: number,
): Promise<string | undefined> {
	const [id] = await copyNodesAt(queryClient, "mirror", [originalId], parentId, index);
	return id;
}

/**
 * Duplicates (deep copies, `kind: "duplicate"`) or mirrors rows into `parentId` at consecutive slots from `index`, as
 * one write and one undo step that deletes every new row. Resolves to the new ids in order.
 */
export async function copyNodesAt(
	queryClient: QueryClient,
	kind: "duplicate" | "mirror",
	ids: readonly string[],
	parentId: string | null,
	index: number,
): Promise<string[]> {
	const slot = holdUndoSlot();
	try {
		let created: string[];
		if (kind === "mirror") {
			const nodes = await mirrorNodes({item_ids: [...ids], parent_id: parentId, index});
			created = nodes.map((node) => node.id);
		} else {
			created = await duplicateNodes({ids: [...ids], parent_id: parentId, index});
		}
		slot.settle(toUndoOps({kind: "mirror", nodeIds: created, parentId, index}, queryClient));
		return created;
	} catch (error) {
		slot.settle([]);
		throw error;
	}
}

async function duplicateNodes(request: {ids: string[]; parent_id: string | null; index: number}): Promise<string[]> {
	await pendingCreates.settled([...request.ids, request.parent_id]);
	const response = await fetch("/api/v1/nodes/duplicate", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(request),
	});
	if (!response.ok) {
		throw await toRequestStatusError("Failed to duplicate nodes", response);
	}
	const data = await readJson<CreatedIdsResponse>(response);
	return data.ids;
}

/**
 * Detach Mirror: the server swaps the mirror root (a mirror, or an original that has mirrors) for a plain copy of the
 * subtree in the same slot. Undo removes the copy and brings the old row back. Resolves to the copy's id.
 */
export async function detachMirrorNode(queryClient: QueryClient, nodeId: string): Promise<string | undefined> {
	await pendingCreates.settled([nodeId]);
	const parentId = readNode(queryClient, nodeId)?.parent_id ?? null;
	const removed = toUndoOps({kind: "delete", nodeId}, queryClient);
	const slot = holdUndoSlot();
	try {
		const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/detach-mirror`, {method: "POST"});
		if (!response.ok) {
			throw await toRequestStatusError("Failed to detach mirror", response);
		}
		const {node} = await readJson<DetachMirrorResponse>(response);
		const index = removed[0]?.kind === "delete" ? removed[0].index : undefined;
		slot.settle([
			...(node === null ? [] : toUndoOps({kind: "create", nodeId: node.id, parentId, index}, queryClient)),
			...removed,
		]);
		await syncNodeChanges(queryClient);
		return node?.id;
	} catch (error) {
		slot.settle([]);
		throw error;
	}
}

/**
 * Mirrors: Swap origin. The mirror and its original exchange slots (ids unchanged); a plain original only warns.
 * Undo moves both back. Resolves to the warning text when there was nothing to swap.
 */
export async function swapMirrorOriginNode(queryClient: QueryClient, nodeId: string): Promise<string | undefined> {
	await pendingCreates.settled([nodeId]);
	const node = readNode(queryClient, nodeId);
	const original =
		node?.isMirror === true && node.originalNodeId != null ? readNode(queryClient, node.originalNodeId) : undefined;
	const orders = new Map<string | null, string[]>();
	for (const parentId of new Set([node?.parent_id ?? null, original?.parent_id ?? null])) {
		orders.set(
			parentId,
			sortByPriority(readChildren(queryClient, parentId) ?? []).map((child) => child.id),
		);
	}
	const ops =
		node === undefined || original === undefined
			? []
			: swapMoveOps(
					orders,
					{id: node.id, parentId: node.parent_id ?? null},
					{id: original.id, parentId: original.parent_id ?? null},
				);
	const slot = holdUndoSlot();
	try {
		const response = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/swap-mirror-origin`, {
			method: "POST",
		});
		if (!response.ok) {
			throw await toRequestStatusError("Failed to swap origin", response);
		}
		const body = await readJson<SwapMirrorOriginResponse>(response);
		const warning = "warning" in body ? body.warning : undefined;
		slot.settle(warning === undefined ? ops : []);
		await syncNodeChanges(queryClient);
		return warning;
	} catch (error) {
		slot.settle([]);
		throw error;
	}
}

const mirrorNodesUndos = new HeldUndos<NodeResponse[], MirrorNodesRequest>();

/** The new mirrors' ids are known only from the reply, so the ops are built then. */
function planMirrorNodes(
	{parent_id: parentId, index}: MirrorNodesRequest,
	queryClient: QueryClient,
): UndoPlan<NodeResponse[]> {
	const start = index ?? readChildren(queryClient, parentId)?.length;
	return (nodes) =>
		toUndoOps({kind: "mirror", nodeIds: nodes.map((node) => node.id), parentId, index: start}, queryClient);
}

/** Mirrors items under `parent_id` (MIR4); ⌘Z deletes the new mirrors. The change sync shows them. */
export function useMirrorNodes() {
	const queryClient = useQueryClient();
	const mutation = useMutationRunner({
		mutationFn: mirrorNodes,
		onSuccess(nodes, variables) {
			mirrorNodesUndos.settle(variables, {data: nodes});
		},
		onError(error, variables) {
			mirrorNodesUndos.settle(variables, "failed");
			useOutlineStore.getState().addErrorNotification(`Failed to mirror nodes: ${error.message}`);
		},
		async onSettled(_nodes, error) {
			await (error === null
				? syncNodeChanges(queryClient)
				: queryClient.invalidateQueries({queryKey: nodeKeys.all}));
		},
	});
	const mutate = useUndoableMutate(mutation.mutate, mirrorNodesUndos, planMirrorNodes);
	return {...mutation, mutate};
}

/** The whole cached subtree of `rootId` (Home's tree for null), independent of what the client has loaded. */
async function fetchSubtreeItems(rootId: string | null): Promise<SubtreeItem[]> {
	const response = await fetch(`/api/v1/nodes/${encodeURIComponent(rootId ?? HOME_TARGET)}/subtree-ids`);
	if (!response.ok) {
		throw await toRequestStatusError("Failed to fetch subtree", response);
	}
	const data = await readJson<SubtreeItemsResponse>(response);
	return data.items;
}

/** A `TreeIndex` over the subtree rows; Home's top-level rows sit under the `home` key. */
function subtreeIndex(items: readonly SubtreeItem[], showCompleted: boolean): TreeIndex {
	const children = new Map<string, string[]>();
	const completed = new Set<string>();
	for (const item of items) {
		const key = item.parentId ?? HOME_TARGET;
		children.set(key, [...(children.get(key) ?? []), item.id]);
		if (item.completed) {
			completed.add(item.id);
		}
	}
	const isVisible = (id: string) => showCompleted || !completed.has(id);
	return {
		children: (id) => children.get(id) ?? [],
		isVisible,
		hasVisibleChildren: (id) => (children.get(id) ?? []).some(isVisible),
		hasAnyChildren: (id) => (children.get(id) ?? []).length > 0,
	};
}

/** How long Expand all waits for the full subtree before using what the client has cached. */
const SUBTREE_FETCH_TIMEOUT_MS = 3000;

/** The subtree of `rootId` as far as the client has loaded it (Home's tree for null). */
function cachedSubtreeItems(queryClient: QueryClient, rootId: string | null): SubtreeItem[] {
	const items: SubtreeItem[] = [];
	const walk = (parentId: string | null): void => {
		for (const child of readChildren(queryClient, parentId) ?? []) {
			items.push({
				id: child.id,
				parentId: parentId ?? null,
				completed: child.completedAt !== null,
				hasChildren: child.hasChildren === true,
			});
			walk(child.id);
		}
	};
	walk(rootId);
	return items;
}

/** Sets the expansion of `rootId` (each visible top item for Home) and its visible descendants in `items`. */
function applySubtreeExpansion(items: readonly SubtreeItem[], rootId: string | null, open: boolean): void {
	const {expandedIds, showCompleted, replaceExpanded} = activePaneView();
	const index = subtreeIndex(items, showCompleted);
	const roots = rootId === null ? index.children(HOME_TARGET).filter((id) => index.isVisible(id)) : [rootId];
	let next = new Set<string>(expandedIds);
	for (const root of roots) {
		next = expandOrCollapseAll(next, index, root, open);
	}
	replaceExpanded(next);
}

/**
 * Upstream Expand all / Collapse all on `rootId` (the whole page for Home): fetches the full subtree so
 * descendants the client never loaded are covered, then sets their expansion; hidden completed subtrees are skipped.
 * When the fetch is slow or fails, the loaded subtree (`queryClient`'s cache) is expanded at once; a late full
 * result then replaces it unless expansion changed in between.
 */
export async function expandOrCollapseSubtree(
	rootId: string | null,
	open: boolean,
	queryClient?: QueryClient,
): Promise<void> {
	const fetched = fetchSubtreeItems(rootId);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			resolve(null);
		}, SUBTREE_FETCH_TIMEOUT_MS);
	});
	const applyCached = (): void => {
		applySubtreeExpansion(queryClient === undefined ? [] : cachedSubtreeItems(queryClient, rootId), rootId, open);
	};
	let items: SubtreeItem[] | null;
	try {
		items = await Promise.race([fetched, timedOut]);
	} catch (error) {
		clearTimeout(timer);
		applyCached();
		throw error;
	}
	clearTimeout(timer);
	if (items !== null) {
		applySubtreeExpansion(items, rootId, open);
		return;
	}
	applyCached();
	const changesAfterFallback = localExpansionChangeState().count;
	const full = await fetched.catch(() => null);
	if (full !== null && localExpansionChangeState().count === changesAfterFallback) {
		applySubtreeExpansion(full, rootId, open);
	}
}

/** `expandOrCollapseSubtree` that reports a failed subtree fetch as an error notification. */
function expandAll(rootId: string | null, open: boolean, queryClient: QueryClient): void {
	expandOrCollapseSubtree(rootId, open, queryClient).catch((error: unknown) => {
		useOutlineStore.getState().addErrorNotification(error instanceof Error ? error.message : String(error));
	});
}

/** Expands or collapses a whole subtree; the callback is one module function, so its rows hold no store selector. */
export function useExpandAll(): (rootId: string | null, open: boolean) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(rootId, open) => {
			expandAll(rootId, open, queryClient);
		},
		[queryClient],
	);
}

export type MoveNodesMutate = ReturnType<typeof useMoveNodes>["mutate"];

/**
 * Send planned block moves as one request: the server applies them in order, each slot counted against the outline
 * the earlier ones left, as the planner counted it. Resolves once the request settles.
 */
export async function sendBlockMoves(
	moves: readonly (BlockMove & {expandParent?: boolean})[],
	mutate: MoveNodesMutate,
): Promise<void> {
	const blocks = moves.map(({ids, parentId, index, expandParent}) => ({
		ids,
		parent_id: parentId,
		...(index === undefined ? {} : {index}),
		...(expandParent ? {expandParent} : {}),
	}));
	const [only] = blocks;
	if (only === undefined) {
		return;
	}
	await new Promise<void>((resolve) => {
		mutate(blocks.length === 1 ? only : {moves: blocks}, {
			onSettled: () => {
				resolve();
			},
		});
	});
}
