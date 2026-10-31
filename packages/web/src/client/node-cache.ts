import type {QueryClient} from "@tanstack/react-query";
import type {BacklinkCrumb, BacklinksResponse, FoundDatesResponse, NodeResponse, SaveEffects} from "../node-types.js";
import {parseVirtualShortId, virtualShortId} from "@workflowy/shared/workflowy";
import type {MirrorInstance} from "../mirror-path.js";
import {shortId} from "./location.js";
import {sortByPriority} from "./tree-position.js";

/**
 * The single source of truth for React Query cache keys under the `nodes`
 * namespace. Every reader/writer must go through this factory — a hand-rolled
 * key array that drifts from these shapes silently misses the cache (a
 * `getQueryData` on a mismatched key returns `undefined`, degrading to a refetch
 * with no type error).
 */
export const nodeKeys = {
	all: ["nodes"] as const,
	children: (parentId: string | null) => [...nodeKeys.all, "children", parentId] as const,
	detail: (nodeId: string) => [...nodeKeys.all, "detail", nodeId] as const,
	ancestors: (nodeId: string) => [...nodeKeys.all, "ancestors", nodeId] as const,
	backlinks: (nodeId: string) => [...nodeKeys.all, "backlinks", nodeId] as const,
	/** A day page's Found Dates; under `nodes` so any tree write refreshes it. */
	foundDates: (dayId: string) => [...nodeKeys.all, "found-dates", dayId] as const,
	/** Home's own metadata (`GET /api/v1/home`): its layoutMode. */
	home: () => [...nodeKeys.all, "home"] as const,
	/** A location id (short or full) resolved to the full uuid, or null when the server has no such node. */
	resolvedId: (locationId: string) => [...nodeKeys.all, "resolved-id", locationId] as const,
};

/** A resolved id stays fresh forever, except a `null` (not found): that is re-resolved on the next use, as upstream re-resolves every navigation. */
export const RESOLVED_ID_STALE_TIME = (query: {state: {data: string | null | undefined}}): number =>
	query.state.data === null ? 0 : Number.POSITIVE_INFINITY;

/** Record that `nodeId`'s short URL id resolves to it, so navigating to its URL needs no `GET /nodes/:id` lookup. */
export function seedResolvedId(queryClient: QueryClient, nodeId: string): void {
	queryClient.setQueryData(nodeKeys.resolvedId(shortId(nodeId)), nodeId);
}

/** Every node the cache holds as a detail entry, a children row or an ancestor-chain link (duplicates included). */
function* cachedNodes(queryClient: QueryClient): Generator<NodeResponse> {
	for (const [, detail] of queryClient.getQueriesData<NodeResponse>({queryKey: [...nodeKeys.all, "detail"]})) {
		if (detail !== undefined) {
			yield detail;
		}
	}
	for (const kind of ["children", "ancestors"]) {
		for (const [, rows] of queryClient.getQueriesData<NodeResponse[]>({queryKey: [...nodeKeys.all, kind]})) {
			yield* rows ?? [];
		}
	}
}

/**
 * The full id a location id (short or full) names, read from whatever the cache already holds; undefined when no
 * cached node has it. Back, Forward and every link to a node the outline has shown resolve without a lookup request.
 */
export function cachedResolvedId(queryClient: QueryClient, locationId: string): string | undefined {
	const seeded = queryClient.getQueryData<string | null>(nodeKeys.resolvedId(locationId));
	if (typeof seeded === "string") {
		return seeded;
	}
	// A row inside a mirror (`v_<child12>_<mirror12>[_<path>]`) names the original child it shows.
	const wanted = parseVirtualShortId(locationId)?.nodeShortId ?? locationId;
	for (const node of cachedNodes(queryClient)) {
		if (node.id === wanted || shortId(node.id) === wanted) {
			return node.id;
		}
	}
	return undefined;
}

/** A node as `GET /nodes/:id/ancestors` lists it: always a parent, never a mirror. */
function asAncestor(node: NodeResponse): NodeResponse {
	return {...node, hasChildren: true, hasUncompletedChildren: true, isMirror: false, originalNodeId: null};
}

