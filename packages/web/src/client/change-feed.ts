import type {QueryClient, QueryKey} from "@tanstack/react-query";
import type {BacklinksResponse, FoundDatesResponse, NodeChangesResponse, NodeResponse} from "../node-types.js";
import {nodeKeys} from "./node-cache.js";
import {shareById} from "./structural-sharing.js";

/**
 * Patch the cache with what the server says changed after a write (see `GET /api/v1/nodes/changes`), instead of
 * refetching every node query. Each refreshed children list replaces the cached list of its parent and of the parent's
 * mirrors (a mirror lists its original's children) and resets the parent's children flags; each changed node's detail
 * takes its new row. Only queries that show a changed node and are not patched here are invalidated: ancestor chains
 * through it, Backlinks and Found Dates lists naming it, and the details of deleted nodes. A cache entry the change
 * leaves as it was is not written at all, so a one-row edit under a parent with thousands of children notifies only the
 * entries it alters instead of every cached row.
 */
export function applyNodeChanges(queryClient: QueryClient, changes: NodeChangesResponse): void {
	const changed = new Set([...changes.changedIds, ...changes.deletedIds]);
	const rows = new Map<string, NodeResponse>();
	for (const {parentId, nodes} of changes.children) {
		for (const node of nodes) {
			rows.set(node.id, node);
		}
		for (const listParent of [parentId, ...(parentId === null ? [] : cachedMirrorIds(queryClient, parentId))]) {
			const cachedList = queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(listParent));
			if (cachedList !== undefined && shareById(cachedList, nodes) !== cachedList) {
				queryClient.setQueryData<NodeResponse[]>(nodeKeys.children(listParent), nodes);
			}
		}
		if (parentId !== null) {
			setChildFlags(queryClient, parentId, nodes);
		}
	}
	for (const id of changes.changedIds) {
		const node = rows.get(id);
		const old = queryClient.getQueryData<NodeResponse>(nodeKeys.detail(id));
		if (node !== undefined && old !== undefined) {
			const next = {...old, ...node};
			if (shareById(old, next) !== old) {
				queryClient.setQueryData<NodeResponse>(nodeKeys.detail(id), next);
			}
		}
	}
	for (const id of changes.deletedIds) {
		void queryClient.invalidateQueries({queryKey: nodeKeys.detail(id), exact: true});
	}
	const cached = <T>(kind: string) => queryClient.getQueriesData<T>({queryKey: [...nodeKeys.all, kind]});
	invalidateWhere(queryClient, cached<NodeResponse[]>("ancestors"), (chain) =>
		chain.some((node) => changed.has(node.id)),
	);
	invalidateWhere(queryClient, cached<BacklinksResponse | null>("backlinks"), (response) =>
		(response?.items ?? []).some(
			(item) => changed.has(item.sourceId) || item.crumbs.some((crumb) => changed.has(crumb.id)),
		),
	);
	invalidateWhere(queryClient, cached<FoundDatesResponse>("found-dates"), (response) =>
		response.items.some((item) => changed.has(item.node.id) || item.crumbs.some((crumb) => changed.has(crumb.id))),
	);
}

/** The ids of every cached row that mirrors `originalId`. */
function cachedMirrorIds(queryClient: QueryClient, originalId: string): Set<string> {
	const ids = new Set<string>();
	for (const [, children] of queryClient.getQueriesData<NodeResponse[]>({queryKey: [...nodeKeys.all, "children"]})) {
		for (const child of children ?? []) {
			if (child.originalNodeId === originalId) {
				ids.add(child.id);
			}
		}
	}
	return ids;
}

/** Set `parentId`'s children flags from `children` on its rows and its mirrors' wherever they are cached. */
function setChildFlags(queryClient: QueryClient, parentId: string, children: readonly NodeResponse[]): void {
	const hasChildren = children.length > 0;
	const hasUncompletedChildren = children.some((child) => child.completedAt === null);
	const shows = (node: NodeResponse) => node.id === parentId || node.originalNodeId === parentId;
	const flag = (node: NodeResponse) =>
		shows(node) && (node.hasChildren !== hasChildren || node.hasUncompletedChildren !== hasUncompletedChildren)
			? {...node, hasChildren, hasUncompletedChildren}
			: node;
	for (const [key, list] of queryClient.getQueriesData<NodeResponse[]>({queryKey: [...nodeKeys.all, "children"]})) {
		if (list?.some((node) => flag(node) !== node) === true) {
			queryClient.setQueryData<NodeResponse[]>(key, list.map(flag));
		}
	}
	for (const [key, node] of queryClient.getQueriesData<NodeResponse>({queryKey: [...nodeKeys.all, "detail"]})) {
		if (node !== undefined && flag(node) !== node) {
			queryClient.setQueryData<NodeResponse>(key, flag(node));
		}
	}
}

