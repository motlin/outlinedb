import {backlinkItemParent, currentBacklinkItems, effectiveCompletedAt, inIds} from "@outlinedb/shared/cache";
import {aiMetadata, mirrors, nodeContent, nodeMetadata, referencesRoots} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {internalLinkShortIds} from "@outlinedb/shared/workflowy";
import {backlinksLabel} from "../backlinks-label.js";
import type {ServerContext} from "./context.js";

type ServerDatabase = ServerContext["db"];

const currentReferencesRootIds = sql`(SELECT ${referencesRoots.nodeId} FROM ${referencesRoots} WHERE ${referencesRoots.systemTo} = ${FAR_FUTURE_DATE})`;

/**
 * A `mirrors` condition: the mirror's original is a current node. An EXISTS probe rather than `original_id IN (all
 * current ids)`, which SQLite would use as an index key and loop over every current node for each mirror.
 */
const liveOriginal = sql`EXISTS (SELECT 1 FROM ${nodeContent} live_original WHERE live_original.id = ${mirrors.originalId} AND live_original.system_to = ${FAR_FUTURE_DATE})`;

/** Upstream's `ai.inChat` items (the "AI Messages" mailbox), which its `ai_chat_message` displayable rule hides. */
const currentInChatIds = sql`(SELECT ${aiMetadata.nodeId} FROM ${aiMetadata} WHERE ${aiMetadata.inChat} = 1 AND ${aiMetadata.systemTo} = ${FAR_FUTURE_DATE})`;

/**
 * A `node_content` condition that drops every references root and the backlink
 * items directly under it. Upstream never shows either as a row, child, search
 * or jump hit; they surface only through the Backlinks section.
 */
export function notReferencesContent(): SQL {
	return sql`(${nodeContent.id} NOT IN ${currentReferencesRootIds} AND (${nodeContent.parentId} IS NULL OR ${nodeContent.parentId} NOT IN ${currentReferencesRootIds}))`;
}

/** A `node_content` condition that drops every references root (its backlink items stay). */
export function notReferencesRoot(): SQL {
	return sql`${nodeContent.id} NOT IN ${currentReferencesRootIds}`;
}

/** Which parents have any child, and which have at least one uncompleted child. */
export interface ChildFlags {
	withChildren: Set<string>;
	withUncompletedChildren: Set<string>;
}

/** The child flags over `{parentId, completedAt}` rows, one row per child. */
export function childFlagsFromRows(rows: {parentId: string | null; completedAt: Date | null}[]): ChildFlags {
	const flags: ChildFlags = {withChildren: new Set(), withUncompletedChildren: new Set()};
	for (const {parentId, completedAt} of rows) {
		if (parentId === null) {
			continue;
		}
		flags.withChildren.add(parentId);
		if (completedAt === null) {
			flags.withUncompletedChildren.add(parentId);
		}
	}
	return flags;
}

/**
 * The child flags of `parentIds`, counting only current children that are not
 * references roots or `ai.inChat` items. Upstream hides the triangle of a parent whose children are
 * all completed while completed items are hidden, so both flags are needed.
 */
export function childFlags(db: ServerDatabase, parentIds: string[]): ChildFlags {
	if (parentIds.length === 0) {
		return childFlagsFromRows([]);
	}
	const rows = db
		.select({
			parentId: nodeContent.parentId,
			completedAt: effectiveCompletedAt(nodeContent.id, nodeMetadata.completedAt),
		})
		.from(nodeContent)
		.leftJoin(
			nodeMetadata,
			and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
		)
		.where(
			and(
				inIds(nodeContent.parentId, parentIds),
				eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				sql`${nodeContent.id} NOT IN ${currentReferencesRootIds}`,
				sql`${nodeContent.id} NOT IN ${currentInChatIds}`,
			),
		)
		.all();
	const flags = childFlagsFromRows(rows);
	addReferencesRootFlags(db, parentIds, flags);
	return flags;
}

/**
 * A displayable references root counts as a child of its target (upstream's
 * `isDisplayable`: some backlink item is potentially visible), so a target
 * whose only child is the section still has an arrow. It counts as an
 * uncompleted child only while some backlink source is uncompleted.
 */
function addReferencesRootFlags(db: ServerDatabase, parentIds: string[], flags: ChildFlags): void {
	const roots = db
		.select({id: nodeContent.id})
		.from(nodeContent)
		.where(
			and(
				inIds(nodeContent.parentId, parentIds),
				eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				sql`${nodeContent.id} IN ${currentReferencesRootIds}`,
			),
		)
		.all();
	if (roots.length === 0) {
		return;
	}
	// A backlink item's target is its references root's parent: the row whose flags it sets.
	const items = currentBacklinkItems(
		db,
		and(
			inIds(
				backlinkItemParent,
				roots.map(({id}) => id),
			),
			liveOriginal,
		),
	);
	for (const {targetId} of items) {
		flags.withChildren.add(targetId);
	}
	const uncompletedSources = new Set(
		db
			.select({id: nodeContent.id, completedAt: effectiveCompletedAt(nodeContent.id, nodeMetadata.completedAt)})
			.from(nodeContent)
			.leftJoin(
				nodeMetadata,
				and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
			)
			.where(
				and(
					inIds(nodeContent.id, [...new Set(items.map(({sourceId}) => sourceId))]),
					eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				),
			)
			.all()
			.flatMap(({id, completedAt}) => (completedAt === null ? [id] : [])),
	);
	for (const {sourceId, targetId} of items) {
		if (uncompletedSources.has(sourceId)) {
			flags.withUncompletedChildren.add(targetId);
		}
	}
}

