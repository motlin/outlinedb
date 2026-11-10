import {z} from "zod";
import {WorkflowyApiClient} from "@outlinedb/shared/api";
import type {
	BacklinkCrumb,
	BacklinksResponse,
	CalendarInfo,
	FoundDatesResponse,
	NodeChangesResponse,
	NodeAttachment,
	NodeResponse,
	OutlineViewList,
	OutlineViewResponse,
	SaveEffects,
	TableMetadata,
	UpdateNodeResponse,
} from "../../node-types.js";
import {
	NodeReader,
	NodeTreeReader,
	WorkflowyWriteThroughClient,
	inIds,
	readInternalMetadata,
} from "@outlinedb/shared/cache";
import type {ExactMover, SlotPlan} from "@outlinedb/shared/cache";
import {MAX_COPY_ITEMS} from "../copy-tree.js";
import {mirrors as mirrorsTable, s3Files} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {RestoreInput, WorkflowyInternalAdapter, NewTree} from "@outlinedb/shared/internal";
import type {Node} from "@outlinedb/shared/types";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {internalLinkShortIds, isShortId, parseVirtualShortId} from "@outlinedb/shared/workflowy";
import {and, eq} from "drizzle-orm";
import {childFlags, referencesRootLabel} from "../backlinks.js";
import {loadCalendarInfo} from "../calendar-day.js";
import {timesDiffer} from "../calendar-found.js";
import type {ServerContext} from "../context.js";
import type {MirrorInstance} from "../../mirror-path.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api.js";
import {TableMetadataSchema} from "./schemas.js";

/**
 * Resolve an ID parameter that could be a short ID (12 hex chars) or a full UUID.
 * Returns the full UUID, or null if a short ID couldn't be resolved.
 */
export function resolveNodeId(ctx: ServerContext, id: string): string | null {
	// A row inside a mirror (`v_<child12>_<mirror12>[_<path>]`) names the original child it shows.
	const virtual = parseVirtualShortId(id);
	if (virtual !== null) {
		return ctx.cacheService.resolveShortIdToUuid(virtual.nodeShortId);
	}
	if (!isShortId(id)) {
		return id;
	}
	return ctx.cacheService.resolveShortIdToUuid(id);
}

/** {@link resolveMirrorToOriginal} for many ids at once: two queries however many ids. */
export function resolveMirrorsToOriginals(ctx: ServerContext, nodeIds: string[]): Map<string, string> {
	const nodes = new NodeReader(ctx.db).getMany(nodeIds);
	return new Map(nodeIds.map((id) => [id, nodes.get(id)?.mirror.originalNodeId ?? id]));
}

/**
 * What saving `name`/`note` over `before` (the text source's cached text) changes beyond the node itself: the
 * nodes a link was added to or removed from, and whether its `<time>` dates moved. The client refetches only those.
 */
export function saveEffects(
	ctx: ServerContext,
	before: {name: string | null; note?: string | null} | undefined,
	name: string | undefined,
	note: string | undefined,
): SaveEffects {
	const beforeText = `${before?.name ?? ""} ${before?.note ?? ""}`;
	const afterText = `${name ?? before?.name ?? ""} ${note ?? before?.note ?? ""}`;
	const beforeLinks = new Set(internalLinkShortIds(beforeText));
	const afterLinks = new Set(internalLinkShortIds(afterText));
	const changed = [
		...[...beforeLinks].filter((id) => !afterLinks.has(id)),
		...[...afterLinks].filter((id) => !beforeLinks.has(id)),
	];
	return {
		backlinkTargets: changed.flatMap((id) => resolveNodeId(ctx, id) ?? []),
		dates: timesDiffer(beforeText, afterText),
	};
}

/**
 * If the given node ID is a mirror, return the original node ID.
 * Otherwise return the same ID. Used when fetching children —
 * a mirror's children are the original node's children.
 */
