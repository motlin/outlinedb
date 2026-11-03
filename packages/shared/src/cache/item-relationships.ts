/**
 * Item relationships carried only in Workflowy's per-item `metadata` (a backup
 * file or the internal `/get_tree_data/` read), never by the public REST API:
 * mirrors and references roots. Backlinks are not stored: a backlink item is a
 * live mirror whose parent is a references root (see {@link currentBacklinkItems}).
 *
 * Both import adapters normalize item metadata through
 * {@link collectItemRelationships} and merge the `mirrors` table through
 * {@link mergeItemRelationships}, so the parse and the merge live in one place.
 */

import {and, eq, or, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {alias} from "drizzle-orm/sqlite-core";
import {mirrors, nodeContent, referencesRoots} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {inIds} from "./in-ids.js";
import type {UnitOfWork} from "./node-composite.js";
import type {NormalizedMirrorRow, NormalizedReferencesRootsRow} from "./normalized-rows.js";
import {joinKey, temporalMerge} from "./temporal-merge.js";
import type {TemporalMergeResult, TemporalTransaction} from "./temporal-merge.js";

export interface ItemRelationships {
	mirrors: NormalizedMirrorRow[];
	referencesRoots: NormalizedReferencesRootsRow[];
}

export interface MergeItemRelationshipsResult {
	mirrors: TemporalMergeResult;
}

export function emptyItemRelationships(): ItemRelationships {
	return {mirrors: [], referencesRoots: []};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(value: unknown): string[] {
	return isRecord(value) ? Object.keys(value) : [];
}

/**
 * Append the relationships in one item's `metadata` to `into`. Unknown or
 * malformed fields are ignored, so it reads both the validated backup shape and
 * the untyped `/get_tree_data/` items.
 */
export function collectItemRelationships(into: ItemRelationships, id: string, metadata: unknown): void {
	if (!isRecord(metadata)) {
		return;
	}
	if (metadata.isReferencesRoot === true) {
		into.referencesRoots.push({nodeId: id});
	}
	const {mirror, backlink} = metadata;
	if (isRecord(mirror)) {
		// originalId: this node mirrors that original.
		if (typeof mirror.originalId === "string" && mirror.originalId !== "") {
			into.mirrors.push({mirrorId: id, originalId: mirror.originalId});
		}
		// mirrorRootIds / backlinkMirrorRootIds: this node is the original of each id.
		for (const mirrorId of [...keysOf(mirror.mirrorRootIds), ...keysOf(mirror.backlinkMirrorRootIds)]) {
			into.mirrors.push({mirrorId, originalId: id});
		}
	}
	// A backlink item mirrors its source; its target is derived from where it sits.
	if (isRecord(backlink) && typeof backlink.sourceID === "string" && backlink.sourceID !== "") {
		into.mirrors.push({mirrorId: id, originalId: backlink.sourceID});
	}
}

function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
	return [...new Map(rows.map((row) => [key(row), row])).values()];
}

const mirrorKey = (m: NormalizedMirrorRow): string => joinKey(m.mirrorId, m.originalId);

/**
 * Globally merge `mirrors` to the desired state in `relationships`, in the
 * caller's unit of work. Only rows with both sides in `liveNodeIds` are kept:
 * Workflowy keeps a mirror's `originalId` after deleting its original, and an
 * original's `mirrorRootIds` after deleting a mirror.
 */
export function mergeItemRelationships(
	unitOfWork: UnitOfWork,
	relationships: ItemRelationships,
	liveNodeIds: ReadonlySet<string>,
): MergeItemRelationshipsResult {
	const {tx, systemTime} = unitOfWork;

	const mirrorRows = dedupe(
		relationships.mirrors.filter((m) => liveNodeIds.has(m.mirrorId) && liveNodeIds.has(m.originalId)),
		mirrorKey,
	);
	const mirrorResult = temporalMerge(
		tx,
		{
			table: mirrors,
			keyColumns: [mirrors.mirrorId, mirrors.originalId],
			incomingKey: mirrorKey,
			currentKey: mirrorKey,
			contentMatches: () => true, // the key is the whole row
			buildInsertRow: (m: NormalizedMirrorRow) => ({mirrorId: m.mirrorId, originalId: m.originalId}),
		},
		mirrorRows,
		tx.select().from(mirrors).where(eq(mirrors.systemTo, FAR_FUTURE_DATE)).all(),
		systemTime,
	);

	return {mirrors: mirrorResult};
}

/**
 * Insert the `mirrors` and `references_roots` rows in
 * `relationships` that are not already current, in the caller's unit of work.
 * Unlike {@link mergeItemRelationships} it ends nothing: it records what an
 * accepted push created.
 */
export function recordItemRelationships(unitOfWork: UnitOfWork, relationships: ItemRelationships): void {
	const {tx, systemTime} = unitOfWork;
	const current = {systemFrom: systemTime, systemTo: FAR_FUTURE_DATE};
	for (const row of dedupe(relationships.mirrors, mirrorKey)) {
		const exists = tx
			.select({id: mirrors.mirrorId})
			.from(mirrors)
			.where(
				and(
					eq(mirrors.mirrorId, row.mirrorId),
					eq(mirrors.originalId, row.originalId),
					eq(mirrors.systemTo, FAR_FUTURE_DATE),
				),
			)
			.get();
		if (exists === undefined) {
			tx.insert(mirrors)
				.values({mirrorId: row.mirrorId, originalId: row.originalId, ...current})
				.run();
		}
	}
	for (const nodeId of new Set(relationships.referencesRoots.map((row) => row.nodeId))) {
		const exists = tx
			.select({id: referencesRoots.nodeId})
			.from(referencesRoots)
			.where(and(eq(referencesRoots.nodeId, nodeId), eq(referencesRoots.systemTo, FAR_FUTURE_DATE)))
			.get();
		if (exists === undefined) {
			tx.insert(referencesRoots)
				.values({nodeId, ...current})
				.run();
		}
	}
}

/** The relationship part of one item's upstream metadata, as `/get_tree_data/` carries it. */
export interface UpstreamRelationshipMetadata {
	mirror?: {
		originalId?: string;
		isMirrorRoot?: true;
		mirrorRootIds?: Record<string, true>;
		backlinkMirrorRootIds?: Record<string, true>;
	};
	backlink?: {sourceID: string; targetID: string};
	isReferencesRoot?: true;
}

/** A backlink item: a mirror of `sourceId` under `targetId`'s references root. */
export interface BacklinkItem {
	nodeId: string;
	sourceId: string;
	targetId: string;
}

const itemContent = alias(nodeContent, "backlink_item");
const rootContent = alias(nodeContent, "backlink_root");

/**
 * The current backlink items matching `where`, derived from the edge tables: a
 * live `mirrors` row whose mirror's parent is a live references root. The
 * source is the mirror's original and the target the root's parent. `where`
 * may filter on `mirrors.mirrorId`, `mirrors.originalId` or
 * {@link backlinkItemParent}.
 */
export function currentBacklinkItems(tx: TemporalTransaction, where: SQL | undefined): BacklinkItem[] {
	return tx
		.select({nodeId: mirrors.mirrorId, sourceId: mirrors.originalId, targetId: rootContent.parentId})
		.from(mirrors)
		.innerJoin(itemContent, and(eq(itemContent.id, mirrors.mirrorId), eq(itemContent.systemTo, FAR_FUTURE_DATE)))
		.innerJoin(
			referencesRoots,
			and(eq(referencesRoots.nodeId, itemContent.parentId), eq(referencesRoots.systemTo, FAR_FUTURE_DATE)),
		)
		.innerJoin(
			rootContent,
			and(eq(rootContent.id, itemContent.parentId), eq(rootContent.systemTo, FAR_FUTURE_DATE)),
		)
		.where(and(eq(mirrors.systemTo, FAR_FUTURE_DATE), where))
		.all()
		.flatMap(({nodeId, sourceId, targetId}) => (targetId === null ? [] : [{nodeId, sourceId, targetId}]));
}

/** The parent column of a backlink item in {@link currentBacklinkItems}, for filtering by references root. */
export const backlinkItemParent = itemContent.parentId;

/** A `mirrors` condition: the mirror is not a backlink item (its parent is not a current references root). */
export function notBacklinkItem(): SQL {
	return sql`NOT EXISTS (SELECT 1 FROM ${nodeContent} c JOIN ${referencesRoots} r ON r.node_id = c.parent_id AND r.system_to = ${FAR_FUTURE_DATE} WHERE c.id = ${mirrors.mirrorId} AND c.system_to = ${FAR_FUTURE_DATE})`;
}

/**
 * Each node's upstream `mirror`, `backlink` and `isReferencesRoot` objects,
 * rebuilt from the current `mirrors` and `references_roots` rows (the inverse
 * of {@link collectItemRelationships}). A mirror that is a backlink item is
 * listed under its original's `backlinkMirrorRootIds` and carries
 * `backlink{sourceID, targetID}`; any other mirror is listed under
 * `mirrorRootIds`. A node with no relationships maps to `{}`.
 */
export function upstreamRelationshipMetadata(
	tx: TemporalTransaction,
	nodeIds: readonly string[],
): Map<string, UpstreamRelationshipMetadata> {
	const result = new Map<string, UpstreamRelationshipMetadata>(nodeIds.map((id) => [id, {}]));
	const ids = [...result.keys()];
	const touches = or(inIds(mirrors.mirrorId, ids), inIds(mirrors.originalId, ids));
	const mirrorRows = tx
		.select({mirrorId: mirrors.mirrorId, originalId: mirrors.originalId})
		.from(mirrors)
		.where(and(touches, eq(mirrors.systemTo, FAR_FUTURE_DATE)))
		.all();
	const backlinkItems = new Map(currentBacklinkItems(tx, touches).map((item) => [item.nodeId, item]));
	for (const {mirrorId, originalId} of mirrorRows) {
		const item = backlinkItems.get(mirrorId);
		const asMirror = result.get(mirrorId);
		if (asMirror !== undefined) {
			asMirror.mirror = {...asMirror.mirror, originalId, isMirrorRoot: true};
			if (item !== undefined) {
				asMirror.backlink = {sourceID: item.sourceId, targetID: item.targetId};
			}
		}
		const asOriginal = result.get(originalId);
		if (asOriginal !== undefined) {
			const mirror = (asOriginal.mirror ??= {});
			const field = item === undefined ? "mirrorRootIds" : "backlinkMirrorRootIds";
			mirror[field] = {...mirror[field], [mirrorId]: true};
		}
	}
	const rootRows = tx
		.select({nodeId: referencesRoots.nodeId})
		.from(referencesRoots)
		.where(and(inIds(referencesRoots.nodeId, ids), eq(referencesRoots.systemTo, FAR_FUTURE_DATE)))
		.all();
	for (const {nodeId} of rootRows) {
		const metadata = result.get(nodeId);
		if (metadata !== undefined) {
			metadata.isReferencesRoot = true;
		}
	}
	return result;
}