/**
 * `nodeId`'s ancestor chain (root first, the node last) built from the cache: cut from any cached chain that passes
 * through it, else its parent's chain plus its own cached row. Undefined when neither is cached, so the breadcrumbs
 * and title of a zoom target the outline has shown render with the swap instead of after a request.
 */
export function cachedAncestors(queryClient: QueryClient, nodeId: string): NodeResponse[] | undefined {
	for (const [key, chain] of queryClient.getQueriesData<NodeResponse[]>({queryKey: [...nodeKeys.all, "ancestors"]})) {
		// A chain cached for a row inside a mirror runs through the mirror, not the row's own parents.
		if (typeof key[2] === "string" && parseVirtualShortId(key[2]) !== null) {
			continue;
		}
		const index = chain?.findIndex((node) => node.id === nodeId) ?? -1;
		if (chain !== undefined && index !== -1) {
			return chain.slice(0, index + 1);
		}
	}
	const node = readNode(queryClient, nodeId);
	if (node === undefined) {
		return undefined;
	}
	const parentChain = node.parent_id === null ? [] : cachedAncestors(queryClient, node.parent_id);
	return parentChain === undefined ? undefined : [...parentChain, asAncestor(node)];
}

/** The key an instance's ancestors are cached under: its virtual location id, which the ancestors route also accepts. */
export function instanceAncestorsKey(nodeId: string, instance: MirrorInstance): string {
	return virtualShortId({childId: nodeId, mirrorRootId: instance.rootId, path: instance.path});
}

/**
 * The breadcrumb chain of a row met inside a mirror: the mirror's ancestors and the mirror, then the rows below its
 * original down to `nodeId`. Undefined when the mirror, its original or the row's chain is not cached. A row outside the
 * mirror's original has no such chain, so its plain chain stands.
 */
export function cachedInstanceAncestors(
	queryClient: QueryClient,
	nodeId: string,
	instance: MirrorInstance,
): NodeResponse[] | undefined {
	const mirror = readNode(queryClient, instance.rootId);
	const mirrorChain = cachedAncestors(queryClient, instance.rootId);
	const rowChain = cachedAncestors(queryClient, nodeId);
	if (mirror?.originalNodeId == null || mirrorChain === undefined || rowChain === undefined) {
		return undefined;
	}
	const originalIndex = rowChain.findIndex((node) => node.id === mirror.originalNodeId);
	return originalIndex === -1 ? rowChain : [...mirrorChain, ...rowChain.slice(originalIndex + 1)];
}

/** Read a parent's cached children, or undefined if not cached. */
export function readChildren(queryClient: QueryClient, parentId: string | null): NodeResponse[] | undefined {
	return queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId));
}

/** Read a single node's cached detail, or undefined if not cached. */
export function readDetail(queryClient: QueryClient, nodeId: string): NodeResponse | undefined {
	return queryClient.getQueryData<NodeResponse>(nodeKeys.detail(nodeId));
}

const FOUND_DATES_KEY = [...nodeKeys.all, "found-dates"] as const;

/**
 * A node from its detail cache, else from whichever cached children list holds it, else from a
 * cached Found Dates list. Rows render from children lists, so most visible nodes have no detail
 * entry; a Found Dates row is a mirror of itself, read here as the original it shows.
 */
export function readNode(queryClient: QueryClient, nodeId: string): NodeResponse | undefined {
	const detail = readDetail(queryClient, nodeId);
	if (detail) {
		return detail;
	}
	for (const [, children] of queryClient.getQueriesData<NodeResponse[]>({queryKey: [...nodeKeys.all, "children"]})) {
		const found = children?.find((child) => child.id === nodeId);
		if (found) {
			return found;
		}
	}
	for (const [, response] of queryClient.getQueriesData<FoundDatesResponse>({queryKey: FOUND_DATES_KEY})) {
		const item = response?.items.find(({node}) => node.id === nodeId);
		if (item) {
			return {...item.node, isMirror: false, originalNodeId: null};
		}
	}
	return undefined;
}

/** Drop the rows `ids` from every cached Found Dates list, as when they move onto a day. */
export function removeFoundDates(queryClient: QueryClient, ids: readonly string[]): void {
	const removed = new Set(ids);
	queryClient.setQueriesData<FoundDatesResponse>({queryKey: FOUND_DATES_KEY}, (response) =>
		response === undefined ? response : {items: response.items.filter(({node}) => !removed.has(node.id))},
	);
}