export function resolveMirrorToOriginal(ctx: ServerContext, nodeId: string): string {
	const reader = new NodeReader(ctx.db);
	return reader.getById(nodeId)?.mirror.originalNodeId ?? nodeId;
}

/**
 * Convert a Date to a Unix timestamp in seconds, or null.
 */
export function toUnixSeconds(date: Date | null): number | null {
	return date ? Math.floor(date.getTime() / 1000) : null;
}

/**
 * Serialize a canonical `Node` into the snake_case Workflowy-compatible
 * REST response. The child flags and the mirror name/note fallback
 * are derived per-request and supplied by the caller.
 */
export function nodeToRestDto(
	node: Node,
	derived: {
		hasChildren: boolean;
		hasUncompletedChildren: boolean;
		hasMirrors?: boolean;
		name: string | null;
		note: string | null;
		attachment?: NodeAttachment | null;
		metadata?: InternalMetadataFields;
		calendar?: CalendarInfo;
	},
): NodeResponse {
	return {
		id: node.id,
		parent_id: node.parentId,
		name: derived.name,
		note: derived.note,
		priority: node.priority,
		data: {layoutMode: node.layoutMode},
		numberedStart: derived.metadata?.numberedStart ?? null,
		createdAt: toUnixSeconds(node.createdAt),
		modifiedAt: toUnixSeconds(node.modifiedAt),
		completedAt: toUnixSeconds(node.completedAt),
		hasChildren: derived.hasChildren,
		hasUncompletedChildren: derived.hasUncompletedChildren,
		isMirror: node.mirror.isMirror,
		hasMirrors: derived.hasMirrors ?? false,
		originalNodeId: node.mirror.originalNodeId,
		attachment: derived.attachment ?? null,
		defaultToBottom: derived.metadata?.defaultToBottom ?? false,
		calendar: derived.calendar ?? null,
		table: derived.metadata?.table ?? null,
	};
}

/**
 * Load file-attachment metadata for a batch of node IDs from the `s3_files`
 * cache table. Returns a map from node ID to its attachment; nodes without an
 * attachment are absent from the map. `isDeleted` is normalized to a boolean —
 * the column stores 1/0/NULL, and anything other than 1 means "not deleted".
 */
export function loadAttachments(ctx: ServerContext, nodeIds: string[]): Map<string, NodeAttachment> {
	const map = new Map<string, NodeAttachment>();
	if (nodeIds.length === 0) {
		return map;
	}
	const rows = ctx.db
		.select({
			nodeId: s3Files.nodeId,
			fileName: s3Files.fileName,
			fileType: s3Files.fileType,
			objectFolder: s3Files.objectFolder,
			imageOriginalWidth: s3Files.imageOriginalWidth,
			imageOriginalHeight: s3Files.imageOriginalHeight,
			imageOriginalPixels: s3Files.imageOriginalPixels,
			isAnimatedGif: s3Files.isAnimatedGif,
			isDeleted: s3Files.isDeleted,
		})
		.from(s3Files)
		.where(and(inIds(s3Files.nodeId, nodeIds), eq(s3Files.systemTo, FAR_FUTURE_DATE)))
		.all();
	for (const row of rows) {
		map.set(row.nodeId, {
			fileName: row.fileName,
			fileType: row.fileType,
			objectFolder: row.objectFolder,
			imageOriginalWidth: row.imageOriginalWidth,
			imageOriginalHeight: row.imageOriginalHeight,
			imageOriginalPixels: row.imageOriginalPixels,
			isAnimatedGif: row.isAnimatedGif === 1,
			isDeleted: row.isDeleted === 1,
		});
	}
	return map;
}

/** The node DTO fields read from the cached internal metadata. */
export interface InternalMetadataFields {
	numberedStart: number | null;
	defaultToBottom: boolean;
	table: TableMetadata | null;
}

/**
 * Load each node's `numbered_start` (the first number of a numbered list) and
 * `priority.defaultToBottom` from the cached internal metadata; nodes without
 * metadata are absent from the map.
 */