/** Invalidate each of the cached `entries` whose data `shows` a change. */
function invalidateWhere<T>(
	queryClient: QueryClient,
	entries: [QueryKey, T | undefined][],
	shows: (data: T) => boolean,
): void {
	for (const [key, data] of entries) {
		if (data !== undefined && shows(data)) {
			void queryClient.invalidateQueries({queryKey: key, exact: true});
		}
	}
}

/** Reads `GET /api/v1/nodes/changes`; no `since` answers only the current high-water mark. */
export type FetchChanges = (since: string | undefined) => Promise<NodeChangesResponse>;

/**
 * Adjusts a refreshed children list before it reaches the cache (re-adding rows of creates still in flight), or
 * undefined to leave the parent's cached list alone (a move into or out of it is still in flight).
 */
export type PrepareList = (parentId: string | null, nodes: NodeResponse[]) => NodeResponse[] | undefined;

/**
 * The client's global high-water mark over the node tree: the watermark the server last returned, a system time
 * trailing its clock by the transaction timeout, sent back as `since` on the next poll. After a write, `sync` asks for everything changed since the mark and patches the cache with it, so a write costs one
 * small request instead of a refetch of every node query. Syncs run one at a time, and the mark only ever advances,
 * except that a reset (a mark the server never issued) takes the server's mark as is. Marks are temporal timestamps, so
 * they compare as strings.
 */
export class ChangeFeed {
	#mark: string | undefined;
	#seeding: Promise<void> | undefined;
	#queue: Promise<void> = Promise.resolve();
	readonly #fetchChanges: FetchChanges;
	readonly #prepare: PrepareList;

	constructor(fetchChanges: FetchChanges, prepare: PrepareList = (_parentId, nodes) => nodes) {
		this.#fetchChanges = fetchChanges;
		this.#prepare = prepare;
	}

	/** Take the server's current mark, once; call it when the outline first loads, before any write can follow. */
	async seed(): Promise<void> {
		this.#seeding ??= this.#seedNow();
		await this.#seeding;
	}

	async #seedNow(): Promise<void> {
		try {
			this.#advance((await this.#fetchChanges(undefined)).latest);
		} catch {
			// Unseeded, the next sync refetches everything and seeds again.
			this.#seeding = undefined;
		}
	}

	/**
	 * Patch the cache with every change since the mark; without a mark, or when too much changed, refetch everything.
	 * With `announced`, the watermark a live-sync frame carried at publish time, the sync is skipped when, once its turn
	 * comes, the mark is already past it: a read that late already saw that write, as with the echo of the tab's own
	 * write arriving after (or during) the write's settle sync.
	 */
	async sync(queryClient: QueryClient, announced?: string): Promise<void> {
		const run = this.#queue.then(async () => this.#syncNow(queryClient, announced));
		this.#queue = run.catch(() => {});
		await run;
	}

	async #syncNow(queryClient: QueryClient, announced: string | undefined): Promise<void> {
		const since = this.#mark;
		if (announced !== undefined && since !== undefined && since > announced) {
			return;
		}
		if (since === undefined) {
			await Promise.all([this.seed(), queryClient.invalidateQueries({queryKey: nodeKeys.all})]);
			return;
		}
		let changes: NodeChangesResponse;
		try {
			changes = await this.#fetchChanges(since);
		} catch {
			await queryClient.invalidateQueries({queryKey: nodeKeys.all});
			return;
		}
		if (changes.reset) {
			await queryClient.invalidateQueries({queryKey: nodeKeys.all});
			this.#mark = changes.latest;
			return;
		}
		applyNodeChanges(queryClient, {
			...changes,
			children: changes.children.flatMap(({parentId, nodes}) => {
				const prepared = this.#prepare(parentId, nodes);
				return prepared === undefined ? [] : [{parentId, nodes: prepared}];
			}),
		});
		this.#advance(changes.latest);
	}

	#advance(latest: string): void {
		if (this.#mark === undefined || latest > this.#mark) {
			this.#mark = latest;
		}
	}
}