/**
 * A command's item node: the fetched edited node when it is the item, else the cached row. Right after a
 * click or Enter the edited node's fetch has not returned (a new row's waits for its create), and the
 * cached row keeps hotkeys pressed then from being dropped.
 */
export function readItemNode(
	queryClient: QueryClient,
	itemId: string | undefined,
	editedNode: NodeResponse | undefined,
): NodeResponse | undefined {
	if (itemId === undefined) {
		return undefined;
	}
	return editedNode?.id === itemId ? editedNode : readNode(queryClient, itemId);
}

/** `children` without the optimistic row `id`, so one failed create never touches another's pending row. */
export function removeOptimistic(children: NodeResponse[] | undefined, id: string): NodeResponse[] | undefined {
	return children?.filter((child) => child.id !== id);
}

/**
 * Upstream move/insert splice: sort `children` by priority, drop any copy of `row`,
 * insert it at `index` (a move slot, see `spliceBlock`), giving it a priority between its neighbours'.
 */
export function spliceChildren(children: NodeResponse[], row: NodeResponse, index: number): NodeResponse[] {
	return spliceBlock(children, [row], index);
}

/**
 * Priorities for `count` rows between the neighbours' `before` and `after` (either missing at an end): 100 apart
 * past the last row or in an empty list, as the server numbers a fresh list, else spread evenly over the gap. Null
 * when the gap has no room, or the neighbours are out of order.
 */
function blockPriorities(before: number | undefined, after: number | undefined, count: number): number[] | null {
	if (after === undefined) {
		const base = before ?? 0;
		return Array.from({length: count}, (_, i) => base + (i + 1) * 100);
	}
	const low = before ?? -1;
	const step = Math.floor((after - low) / (count + 1));
	return step >= 1 ? Array.from({length: count}, (_, i) => low + (i + 1) * step) : null;
}

/**
 * Upstream `bulk_move` splice: remove every row in `rows` from `children`, then insert
 * them contiguously in the given order. `index` is the move endpoint's slot: counted
 * among ALL of `children` in priority order, moved rows included (before removal),
 * so `index` lands the block right before the row that sat at `index`; clamped to the end.
 * The block takes priorities in the gap between its neighbours (`blockPriorities`), so no other row changes; with
 * no room the whole list is renumbered from 0.
 */
export function spliceBlock<T extends Pick<NodeResponse, "id" | "priority">>(
	children: T[],
	rows: T[],
	index: number,
): T[] {
	const moving = new Set(rows.map((row) => row.id));
	const sorted = sortByPriority(children);
	const others = sorted.filter((child) => !moving.has(child.id));
	const at = sorted.slice(0, Math.max(0, index)).filter((child) => !moving.has(child.id)).length;
	const before = others[at - 1]?.priority;
	const after = others[at]?.priority;
	const gap = blockPriorities(before, after, rows.length);
	if (gap !== null) {
		// The block fits between its neighbours: every other row keeps its priority, and so its object.
		const block = rows.map((row, i) => (row.priority === gap[i] ? row : {...row, priority: gap[i] ?? 0}));
		return [...others.slice(0, at), ...block, ...others.slice(at)];
	}
	// No room: slots from 0, as the server renumbers a crowded list; a row already in its slot keeps its object.
	return [...others.slice(0, at), ...rows, ...others.slice(at)].map((child, i) =>
		child.priority === i ? child : {...child, priority: i},
	);
}

/** The cache entries that hold `nodeId`: its detail entry and every cached children list containing its row. */
function cachedNodeEntries(
	queryClient: QueryClient,
	nodeId: string,
): [readonly unknown[], NodeResponse | NodeResponse[]][] {
	const entries: [readonly unknown[], NodeResponse | NodeResponse[]][] = [];
	const detail = readDetail(queryClient, nodeId);
	if (detail) {
		entries.push([nodeKeys.detail(nodeId), detail]);
	}
	for (const [key, children] of queryClient.getQueriesData<NodeResponse[]>({
		queryKey: [...nodeKeys.all, "children"],
	})) {
		if (children?.some((child) => child.id === nodeId)) {
			entries.push([key, children]);
		}
	}
	return entries;
}