export function loadInternalMetadataFields(ctx: ServerContext, nodeIds: string[]): Map<string, InternalMetadataFields> {
	const map = new Map<string, InternalMetadataFields>();
	if (nodeIds.length === 0) {
		return map;
	}
	for (const [nodeId, metadata] of readInternalMetadata(ctx.db, nodeIds)) {
		const {numbered_start: numberedStart, priority, table} = metadata;
		if (numberedStart === undefined && priority === undefined && table === undefined) {
			continue;
		}
		const parsedTable = TableMetadataSchema.safeParse(table);
		map.set(nodeId, {
			numberedStart: typeof numberedStart === "number" ? numberedStart : null,
			defaultToBottom:
				typeof priority === "object" && priority !== null && Reflect.get(priority, "defaultToBottom") === true,
			table: parsedTable.success ? parsedTable.data : null,
		});
	}
	return map;
}

/**
 * {@link loadInternalMetadataFields} over rows a shaped read already holds: the node's current
 * `node_display_metadata` row and its current table cell sizes. Undefined when they set none of the fields.
 */
export function displayMetadataFields(
	display: {
		numberedStart: number | null;
		priorityDefaultToBottom: number | null;
		tableHeaders: number | null;
		tableSkipHeaders: number | null;
		tableBg: string | null;
	} | null,
	sizes: readonly {cellId: string; size: number}[],
): InternalMetadataFields | undefined {
	const table: Record<string, unknown> = {};
	if (display?.tableHeaders != null) {
		table.headers = display.tableHeaders === 1;
	}
	if (display?.tableSkipHeaders != null) {
		table.skipHeaders = display.tableSkipHeaders === 1;
	}
	if (display?.tableBg != null) {
		table.bg = display.tableBg;
	}
	if (sizes.length > 0) {
		table.sizes = Object.fromEntries(sizes.map(({cellId, size}) => [cellId, size]));
	}
	const hasTable = Object.keys(table).length > 0;
	const numberedStart = display?.numberedStart ?? null;
	const defaultToBottom = display?.priorityDefaultToBottom ?? null;
	if (numberedStart === null && defaultToBottom === null && !hasTable) {
		return undefined;
	}
	const parsedTable = TableMetadataSchema.safeParse(hasTable ? table : undefined);
	return {
		numberedStart,
		defaultToBottom: defaultToBottom === 1,
		table: parsedTable.success ? parsedTable.data : null,
	};
}

/**
 * Build the write-through client from the context, or undefined when no API key
 * is configured (read-only mode).
 */
export function getApiClient(ctx: ServerContext): WorkflowyApiClient | undefined {
	return ctx.apiKey ? new WorkflowyApiClient(ctx.apiKey, undefined, ctx.config.apiUrl) : undefined;
}

export function getWriteClient(ctx: ServerContext): WorkflowyWriteThroughClient | undefined {
	const apiClient = getApiClient(ctx);
	if (!apiClient) {
		return undefined;
	}
	// With the internal API, a mirror-delete promotion is one exact-index move instead of a sibling rotation.
	const adapter = getAdapter(ctx);
	const exactMover: ExactMover | undefined = adapter && {
		moveTo: async ({ids, parentId, index}) => adapter.moveTo({ids, parentId: adapterParent(parentId), index}),
	};
	return new WorkflowyWriteThroughClient(apiClient, ctx.cacheService, exactMover);
}

/**
 * The internal-API adapter for exact-index tree writes, or undefined when the
 * internal API (or the public API key its write-through refresh needs) is not
 * configured.
 */
export function getAdapter(ctx: ServerContext): WorkflowyInternalAdapter | undefined {
	return ctx.apiKey ? ctx.internalAdapter?.() : undefined;
}