/** The current references root under `targetId`, or null. */
export function findReferencesRoot(db: ServerDatabase, targetId: string): string | null {
	const row = db
		.select({id: nodeContent.id})
		.from(nodeContent)
		.where(
			and(
				eq(nodeContent.parentId, targetId),
				eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				sql`${nodeContent.id} IN ${currentReferencesRootIds}`,
			),
		)
		.limit(1)
		.get();
	return row?.id ?? null;
}

/**
 * The backlink items under `rootId` whose source is a current node, mapped to
 * that source id. Whether the source text still links to the target is not
 * checked, matching upstream's count.
 */
function currentBacklinkSources(db: ServerDatabase, rootId: string): Map<string, string> {
	const items = currentBacklinkItems(db, and(eq(backlinkItemParent, rootId), liveOriginal));
	return new Map(items.map((item) => [item.nodeId, item.sourceId]));
}

/** The target of every current backlink item made from `sourceId`, keyed by the item's id. */
export function backlinkTargetsOfSource(db: ServerDatabase, sourceId: string): Map<string, string> {
	const items = currentBacklinkItems(db, eq(mirrors.originalId, sourceId));
	return new Map(items.map((item) => [item.nodeId, item.targetId]));
}

/**
 * Whether saving a source's text can change its backlinks: its link set
 * moved, or a linked target lacks the current backlink item under a current
 * references root that upstream's edit would recreate. Keeps the whole-tree
 * `syncBacklinks` off the path of a plain keystroke in a linked row.
 */
export function backlinksNeedSync(
	ctx: ServerContext,
	sourceId: string,
	beforeText: string,
	afterText: string,
): boolean {
	const before = new Set(internalLinkShortIds(beforeText));
	const after = new Set(internalLinkShortIds(afterText));
	if (before.size !== after.size || [...after].some((id) => !before.has(id))) {
		return true;
	}
	// Every derived backlink item already sits under a current references root.
	const present = new Set(backlinkTargetsOfSource(ctx.db, sourceId).values());
	for (const shortId of after) {
		const resolved = ctx.cacheService.resolveShortIdToUuid(shortId);
		if (resolved === null) {
			continue;
		}
		const target = ctx.cacheService.getMirrorOriginal(resolved) ?? resolved;
		if (target !== sourceId && !present.has(target)) {
			return true;
		}
	}
	return false;
}

/** `rootId` when it is a current references root, else null. */
function findReferencesRootId(db: ServerDatabase, rootId: string): string | null {
	const row = db
		.select({nodeId: referencesRoots.nodeId})
		.from(referencesRoots)
		.where(and(eq(referencesRoots.nodeId, rootId), eq(referencesRoots.systemTo, FAR_FUTURE_DATE)))
		.get();
	return row?.nodeId ?? null;
}

/** A current references root's "N Backlinks" label (upstream `JP.displayLabel`), or null for any other node. */
export function referencesRootLabel(db: ServerDatabase, nodeId: string): string | null {
	return findReferencesRootId(db, nodeId) === null ? null : backlinksLabel(currentBacklinkSources(db, nodeId).size);
}

/**
 * {@link currentBacklinkSources} for many references roots in one query: every current backlink item under any of
 * `rootIds`, mapped to its source id.
 */
export function currentBacklinkSourcesUnder(db: ServerDatabase, rootIds: readonly string[]): Map<string, string> {
	if (rootIds.length === 0) {
		return new Map();
	}
	const items = currentBacklinkItems(db, and(inIds(backlinkItemParent, rootIds), liveOriginal));
	return new Map(items.map((item) => [item.nodeId, item.sourceId]));
}

/**
 * {@link referencesRootLabel} for many nodes in two queries: the "N Backlinks" label of each of `nodeIds` that is a
 * current references root. Other nodes are absent.
 */
export function referencesRootLabels(db: ServerDatabase, nodeIds: readonly string[]): Map<string, string> {
	if (nodeIds.length === 0) {
		return new Map();
	}
	const rootIds = db
		.select({nodeId: referencesRoots.nodeId})
		.from(referencesRoots)
		.where(and(inIds(referencesRoots.nodeId, nodeIds), eq(referencesRoots.systemTo, FAR_FUTURE_DATE)))
		.all()
		.map(({nodeId}) => nodeId);
	if (rootIds.length === 0) {
		return new Map();
	}
	const counts = new Map(rootIds.map((rootId) => [rootId, 0]));
	const rows = db
		.select({rootId: nodeContent.parentId})
		.from(mirrors)
		.innerJoin(nodeContent, and(eq(nodeContent.id, mirrors.mirrorId), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
		.where(and(eq(mirrors.systemTo, FAR_FUTURE_DATE), inIds(nodeContent.parentId, rootIds), liveOriginal))
		.all();
	for (const {rootId} of rows) {
		if (rootId !== null) {
			counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
		}
	}
	return new Map([...counts].map(([rootId, count]) => [rootId, backlinksLabel(count)]));
}
