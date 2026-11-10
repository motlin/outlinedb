import {z} from "zod";
import {NodeReader, NodeTreeReader, ancestorChain, effectiveCompletedAt} from "@outlinedb/shared/cache";
import {mirrors as mirrorsTable, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {Node} from "@outlinedb/shared/types";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {isShortId, parseVirtualShortId} from "@outlinedb/shared/workflowy";
import {and, eq, sql} from "drizzle-orm";
import type {
	BacklinkItem,
	BacklinksResponse,
	CalendarInfo,
	FoundDatesResponse,
	NodeChangesResponse,
	NodeResponse,
	OutlineViewList,
	OutlineViewResponse,
} from "../../node-types.js";
import {childFlags, findReferencesRoot, notReferencesRoot, referencesRootLabel} from "../backlinks.js";
import {loadCalendarInfo} from "../calendar-day.js";
import {findFoundDates} from "../calendar-found.js";
import type {ServerContext} from "../context.js";
import type {MirrorInstance} from "../../mirror-path.js";
import {childInstance, expansionId} from "../../mirror-path.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api.js";
import {changeWatermark, changesAfter, liveParents, readConsistently} from "../system-changes.js";
import {readBacklinkItems, readViewTree, viewListParents} from "../view-tree.js";
import type {ViewExpansion} from "../view-tree.js";
import {defineOp, fail, ok, toJson} from "./define.js";
import {
	AncestorsResponseSchema,
	BacklinksResponseSchema,
	ExportTreeResponseSchema,
	FoundDatesResponseSchema,
	HomeResponseSchema,
	MirrorsResponseSchema,
	NodeChangesResponseSchema,
	NodeChildrenResponseSchema,
	NodeEnvelopeSchema,
	NodeListSchema,
	NodeVerifyResponseSchema,
	OutlineViewResponseSchema,
	SubtreeItemsResponseSchema,
} from "./schemas.js";
import {
	getAdapter,
	getWriteClient,
	loadInternalMetadataFields,
	nodeToRestDto,
	readChildDtoLists,
	readChildDtos,
	readNodeDto,
	resolveMirrorToOriginal,
	resolveMirrorsToOriginals,
	resolveNodeId,
} from "./nodes-shared.js";

const IdInput = z.object({id: z.string()});

// GET /api/v1/nodes - List children (or root nodes if no parent_id; accepts short IDs)
export const nodesList = defineOp({
	input: z.object({parentId: z.string().optional()}),
	output: NodeListSchema,
	run(ctx, {parentId: parentIdParam}) {
		// Workflowy API accepts "None" for top-level nodes, or omitting the param
		let parentId = parentIdParam === "None" || parentIdParam === "" ? null : (parentIdParam ?? null);

		// Resolve short ID to full UUID if needed
		if (parentId) {
			const resolved = resolveNodeId(ctx, parentId);
			if (!resolved) {
				return fail(404, {error: "Parent node not found"});
			}
			// If the node is a mirror, fetch the original's children
			parentId = resolveMirrorToOriginal(ctx, resolved);
		}

		return ok(toJson({nodes: readChildDtos(ctx, parentId)}));
	},
});

// POST /api/v1/nodes/children - The children of many parents in one round trip, keyed by the requested id. A
// mirror lists its original's children; an unresolvable short id is left out. Spares the client one GET per expanded row.
export const nodesChildren = defineOp({
	input: z.object({parentIds: z.array(z.string())}),
	output: NodeChildrenResponseSchema,
	run(ctx, {parentIds}) {
		return ok(toJson({children: Object.fromEntries(readRequestedChildren(ctx, parentIds))}));
	},
});

/**
 * The children of each requested parent (a short id resolved, a mirror listing its original's children), keyed by the
 * requested id; an unresolvable short id is left out.
 */
function readRequestedChildren(ctx: ServerContext, parentIds: readonly string[]): Map<string, NodeResponse[]> {
	const requestedToResolved = new Map<string, string>();
	for (const requested of new Set(parentIds)) {
		const resolved = resolveNodeId(ctx, requested);
		if (resolved !== null) {
			requestedToResolved.set(requested, resolved);
		}
	}
	const originals = resolveMirrorsToOriginals(ctx, [...requestedToResolved.values()]);
	const requestedToParent = new Map(
		[...requestedToResolved].map(([requested, resolved]) => [requested, originals.get(resolved) ?? resolved]),
	);
	const lists = readChildDtoLists(ctx, [...requestedToParent.values()]);
	return new Map([...requestedToParent].map(([requested, parent]) => [requested, lists.get(parent) ?? []]));
}

// POST /api/v1/nodes/verify - The client's dev-only cache check reads the server's side of every cached entry a write
// touched in this one round trip instead of one GET per node and one children POST per list. Nodes are read from the
// cache only (no live read of a missing uuid); a parent the cache lacks has no list, as its leftover list renders
// nowhere.
export const nodesVerify = defineOp({
	input: z.object({ids: z.array(z.string()), parentIds: z.array(z.string().nullable())}),
	output: NodeVerifyResponseSchema,
	async run(ctx, {ids, parentIds}) {
		const details = new Map<string, NodeResponse>();
		for (const id of new Set([...ids, ...parentIds.filter((parentId) => parentId !== null)])) {
			const resolved = resolveNodeId(ctx, id);
			const node = resolved === null ? undefined : await readNodeDto(ctx, resolved);
			if (node !== undefined) {
				details.set(id, node);
			}
		}
		const live = [...new Set(parentIds)].filter((parentId) => parentId === null || details.has(parentId));
		const lists = readRequestedChildren(
			ctx,
			live.filter((parentId) => parentId !== null),
		);
		return ok(
			toJson({
				nodes: Object.fromEntries([...details].filter(([id]) => ids.includes(id))),
				children: live.map((parentId) => ({
					parentId,
					nodes: parentId === null ? readChildDtos(ctx, null) : (lists.get(parentId) ?? []),
				})),
			}),
		);
	},
});

/** The most changed nodes a changes read lists; past it the client refetches everything. */
const CHANGES_LIMIT = 500;

/**
 * What changed after the watermark `since` (none: only the watermark): the changed ids, which of them are gone, and
 * the refreshed children of every parent they sit under now or left. The watermark trails the clock by the
 * transaction timeout, so a late-committing unit stamped before an earlier poll still reaches the client (see
 * `changeWatermark`). One consistent read, and every concern is read once
 * for the whole id set, so the statement count does not grow with how much changed.
 */
function readNodeChanges(ctx: ServerContext, since: string | undefined): NodeChangesResponse {
	return readConsistently(ctx.db, () => {
		const latest = changeWatermark();
		const none = {latest, reset: false, changedIds: [], deletedIds: [], children: []};
		if (since === undefined) {
			return none;
		}
		const changed = changesAfter(ctx.db, since, CHANGES_LIMIT);
		if (changed === undefined) {
			return {...none, reset: true};
		}
		const changedIds = [...changed.ids];
		const parents = liveParents(ctx.db, changedIds);
		const deletedIds = changedIds.filter((id) => !parents.has(id));
		const gone = new Set(deletedIds);
		const parentIds = [...new Set([...parents.values(), ...changed.formerParents])].filter(
			(id) => id === null || !gone.has(id),
		);
		const lists = readChildDtoLists(ctx, parentIds);
		return {
			latest,
			reset: false,
			changedIds,
			deletedIds,
			children: parentIds.map((parentId) => ({parentId, nodes: lists.get(parentId) ?? []})),
		};
	});
}

// GET /api/v1/nodes/changes?since=<mark> - What changed in the tree after a high-water mark (see `readNodeChanges`).
// The client asks this after each write instead of refetching every node query; with no `since` it answers the mark.
export const nodesChanges = defineOp({
	input: z.object({since: z.string().optional()}),
	output: NodeChangesResponseSchema,
	run(ctx, {since}) {
		return ok(toJson(readNodeChanges(ctx, since === "" ? undefined : since)));
	},
});

// POST /api/v1/nodes/view - Everything an outline view under `rootId` first renders, in one round trip: the root's
// children and, depth-first in document order, those of every expanded row the row budget reaches, each with its
// Backlinks section (Home has none). Spares the client one children request per depth level and one backlinks GET
// per expanded row, so a zoom swaps in the whole expanded view at once; a day page's view carries its Found Dates too.
// `expandedIds: null` expands the account's expanded rows (none without the internal API) and answers which of the
// listed rows those are, so the page load's first view need not wait on the client fetching the account's whole
// expanded set.
const ViewSchema = z.object({
	rootId: z.string().nullable(),
	expandedIds: z.array(z.string()).nullable(),
	limit: z.number().int().nonnegative(),
	showCompleted: z.boolean(),
});

export const nodesView = defineOp({
	input: ViewSchema,
	output: OutlineViewResponseSchema,
	async run(ctx, body) {
		const {rootId, limit, showCompleted} = body;
		const resolvedRoot = rootId === null ? null : resolveNodeId(ctx, rootId);
		if (rootId !== null && resolvedRoot === null) {
			return fail(404, {error: "Node not found"});
		}
		const {expansion, isExpanded} = viewExpansion(ctx, body.expandedIds);
		// Every list the view sends, chosen and read by one statement; visit only assembles them, agreeing with the
		// statement's walk about order, budget and expansion.
		const query = {rootId: resolvedRoot, expansion, limit, showCompleted};
		const tree = readViewTree(ctx, query);
		// Each list sent, with the node whose children it holds (a mirror's original; null for Home).
		const lists: {list: OutlineViewList; original: string | null}[] = [];
		let used = 0;
		// A parent's list is sent once however often it repeats.
		const listed = new Set<string | null>();
		const visit = (parentId: string | null, original: string | null, instance: MirrorInstance | null): void => {
			const nodes = tree.childrenOf(original);
			if (!listed.has(parentId)) {
				listed.add(parentId);
				lists.push({list: {parentId, nodes, backlinks: null}, original});
			}
			for (const node of nodes) {
				if (used >= limit) {
					return;
				}
				if (!showCompleted && node.completedAt !== null) {
					continue;
				}
				used += 1;
				if (isExpanded(expansionId(node.id, instance))) {
					visit(node.id, node.originalNodeId ?? node.id, childInstance(node, instance));
				}
			}
		};
		visit(rootId, tree.rootListParent, null);
		// Each listed node's Backlinks section (Home has none; a node with no references root has an empty one), all
		// read by one statement nesting the tree's list parents, and only when some listed node has a references root.
		const itemsByRoot =
			tree.referencesRootOf.size === 0
				? new Map<string, BacklinkItem[]>()
				: readBacklinkItems(ctx, viewListParents(query));
		for (const {list, original} of lists) {
			const root = original === null ? undefined : tree.referencesRootOf.get(original);
			list.backlinks =
				original === null
					? null
					: root === undefined
						? {rootId: null, items: []}
						: {rootId: root, items: itemsByRoot.get(root) ?? []};
		}
		const foundDates =
			tree.root === undefined ? null : await readFoundDates(ctx, tree.root, tree.rootCalendar ?? null);
		const response: OutlineViewResponse = {
			lists: lists.map(({list}) => list),
			...(body.expandedIds === null
				? {expandedIds: lists.flatMap(({list}) => list.nodes.map((node) => node.id).filter(isExpanded))}
				: {}),
			...(foundDates === null ? {} : {foundDates}),
		};
		return ok(toJson(response));
	},
});

/**
 * The view's expansion: the requested ids, or for null the account's stored expansion (nothing without the internal
 * API), as the walk's SQL source and the same test in JS.
 */
function viewExpansion(
	ctx: ServerContext,
	expandedIds: string[] | null,
): {expansion: ViewExpansion; isExpanded: (id: string) => boolean} {
	if (expandedIds !== null) {
		const ids = new Set(expandedIds);
		return {expansion: {kind: "ids", ids: [...ids]}, isExpanded: (id) => ids.has(id)};
	}
	const adapter = ctx.internalAdapter?.();
	return adapter === undefined
		? {expansion: {kind: "none"}, isExpanded: () => false}
		: {expansion: {kind: "stored"}, isExpanded: adapter.expansionTest()};
}

/** Fetch a node missing from the cache through the write-through client, cache it with its ancestors, and read it. */
async function readUncachedNodeLive(ctx: ServerContext, id: string): Promise<NodeResponse | undefined> {
	const client = getWriteClient(ctx);
	if (client === undefined) {
		return undefined;
	}
	try {
		await client.cacheLiveNode(id);
	} catch {
		return undefined;
	}
	return readNodeDto(ctx, id);
}

// GET /api/v1/nodes/:id - Get single node (accepts UUID or short ID)
export const nodesGet = defineOp({
	input: IdInput,
	output: NodeEnvelopeSchema,
	async run(ctx, {id: rawId}) {
		const id = resolveNodeId(ctx, rawId);
		if (!id) {
			return fail(404, {error: "Node not found"});
		}

		let nodeResponse = await readNodeDto(ctx, id);
		// A full uuid the cache lacks (a pasted link, a backlink to a node made elsewhere) is read live and cached with
		// its parent chain. The API cannot resolve short ids, so those stay cache-only; a real 404 stays a 404.
		if (nodeResponse === undefined && id === rawId && !isShortId(rawId)) {
			nodeResponse = await readUncachedNodeLive(ctx, id);
		}
		if (nodeResponse === undefined) {
			return fail(404, {error: "Node not found"});
		}

		// Wrap in { node: ... } to match Workflowy API format
		return ok(toJson({node: nodeResponse}));
	},
});

/** One node of `POST /export-tree`: the raw stored text and the fields the export formatters read. */
interface ExportTreeItem {
	id: string;
	name: string;
	note: string;
	layoutMode: string | null;
	numberedStart: number | null;
	completed: boolean;
	children: ExportTreeItem[];
}

/**
 * `ids` and everything below them as export items. A mirror takes its original's text and children, and a mirror
 * inside its own original's subtree stops there. Completed descendants are dropped unless `includeCompleted`;
 * the roots always stay.
 */
async function readExportTree(ctx: ServerContext, ids: string[], includeCompleted: boolean): Promise<ExportTreeItem[]> {
	const reader = new NodeTreeReader(ctx.cacheService);
	const toItems = async (nodes: Node[], path: ReadonlySet<string>): Promise<ExportTreeItem[]> => {
		const metadata = loadInternalMetadataFields(
			ctx,
			nodes.map((node) => node.id),
		);
		const items: ExportTreeItem[] = [];
		for (const node of nodes) {
			const fetchId = node.mirror.originalNodeId ?? node.id;
			const below = new Set([...path, fetchId]);
			const children = path.has(fetchId)
				? []
				: (await reader.readChildren(fetchId, {depth: 0})).filter(
						(child) =>
							!child.hasReferencesRoot &&
							!child.inChat &&
							(includeCompleted || child.completedAt === null),
					);
			items.push({
				id: node.id,
				name: node.name ?? "",
				note: node.note ?? "",
				layoutMode: node.layoutMode,
				numberedStart: metadata.get(node.id)?.numberedStart ?? null,
				completed: node.completedAt !== null,
				children: await toItems(children, below),
			});
		}
		return items;
	};
	return toItems(await reader.readNodes(ids, {depth: 0}), new Set());
}

// POST /api/v1/nodes/export-tree - The subtrees the export dialog formats, in one round trip
export const nodesExportTree = defineOp({
	input: z.object({ids: z.array(z.string()), includeCompleted: z.boolean().optional()}),
	output: ExportTreeResponseSchema,
	async run(ctx, {ids, includeCompleted}) {
		const resolved = ids.flatMap((id) => resolveNodeId(ctx, id) ?? []);
		return ok(toJson({items: await readExportTree(ctx, resolved, includeCompleted ?? false)}));
	},
});

/** One descendant row of `GET /:id/subtree-ids`; `parentId` is the row it renders under (a mirror, not its original). */
interface SubtreeItem {
	id: string;
	parentId: string | null;
	completed: boolean;
	hasChildren: boolean;
}

/** Every current node's parent and completion in sibling order, plus each mirror's original, in two queries. */
function readTreeShape(ctx: ServerContext) {
	const rows = ctx.db
		.select({
			id: nodeContent.id,
			parentId: nodeContent.parentId,
			completedAt: effectiveCompletedAt(nodeContent.id, nodeMetadata.completedAt),
		})
		.from(nodeContent)
		.leftJoin(
			nodeMetadata,
			and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
		)
		.where(and(eq(nodeContent.systemTo, FAR_FUTURE_DATE), notReferencesRoot()))
		.orderBy(nodeMetadata.priority, nodeMetadata.createdAt)
		.all();
	const children = new Map<string | null, {id: string; completed: boolean}[]>();
	for (const row of rows) {
		const siblings = children.get(row.parentId) ?? [];
		siblings.push({id: row.id, completed: row.completedAt !== null});
		children.set(row.parentId, siblings);
	}
	const originals = new Map(
		ctx.db
			.select({mirrorId: mirrorsTable.mirrorId, originalId: mirrorsTable.originalId})
			.from(mirrorsTable)
			.where(eq(mirrorsTable.systemTo, FAR_FUTURE_DATE))
			.all()
			.map((row) => [row.mirrorId, row.originalId]),
	);
	return {children, originals};
}

/** Every cached descendant of `rootId` (Home's tree for null) in depth-first outline order. */
function readSubtreeItems(ctx: ServerContext, rootId: string | null): SubtreeItem[] {
	const {children, originals} = readTreeShape(ctx);
	const items: SubtreeItem[] = [];
	// `path` holds the originals on the way down, so a mirror inside its own original's subtree stops there.
	const walk = (parentId: string | null, childrenOf: string | null, path: ReadonlySet<string>) => {
		for (const child of children.get(childrenOf) ?? []) {
			const original = originals.get(child.id) ?? child.id;
			const hasChildren = children.has(original);
			items.push({id: child.id, parentId, completed: child.completed, hasChildren});
			if (hasChildren && !path.has(original)) {
				walk(child.id, original, new Set([...path, original]));
			}
		}
	};
	const rootOriginal = rootId === null ? null : (originals.get(rootId) ?? rootId);
	walk(rootId, rootOriginal, new Set(rootOriginal === null ? [] : [rootOriginal]));
	return items;
}

// GET /api/v1/nodes/:id/subtree-ids - Every cached descendant of the node ("home" = the whole tree), for Expand/Collapse all
export const nodesSubtreeIds = defineOp({
	input: IdInput,
	output: SubtreeItemsResponseSchema,
	run(ctx, {id: rawId}) {
		if (rawId === HOME_TARGET) {
			return ok(toJson({items: readSubtreeItems(ctx, null)}));
		}
		const id = resolveNodeId(ctx, rawId);
		if (id === null || ctx.cacheService.getNode(id) === undefined) {
			return fail(404, {error: "Node not found"});
		}
		return ok(toJson({items: readSubtreeItems(ctx, id)}));
	},
});

// GET /api/v1/nodes/:id/ancestors - Get all ancestors from root to node
export const nodesAncestors = defineOp({
	input: IdInput,
	output: AncestorsResponseSchema,
	run(ctx, {id: rawId}) {
		const id = resolveNodeId(ctx, rawId);
		if (!id) {
			return fail(404, {error: "Node not found"});
		}

		const reader = new NodeReader(ctx.db);

		// Build ancestor chain by following parent_id pointers
		type Chain = NonNullable<ReturnType<NodeReader["getById"]>>[];
		const chainTo = (nodeId: string): Chain =>
			ancestorChain(nodeId, (linkId) => reader.getById(linkId)).toReversed();
		let chain = chainTo(id);

		// A row inside a mirror (`v_<child12>_<mirror12>[_<path>]`): the mirror's ancestors and the mirror, then the rows
		// below its original down to the row.
		const virtual = parseVirtualShortId(rawId);
		const mirrorId = virtual === null ? null : ctx.cacheService.resolveShortIdToUuid(virtual.mirrorShortId);
		const originalId = mirrorId === null ? null : ctx.cacheService.getMirrorOriginal(mirrorId);
		if (mirrorId !== null && originalId !== null) {
			const originalIndex = chain.findIndex((node) => node.id === originalId);
			if (originalIndex !== -1) {
				chain = [...chainTo(mirrorId), ...chain.slice(originalIndex + 1)];
			}
		}

		// A day page reads the calendar root's settings (Friendly day names) from its ancestors.
		const calendar = loadCalendarInfo({db: ctx.db, cache: ctx.cacheService}, chain);
		const ancestors: NodeResponse[] = chain.map((node) => ({
			...nodeToRestDto(node, {
				hasChildren: true,
				hasUncompletedChildren: true,
				// A references root reads "N Backlinks", never "Untitled" (upstream `displayLabel`).
				name: referencesRootLabel(ctx.db, node.id) ?? node.name,
				note: node.note,
				calendar: calendar.get(node.id),
			}),
			isMirror: false,
			originalNodeId: null,
		}));

		return ok(toJson({ancestors}));
	},
});

// GET /api/v1/nodes/:id/backlinks - The item's Backlinks section: its references root
// and the backlink items whose source is current, each with the source's text and crumbs.
export const nodesBacklinks = defineOp({
	input: IdInput,
	output: BacklinksResponseSchema,
	run(ctx, {id: rawId}) {
		const id = resolveNodeId(ctx, rawId);
		if (!id) {
			return fail(404, {error: "Node not found"});
		}
		return ok(toJson(readBacklinks(ctx, id)));
	},
});

/** The Backlinks section of the resolved node `id` (a mirror shows its original's). */
function readBacklinks(ctx: ServerContext, id: string): BacklinksResponse {
	const original = resolveMirrorToOriginal(ctx, id);
	const rootId = findReferencesRoot(ctx.db, original);
	if (rootId === null) {
		return {rootId: null, items: []};
	}
	return {rootId, items: readBacklinkItems(ctx, sql`(${original})`).get(rootId) ?? []};
}

// GET /api/v1/nodes/:id/found-dates - A day page's Found Dates section: the nodes
// elsewhere whose <time> covers the day, each as a mirror row of itself with its crumbs.
export const nodesFoundDates = defineOp({
	input: IdInput,
	output: FoundDatesResponseSchema,
	async run(ctx, {id: rawId}) {
		const id = resolveNodeId(ctx, rawId);
		const node = id === null ? undefined : ctx.cacheService.getNode(id);
		if (!node) {
			return fail(404, {error: "Node not found"});
		}
		return ok(toJson((await readFoundDates(ctx, node)) ?? {items: []}));
	},
});

/**
 * `node`'s Found Dates section when it is a day page, else null. `known` is the node's calendar role when the caller
 * already read it (null: none); undefined reads it.
 */
async function readFoundDates(
	ctx: ServerContext,
	node: Node,
	known?: CalendarInfo | null,
): Promise<FoundDatesResponse | null> {
	const deps = {db: ctx.db, cache: ctx.cacheService};
	const calendar = known === undefined ? loadCalendarInfo(deps, [node]).get(node.id) : known;
	if (calendar?.level !== "day") {
		return null;
	}
	const found = calendar.dateId === null ? [] : findFoundDates(deps, node.id, calendar.dateId);
	const ids = found.map((item) => item.id);
	const trees = new Map(
		(await new NodeTreeReader(ctx.cacheService).readNodes(ids, {depth: 0})).map((tree) => [tree.id, tree]),
	);
	const flags = childFlags(ctx.db, ids);
	return {
		items: found.flatMap(({id: foundId, crumbs}) => {
			const tree = trees.get(foundId);
			return tree
				? [
						{
							node: {
								...nodeToRestDto(tree, {
									hasChildren: flags.withChildren.has(foundId),
									hasUncompletedChildren: flags.withUncompletedChildren.has(foundId),
									name: tree.name,
									note: tree.note,
								}),
								isMirror: true,
								originalNodeId: foundId,
							},
							crumbs,
						},
					]
				: [];
		}),
	};
}

// GET /api/v1/nodes/:id/mirrors - Get all locations where a node appears (original + mirrors)
export const nodesMirrors = defineOp({
	input: IdInput,
	output: MirrorsResponseSchema,
	run(ctx, {id: rawId}) {
		const id = resolveNodeId(ctx, rawId);
		if (!id) {
			return fail(404, {error: "Node not found"});
		}

		const {db} = ctx;
		const reader = new NodeReader(db);

		// First, resolve to the original node (in case we were given a mirror ID)
		const originalId = resolveMirrorToOriginal(ctx, id);

		// Find all mirrors of the original node
		const mirrorRows = db
			.select({mirrorId: mirrorsTable.mirrorId})
			.from(mirrorsTable)
			.where(and(eq(mirrorsTable.originalId, originalId), eq(mirrorsTable.systemTo, FAR_FUTURE_DATE)))
			.all();

		// Collect all node IDs: the original + all mirrors
		const allIds = [originalId, ...mirrorRows.map((r) => r.mirrorId)];

		// A mirror's text always comes from its original.
		const nodeName = (reader.getById(originalId)?.name ?? "") || "Untitled";

		// Helper to build ancestor breadcrumb path for a node
		function getAncestorPath(nodeId: string): {id: string; name: string}[] {
			return ancestorChain(nodeId, (linkId) => reader.getById(linkId))
				.toReversed()
				.map((node) => ({id: node.id, name: node.name ?? "Untitled"}));
		}

		// For each location, build the full ancestor path
		const locations = [];
		for (const nodeId of allIds) {
			const path = getAncestorPath(nodeId);
			locations.push({
				id: nodeId,
				path,
				isOriginal: nodeId === originalId,
			});
		}

		return ok({
			mirrors: locations,
			originalId,
			nodeName,
		});
	},
});

// GET /api/v1/home - Home's layoutMode, read from the root metadata ("bullets" when unset)
export const homeGet = defineOp({
	input: z.object({}),
	output: HomeResponseSchema,
	async run(ctx) {
		const adapter = getAdapter(ctx);
		if (!adapter) {
			return fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
		}
		const layoutMode = await adapter.getRootMeta(["layoutMode"]);
		return ok(toJson({layoutMode: typeof layoutMode === "string" ? layoutMode : "bullets"}));
	},
});