/** Which of `ids` are originals with at least one live mirror: one query for the whole list. */
export function originalsWithMirrors(ctx: ServerContext, ids: string[]): Set<string> {
	if (ids.length === 0) {
		return new Set();
	}
	const rows = ctx.db
		.selectDistinct({originalId: mirrorsTable.originalId})
		.from(mirrorsTable)
		.where(and(inIds(mirrorsTable.originalId, ids), eq(mirrorsTable.systemTo, FAR_FUTURE_DATE)))
		.all();
	return new Set(rows.map((row) => row.originalId));
}

/** A node as the REST API returns it, read from the cache; undefined when it is not cached. */
export async function readNodeDto(ctx: ServerContext, id: string): Promise<NodeResponse | undefined> {
	// NodeTreeReader gives a mirror its original's name and note, and sets mirror flags.
	const [node] = await new NodeTreeReader(ctx.cacheService).readNodes([id], {depth: 0});
	if (node === undefined) {
		return undefined;
	}
	const flags = childFlags(ctx.db, [node.mirror.originalNodeId ?? id]);
	const attachment = loadAttachments(ctx, [id]).get(id) ?? null;
	const metadata = loadInternalMetadataFields(ctx, [id]).get(id);
	const calendar = loadCalendarInfo({db: ctx.db, cache: ctx.cacheService}, [node]).get(id);
	const label = referencesRootLabel(ctx.db, id);
	const dto = nodeToRestDto(node, {
		hasMirrors: !node.mirror.isMirror && originalsWithMirrors(ctx, [id]).has(id),
		hasChildren: flags.withChildren.size > 0,
		hasUncompletedChildren: flags.withUncompletedChildren.size > 0,
		name: node.name,
		note: node.note,
		attachment,
		metadata,
		calendar,
	});
	return label === null ? dto : {...dto, isReferencesRoot: true, backlinksLabel: label};
}

/** A parent's children (Home's for `null`) as the REST API returns them, read from the cache. */
export function readChildDtos(ctx: ServerContext, parentId: string | null): NodeResponse[] {
	return readChildDtoLists(ctx, [parentId]).get(parentId) ?? [];
}

/**
 * Many parents' children (Home's for `null`) as the REST API returns them, keyed by parent. Every concern is read
 * once for the whole id set (children, mirrors, child flags, attachments, internal metadata, calendar), so the
 * statement count does not grow with the number of parents.
 */
export function readChildDtoLists(
	ctx: ServerContext,
	parentIds: (string | null)[],
): Map<string | null, NodeResponse[]> {
	// NodeTreeReader gives each mirror its original's name and note. A references
	// root is never a row: its backlinks render as the parent's Backlinks section.
	// Neither is an `ai.inChat` item (upstream's "AI Messages" mailbox).
	const byParent = new NodeTreeReader(ctx.cacheService).readChildrenOfMany(parentIds);
	const lists = new Map<string | null, NodeResponse[]>();
	const nodesByParent = new Map<string | null, Node[]>();
	for (const [parentId, trees] of byParent) {
		nodesByParent.set(
			parentId,
			trees.filter((node) => !node.hasReferencesRoot && !node.inChat),
		);
	}
	const nodes = [...nodesByParent.values()].flat();
	const ids = nodes.map((node) => node.id);
	// Determine which nodes have children (single query for efficiency)
	const flags = childFlags(
		ctx.db,
		nodes.map((node) => node.mirror.originalNodeId ?? node.id),
	);
	const mirrored = originalsWithMirrors(ctx, ids);
	// Batch-load file attachments for all returned nodes.
	const attachments = loadAttachments(ctx, ids);
	const metadata = loadInternalMetadataFields(ctx, ids);
	const calendar = loadCalendarInfo({db: ctx.db, cache: ctx.cacheService}, nodes);
	for (const [parentId, parentNodes] of nodesByParent) {
		lists.set(
			parentId,
			parentNodes.map((node) =>
				nodeToRestDto(node, {
					hasMirrors: !node.mirror.isMirror && mirrored.has(node.id),
					hasChildren: flags.withChildren.has(node.mirror.originalNodeId ?? node.id),
					hasUncompletedChildren: flags.withUncompletedChildren.has(node.mirror.originalNodeId ?? node.id),
					name: node.name,
					note: node.note,
					attachment: attachments.get(node.id) ?? null,
					metadata: metadata.get(node.id),
					calendar: calendar.get(node.id),
				}),
			),
		);
	}
	return lists;
}