/** The parent ids of every cached row of `originalId` and of its mirrors, each once. */
export function cachedCopyParentIds(queryClient: QueryClient, originalId: string): (string | null)[] {
	const parents = new Set<string | null>();
	for (const [, children] of queryClient.getQueriesData<NodeResponse[]>({
		queryKey: [...nodeKeys.all, "children"],
	})) {
		for (const child of children ?? []) {
			if (child.id === originalId || child.originalNodeId === originalId) {
				parents.add(child.parent_id);
			}
		}
	}
	return [...parents];
}

/**
 * `ids` plus the other rendered copies of the same items: each mirror's original and every cached mirror of an
 * original, each once. A completion changes all of them together, so their deferred hide is scheduled together.
 */
export function renderedCopyIds(queryClient: QueryClient, ids: readonly string[]): string[] {
	const originals = new Set(ids.map((id) => readNode(queryClient, id)?.originalNodeId ?? id));
	const copies = new Set(ids);
	for (const original of originals) {
		copies.add(original);
	}
	for (const [, children] of queryClient.getQueriesData<NodeResponse[]>({
		queryKey: [...nodeKeys.all, "children"],
	})) {
		for (const child of children ?? []) {
			if (
				child.originalNodeId !== undefined &&
				child.originalNodeId !== null &&
				originals.has(child.originalNodeId)
			) {
				copies.add(child.id);
			}
		}
	}
	return [...copies];
}

function restoring(queryClient: QueryClient, entries: [readonly unknown[], unknown][]): () => void {
	return () => {
		for (const [key, value] of entries) {
			queryClient.setQueryData(key, value);
		}
	};
}

/** Snapshot every cache entry that holds `nodeId` without changing it; returns a function that restores them. */
export function snapshotCachedNode(queryClient: QueryClient, nodeId: string): () => void {
	return restoring(queryClient, cachedNodeEntries(queryClient, nodeId));
}

/**
 * Optimistically apply `patch` to `nodeId` everywhere the outline reads it: its detail
 * entry and its row in every cached children list (rows render from the list, so a
 * detail-only patch leaves the row showing stale text until the refetch). Returns a
 * function that restores every touched entry.
 */
export function patchCachedNode(
	queryClient: QueryClient,
	nodeId: string,
	apply: (node: NodeResponse) => NodeResponse,
): () => void {
	const entries = cachedNodeEntries(queryClient, nodeId);
	for (const [key, value] of entries) {
		queryClient.setQueryData(
			key,
			Array.isArray(value) ? value.map((child) => (child.id === nodeId ? apply(child) : child)) : apply(value),
		);
	}
	return restoring(queryClient, entries);
}

/**
 * Apply `apply` to every cached row and detail entry that mirrors `originalId`: a mirror shows its original's text
 * and children, so their optimistic writes must reach it too. Returns a function that restores every touched entry.
 */
export function patchMirrors(
	queryClient: QueryClient,
	originalId: string,
	apply: (node: NodeResponse) => NodeResponse,
): () => void {
	const isMirror = (node: NodeResponse) => node.originalNodeId === originalId;
	const entries: [readonly unknown[], NodeResponse | NodeResponse[]][] = [];
	for (const [key, detail] of queryClient.getQueriesData<NodeResponse>({queryKey: [...nodeKeys.all, "detail"]})) {
		if (detail !== undefined && isMirror(detail)) {
			entries.push([key, detail]);
		}
	}
	for (const [key, children] of queryClient.getQueriesData<NodeResponse[]>({
		queryKey: [...nodeKeys.all, "children"],
	})) {
		if (children?.some(isMirror) === true) {
			entries.push([key, children]);
		}
	}
	for (const [key, value] of entries) {
		queryClient.setQueryData(
			key,
			Array.isArray(value) ? value.map((child) => (isMirror(child) ? apply(child) : child)) : apply(value),
		);
	}
	return restoring(queryClient, entries);
}

/**
 * Set `parentId`'s children flags, on its own rows and its mirrors' wherever they are cached, from its cached
 * children list, so a parent that gained its first child or lost its last uncompleted one renders as the server will
 * answer it. Returns a function that restores the touched entries (a no-op when the list is not cached).
 */
export function syncParentFlags(queryClient: QueryClient, parentId: string | null): () => void {
	const children = parentId === null ? undefined : readChildren(queryClient, parentId);
	if (parentId === null || children === undefined) {
		return () => {};
	}
	const hasChildren = children.length > 0;
	const hasUncompletedChildren = children.some((child) => child.completedAt === null);
	const flag = (node: NodeResponse) =>
		node.hasChildren === hasChildren && node.hasUncompletedChildren === hasUncompletedChildren
			? node
			: {...node, hasChildren, hasUncompletedChildren};
	const restoreRows = patchCachedNode(queryClient, parentId, flag);
	const restoreMirrors = patchMirrors(queryClient, parentId, flag);
	return () => {
		restoreMirrors();
		restoreRows();
	};
}

/** `node` with the fields a text save writes taken from `saved`; its children flags and mirror links stay. */
function withSavedText(node: NodeResponse, saved: NodeResponse): NodeResponse {
	return {
		...node,
		name: saved.name,
		note: saved.note,
		data: {...node.data, layoutMode: saved.data.layoutMode},
		modifiedAt: saved.modifiedAt,
		...(saved.numberedStart === undefined ? {} : {numberedStart: saved.numberedStart}),
	};
}

/** `crumbs` with the name of each crumb in `ids` set to `name`. */
function renameCrumbs(crumbs: BacklinkCrumb[], ids: ReadonlySet<string>, name: string | null): BacklinkCrumb[] {
	return crumbs.some((crumb) => ids.has(crumb.id))
		? crumbs.map((crumb) => (ids.has(crumb.id) ? {...crumb, name: name ?? ""} : crumb))
		: crumbs;
}

/**
 * Write a saved node's text, as the server answered it, into every cached copy: its detail entry, its row in each
 * children list, its link in each ancestor chain, its original's rows and mirrors when it is a mirror, and its rows
 * and crumbs in each Backlinks and Found Dates list. Nothing that only shows the node needs a refetch after a save.
 */
export function applySavedText(queryClient: QueryClient, saved: NodeResponse): void {
	const text = (node: NodeResponse) => ({...node, name: saved.name, note: saved.note});
	patchCachedNode(queryClient, saved.id, (node) => withSavedText(node, saved));
	patchMirrors(queryClient, saved.id, text);
	// A mirror's text is its original's, so the original and its other mirrors show the saved text too.
	const source = saved.originalNodeId ?? saved.id;
	if (source !== saved.id) {
		patchCachedNode(queryClient, source, text);
		patchMirrors(queryClient, source, (node) => (node.id === saved.id ? node : text(node)));
	}
	queryClient.setQueriesData<NodeResponse[]>({queryKey: [...nodeKeys.all, "ancestors"]}, (chain) =>
		chain?.some((node) => node.id === saved.id)
			? chain.map((node) => (node.id === saved.id ? withSavedText(node, saved) : node))
			: chain,
	);
	const ids = new Set([saved.id, source]);
	queryClient.setQueriesData<BacklinksResponse | null>({queryKey: [...nodeKeys.all, "backlinks"]}, (response) =>
		response?.items === undefined
			? response
			: {
					...response,
					items: response.items.map((item) => ({
						...item,
						node: ids.has(item.sourceId) ? text(item.node) : item.node,
						crumbs: renameCrumbs(item.crumbs, ids, saved.name),
					})),
				},
	);
	queryClient.setQueriesData<FoundDatesResponse>({queryKey: FOUND_DATES_KEY}, (response) =>
		response === undefined
			? response
			: {
					items: response.items.map((item) => ({
						node: ids.has(item.node.id) ? text(item.node) : item.node,
						crumbs: renameCrumbs(item.crumbs, ids, saved.name),
					})),
				},
	);
}

/**
 * Refetch only what the server says a save changed beyond the node's own copies: the Backlinks of each node a link
 * was added to or removed from, and every Found Dates list when the node's dates moved. Plain typing refetches nothing.
 */
export async function invalidateSaveEffects(queryClient: QueryClient, effects: SaveEffects): Promise<void> {
	await Promise.all([
		...effects.backlinkTargets.map(async (id) =>
			queryClient.invalidateQueries({queryKey: nodeKeys.backlinks(id), exact: true}),
		),
		...(effects.dates ? [queryClient.invalidateQueries({queryKey: FOUND_DATES_KEY})] : []),
	]);
}