/** The refreshed children of every affected parent, in order, as one list. */
export function readSiblingDtos(ctx: ServerContext, parentIds: (string | null)[]): NodeResponse[] {
	return [...readChildDtoLists(ctx, parentIds).values()].flat();
}

/** A request's `parent_id`: a node id (short ids expand), or `null`, `""`, `"None"` or `"home"` for Home. */
export const ParentIdSchema = z.string().nullable();

/** A slot among ALL of a parent's children, the moved nodes included; omitted = bottom. */
export const IndexSchema = z.number().int().nonnegative().optional();

/** Legacy slot: negative = top, anything else = bottom. */
export const LegacyPositionSchema = z.number().optional();

/** The sibling the client saw right above the slot (null: first). */
export const AfterIdSchema = z.string().nullable().optional();

/** A non-empty, ordered list of node ids (short ids expand). */
export const NodeIdsSchema = z.array(z.string()).min(1);

export type ParentResult = {ok: true; parentId: string | null} | {ok: false; status: 404; error: string};

/** Resolve a request's `parent_id` to a node id, or `null` for Home; a short id is expanded from the cache. */
export function parseParent(ctx: ServerContext, raw: string | null): ParentResult {
	if (raw === null || raw === "" || raw === "None" || raw === HOME_TARGET) {
		return {ok: true, parentId: null};
	}
	const resolved = resolveNodeId(ctx, raw);
	return resolved === null
		? {ok: false, status: 404, error: "Parent node not found"}
		: {ok: true, parentId: resolved};
}

/** The requested slot: `index` when given, else the legacy `position` (negative = top), else undefined (bottom). */
export function slotIndex(index: number | undefined, position: number | undefined): number | undefined {
	if (index !== undefined) {
		return index;
	}
	return position !== undefined && position < 0 ? 0 : undefined;
}

/** The adapter's parent id: a node id, or `HOME_TARGET`. */
export function adapterParent(parentId: string | null): string {
	return parentId ?? HOME_TARGET;
}

/**
 * Map a slot onto the public API's two ends: omitted or past the last child is
 * the bottom, 0 the top. Any other slot needs the internal API (undefined).
 */
export function publicEnd(index: number | undefined, childCount: number): "top" | "bottom" | undefined {
	if (index === undefined || index >= childCount) {
		return "bottom";
	}
	return index === 0 ? "top" : undefined;
}

/** The public API's move position for an end: negative is top, anything else bottom. */
export function publicMovePosition(end: "top" | "bottom"): number {
	return end === "top" ? -1 : 0;
}

export function childIds(ctx: ServerContext, parentId: string | null): string[] {
	return ctx.cacheService.getChildren(parentId).map((child) => child.id);
}

export function countChildren(ctx: ServerContext, parentId: string | null): number {
	return ctx.cacheService.getChildren(parentId).length;
}

/** A client-generated node id: a lowercase UUID, as upstream's own clients mint. */

/** Open each copy whose source row is expanded (upstream `syncWith`); `rootSource` overrides the top copy's source row. */
export async function openCopies(
	adapter: WorkflowyInternalAdapter,
	sourceToNew: ReadonlyMap<string, string>,
	rootSource?: {original: string; row: string},
): Promise<void> {
	const isExpanded = adapter.expansionTest();
	const opened: Record<string, boolean> = {};
	for (const [sourceId, copyId] of sourceToNew) {
		const row = sourceId === rootSource?.original ? rootSource.row : sourceId;
		if (isExpanded(row)) {
			opened[copyId] = true;
		}
	}
	if (Object.keys(opened).length > 0) {
		await adapter.setExpanded(opened);
	}
}
