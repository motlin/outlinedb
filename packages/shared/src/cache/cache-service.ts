import type * as schema from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import {backlinks, mirrors, nodeContent, nodeMetadata, referencesRoots, virtualRootIds} from "../db/schema.js";
import {stripHtmlTags} from "../html/strip-tags.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import type {Node} from "../types/node.js";
import type {WorkflowyNode} from "../types/workflowy.js";
import {uuidToShortId} from "../workflowy/constants.js";
import {and, eq, inArray, isNull, like, notExists, notInArray, or, sql} from "drizzle-orm";
import {
	contentMatches,
	currentVersion,
	keepSkewedTimestamps,
	metadataMatches,
	normalizeLayoutMode,
	systemFromToDate,
} from "./cache-temporal.js";
import {recordItemRelationships, upstreamRelationshipMetadata} from "./item-relationships.js";
import type {ItemRelationships, UpstreamRelationshipMetadata} from "./item-relationships.js";
import {loadMirrorOriginals, notAMirror} from "./mirror-text.js";
import {endNodeComposites, runUnitOfWork} from "./node-composite.js";
import {NodeReader} from "./node-reader.js";
import {newSystemTimestamp} from "./system-time.js";
import {closeCurrentVersions} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

type NodeMetadataRow = typeof schema.nodeMetadata.$inferSelect;

/**
 * Drizzle types a `one()` relation on non-null columns as always present, but a
 * node can lack a current metadata row, so the relation is really nullable.
 */
function metadataOf(row: {metadata: NodeMetadataRow}): NodeMetadataRow | null {
	return row.metadata;
}

/** Sort siblings by priority, then createdAt, treating missing metadata as 0. */
function compareByMetadata(a: {metadata: NodeMetadataRow}, b: {metadata: NodeMetadataRow}): number {
	const metadataA = metadataOf(a);
	const metadataB = metadataOf(b);
	const priorityA = metadataA?.priority ?? 0;
	const priorityB = metadataB?.priority ?? 0;
	if (priorityA !== priorityB) {
		return priorityA - priorityB;
	}
	const createdAtA = metadataA?.createdAt?.getTime() ?? 0;
	const createdAtB = metadataB?.createdAt?.getTime() ?? 0;
	return createdAtA - createdAtB;
}

/** The cached note: Workflowy sends an empty note as "", which the cache stores as null. */
function noteOrNull(note: string | null | undefined): string | null {
	return note === undefined || note === null || note === "" ? null : note;
}

/** The Node metadata fields, each null when the node has no metadata row. */
function metadataFields(metadata: NodeMetadataRow | null) {
	return {
		shortId: metadata?.shortId ?? null,
		priority: metadata?.priority ?? null,
		createdAt: metadata?.createdAt ?? null,
		modifiedAt: metadata?.modifiedAt ?? null,
		completedAt: metadata?.completedAt ?? null,
		layoutMode: metadata?.layoutMode ?? null,
	};
}

/**
 * Type for a node with all related data from a Drizzle query with relations.
 * This is the raw result type returned by getChildrenWithMergedData.
 *
 * Distinct from the canonical `Node` DTO: it carries the joined relation
 * tables (mirrors, backlinks, calendar, etc.) that the canonical type
 * deliberately excludes, and keeps `priority` nullable as stored in the DB.
 */
export interface NodeWithRelations {
	id: string;
	shortId: string | null;
	name: string | null;
	note: string | null;
	parentId: string | null;
	priority: number | null;
	createdAt: Date | null;
	modifiedAt: Date | null;
	completedAt: Date | null;
	layoutMode: string | null;
	systemFrom: string;
	systemTo: string;
	// Mirrors where this node is the original (other nodes mirror this one)
	mirrorsAsOriginal?: {mirrorId: string}[];
	// Mirrors where this node is the copy (this node mirrors others)
	mirrorsAsCopy?: {originalId: string}[];
	backlinks?: {sourceId: string; targetId: string}[];
	virtualRootIds?: {virtualRootId: string}[];
	aiMetadata?: {inChat: number} | null;
	s3File?: {
		fileName: string;
		fileType: string;
		objectFolder: string | null;
		isAnimatedGif: number | null;
		imageOriginalWidth: number | null;
		imageOriginalHeight: number | null;
		imageOriginalPixels: number | null;
		isDeleted: number | null;
	} | null;
	changesMetadata?: {ctBy: number} | null;
	referencesRoot?: {nodeId: string} | null;
	calendar?: {
		root: number | null;
		level: string | null;
		value: string | null;
		dateId: number | null;
		timestamp: number | null;
		foundDates: number | null;
		dayPrefix: number | null;
		levels?: {
			day: number | null;
			week: number | null;
			month: number | null;
			year: number | null;
		} | null;
	} | null;
}

/** Options for {@link CacheService.searchText}. */
export interface TextSearchOptions {
	query: string;
	limit?: number;
	incomplete?: boolean;
}

/** A single text-search hit: the matched node's identity and content. */
export interface TextSearchRow {
	id: string;
	shortId: string | null;
	name: string | null;
	note: string | null;
	completedAt: Date | null;
}

/** Convert Unix seconds to a Date, passing null and undefined through as null. */
function timestampToDate(timestamp: number | null | undefined): Date | null {
	return timestamp === null || timestamp === undefined ? null : new Date(timestamp * 1000);
}

function insertContent(
	db: TemporalTransaction,
	node: WorkflowyNode,
	parentId: string | null,
	systemFrom: string,
): void {
	db.insert(nodeContent)
		.values({
			id: node.id,
			name: node.name,
			note: noteOrNull(node.note),
			parentId,
			systemFrom,
			systemTo: FAR_FUTURE_DATE,
		})
		.run();
}

/**
 * Insert a current node_metadata row for `node`. When `existing` is the version
 * being replaced, its timestamps win over incoming ones within the one-second skew.
 */
function insertMetadata(
	db: TemporalTransaction,
	node: WorkflowyNode,
	systemFrom: string,
	existing?: NodeMetadataRow,
): void {
	const timestamps = {
		createdAt: timestampToDate(node.createdAt),
		modifiedAt: timestampToDate(node.modifiedAt),
		completedAt: timestampToDate(node.completedAt),
	};
	db.insert(nodeMetadata)
		.values({
			nodeId: node.id,
			shortId: uuidToShortId(node.id),
			priority: node.priority,
			...(existing ? keepSkewedTimestamps(existing, timestamps) : timestamps),
			layoutMode: normalizeLayoutMode(node.data?.layoutMode),
			systemFrom,
			systemTo: FAR_FUTURE_DATE,
		})
		.run();
}

/**
 * Write one API node's content and metadata rows as current versions at `systemTime`.
 *
 * A node not yet cached gets fresh rows in both tables. For a cached node, each table
 * is versioned independently: its current row is closed and a new one opened only when
 * the API data differs, so an unchanged node leaves no history behind.
 */
function upsertNodeVersion(
	db: TemporalTransaction,
	node: WorkflowyNode,
	parentId: string | null,
	systemTime: string,
): void {
	const existingContent = db
		.select()
		.from(nodeContent)
		.where(and(eq(nodeContent.id, node.id), currentVersion(nodeContent)))
		.get();

	if (!existingContent) {
		insertContent(db, node, parentId, systemTime);
		insertMetadata(db, node, systemTime);
		return;
	}

	if (!contentMatches(existingContent, {name: node.name, note: noteOrNull(node.note), parentId})) {
		closeCurrentVersions(db, nodeContent, systemTime, eq(nodeContent.id, node.id));
		insertContent(db, node, parentId, systemTime);
	}

	const existingMetadata = db
		.select()
		.from(nodeMetadata)
		.where(and(eq(nodeMetadata.nodeId, node.id), currentVersion(nodeMetadata)))
		.get();
	const metadata = {
		priority: node.priority,
		createdAt: node.createdAt,
		modifiedAt: node.modifiedAt,
		completedAt: node.completedAt ?? null,
		layoutMode: normalizeLayoutMode(node.data?.layoutMode),
	};
	if (existingMetadata && !metadataMatches(existingMetadata, metadata)) {
		closeCurrentVersions(db, nodeMetadata, systemTime, eq(nodeMetadata.nodeId, node.id));
		insertMetadata(db, node, systemTime, existingMetadata);
	}
}

/**
 * Store one parent's full child list as the API returned it, at `systemTime`:
 * upsert each child, then phase out cached children missing from the list.
 * A parent missing from the cache gets a blank placeholder row.
 */
function storeChildren(
	tx: TemporalTransaction,
	apiNodes: WorkflowyNode[],
	parentId: string | null,
	systemTime: string,
): void {
	if (parentId !== null) {
		const parentExists = tx
			.select({id: nodeContent.id})
			.from(nodeContent)
			.where(and(eq(nodeContent.id, parentId), currentVersion(nodeContent)))
			.get();
		if (!parentExists) {
			tx.insert(nodeContent)
				.values({
					id: parentId,
					name: null,
					note: null,
					parentId: null,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				})
				.run();
			tx.insert(nodeMetadata)
				.values({
					nodeId: parentId,
					shortId: uuidToShortId(parentId),
					priority: null,
					createdAt: null,
					modifiedAt: null,
					completedAt: null,
					layoutMode: null,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				})
				.run();
		}
	}

	// The public API carries none of the node's attribute tables (mirrors, backlinks,
	// virtual roots, references roots, ai, s3, changes), so closing them here would be
	// permanent data loss, not a refresh (#1712). import-api's /get_tree_data/ merge,
	// backup imports and deleteNode() own their lifecycle.
	for (const apiNode of apiNodes) {
		upsertNodeVersion(tx, apiNode, parentId, systemTime);
	}

	if (parentId === null) {
		return;
	}
	// Phase out cached children that are no longer in the API response (deleted nodes):
	// the third leg of the merge list pattern. nodeMetadata has no parentId, so scope its
	// phase-out to this parent's children via a subquery against nodeContent, and run it
	// FIRST, while those content rows still hold the current version the subquery matches on.
	const apiNodeIds = apiNodes.map((n) => n.id);
	const metadataUnderParent = sql`${nodeMetadata.nodeId} IN (
		SELECT id FROM node_content WHERE parent_id = ${parentId} AND system_to = ${FAR_FUTURE_DATE}
	)`;
	const keptMetadata = apiNodeIds.length > 0 ? notInArray(nodeMetadata.nodeId, apiNodeIds) : undefined;
	const keptContent = apiNodeIds.length > 0 ? notInArray(nodeContent.id, apiNodeIds) : undefined;
	closeCurrentVersions(tx, nodeMetadata, systemTime, and(keptMetadata, metadataUnderParent));
	closeCurrentVersions(tx, nodeContent, systemTime, and(eq(nodeContent.parentId, parentId), keptContent));
}

/** A backlink item: a mirror of `sourceId` under `targetId`'s references root. */
export interface BacklinkItem {
	nodeId: string;
	sourceId: string;
	targetId: string;
}

/** What one backlink sync changed upstream, for {@link CacheService.recordBacklinkSync}. */
export interface BacklinkSyncRecord {
	/** Each changed parent's full child list, read back from the API; parents before their new children. */
	children: {parentId: string; nodes: WorkflowyNode[]}[];
	/** References roots created. */
	referencesRoots: string[];
	/** Backlink items created. */
	backlinks: BacklinkItem[];
	/** Backlink items deleted. */
	deleted: string[];
}

/** The cached subtree under a node, as {@link CacheService.getSubtreeMirrors} returns it. */
export interface SubtreeMirrors {
	/** Each node below the root mapped to its parent, in breadth-first order. */
	parents: Map<string, string>;
	/** The mirror nodes in the subtree, in breadth-first order. */
	inside: string[];
	/**
	 * The current mirrors, sorted by id, of each non-mirror node in the subtree
	 * (the root included) that has any, keyed in breadth-first order. Mirrors
	 * may lie inside or outside the subtree; only cached mirror nodes count, and
	 * backlink items (mirrors with a current backlink row) never do.
	 */
	mirrorsOf: Map<string, string[]>;
}

export class CacheService {
	protected database: AppDatabase;
	protected nodeReader: NodeReader;

	constructor(database: AppDatabase) {
		this.database = database;
		this.nodeReader = new NodeReader(database);
	}

	getNode(nodeId: string): Node | undefined {
		return this.nodeReader.getById(nodeId) ?? undefined;
	}

	getMultipleNodes(nodeIds: string[]): Map<string, Node> {
		return this.nodeReader.getMany(nodeIds);
	}

	getChildren(parentId: string | null): Node[] {
		return this.nodeReader.getChildren(parentId);
	}

	/**
	 * Get a single child node by exact name match.
	 * @param parentId The parent ID (null for root nodes)
	 * @param name The exact name to match
	 */
	getChildByName(parentId: string | null, name: string): Node | null {
		const children = this.nodeReader.getChildren(parentId);
		// Names may carry inline HTML formatting (e.g. a colored <span> around
		// "Personal"). Callers pass plain-text path segments, so fall back to a
		// tag-stripped comparison when the raw name does not match exactly.
		return children.find((child) => child.name === name || stripHtmlTags(child.name) === name) ?? null;
	}

	/**
	 * Get node with cache timestamp
	 */
	getNodeWithMergedData(nodeId: string): {
		node: Node | undefined;
		source: "cache" | "none";
		fetchedAt?: Date;
	} {
		const node = this.getNode(nodeId);
		if (!node) {
			return {node: undefined, source: "none"};
		}

		return {
			node,
			source: "cache",
			fetchedAt: systemFromToDate(node.systemFrom),
		};
	}

	/**
	 * Get children with all related data from cache.
	 * Returns raw Drizzle query results with joined relations.
	 */
	getChildrenWithMergedData(parentId: string | null): NodeWithRelations[] {
		const whereClause =
			parentId === null
				? and(isNull(nodeContent.parentId), currentVersion(nodeContent))
				: and(eq(nodeContent.parentId, parentId), currentVersion(nodeContent));

		const results = this.database.query.nodeContent
			.findMany({
				where: whereClause,
				with: {
					metadata: true,
					mirrorsAsOriginal: {
						where: currentVersion(mirrors),
					},
					mirrorsAsCopy: {
						where: currentVersion(mirrors),
					},
					backlinks: {
						where: currentVersion(backlinks),
					},
					virtualRootIds: {
						where: currentVersion(virtualRootIds),
					},
					aiMetadata: true,
					s3File: true,
					changesMetadata: true,
					referencesRoot: true,
					calendar: {
						columns: {
							root: true,
							level: true,
							value: true,
							dateId: true,
							timestamp: true,
							foundDates: true,
							dayPrefix: true,
						},
						with: {
							levels: true,
						},
					},
				},
			})
			.sync();

		// Sort by priority and createdAt (metadata fields)
		results.sort(compareByMetadata);

		// Transform nodeContent results to Node format
		return results.map((result) => ({
			id: result.id,
			name: result.name,
			note: result.note,
			parentId: result.parentId,
			...metadataFields(metadataOf(result)),
			systemFrom: result.systemFrom,
			systemTo: result.systemTo,
			mirrorsAsOriginal: result.mirrorsAsOriginal,
			mirrorsAsCopy: result.mirrorsAsCopy,
			backlinks: result.backlinks,
			virtualRootIds: result.virtualRootIds,
			aiMetadata: result.aiMetadata,
			s3File: result.s3File,
			changesMetadata: result.changesMetadata,
			referencesRoot: result.referencesRoot,
			calendar: result.calendar,
		}));
	}

	/**
	 * Substring-search node names and notes, returning the current version of each
	 * matching node. The single text-search primitive behind both the CLI `node
	 * search` command and the MCP `workflowy_search` tool; each adapter formats the
	 * rows its own way (CLI adds a path, MCP a URL).
	 */
	searchText(options: TextSearchOptions): TextSearchRow[] {
		const {query, limit = 20, incomplete = false} = options;
		const pattern = `%${query}%`;

		const conditions = [
			currentVersion(nodeContent),
			notAMirror(nodeContent.id),
			or(like(nodeContent.name, pattern), like(nodeContent.note, pattern)),
		];
		if (incomplete) {
			conditions.push(isNull(nodeMetadata.completedAt));
		}

		return this.database
			.select({
				id: nodeContent.id,
				name: nodeContent.name,
				note: nodeContent.note,
				shortId: nodeMetadata.shortId,
				completedAt: nodeMetadata.completedAt,
			})
			.from(nodeContent)
			.innerJoin(nodeMetadata, and(eq(nodeContent.id, nodeMetadata.nodeId), currentVersion(nodeMetadata)))
			.where(and(...conditions))
			.limit(limit)
			.all();
	}

	/**
	 * Get the joined-relation rows for a specific set of node IDs (any parents),
	 * in the same shape as {@link getChildrenWithMergedData}. Used to seed a
	 * subtree read from arbitrary root nodes rather than from a single parent.
	 */
	getMergedDataForNodes(nodeIds: string[]): NodeWithRelations[] {
		if (nodeIds.length === 0) {
			return [];
		}

		const results = this.database.query.nodeContent
			.findMany({
				where: and(inArray(nodeContent.id, nodeIds), currentVersion(nodeContent)),
				with: {
					metadata: true,
					mirrorsAsOriginal: {where: currentVersion(mirrors)},
					mirrorsAsCopy: {where: currentVersion(mirrors)},
					backlinks: {where: currentVersion(backlinks)},
					virtualRootIds: {where: currentVersion(virtualRootIds)},
					aiMetadata: true,
					s3File: true,
					changesMetadata: true,
					referencesRoot: true,
					calendar: {
						columns: {
							root: true,
							level: true,
							value: true,
							dateId: true,
							timestamp: true,
							foundDates: true,
							dayPrefix: true,
						},
						with: {levels: true},
					},
				},
			})
			.sync();

		return results.map((result) => ({
			id: result.id,
			name: result.name,
			note: result.note,
			parentId: result.parentId,
			...metadataFields(metadataOf(result)),
			systemFrom: result.systemFrom,
			systemTo: result.systemTo,
			mirrorsAsOriginal: result.mirrorsAsOriginal,
			mirrorsAsCopy: result.mirrorsAsCopy,
			backlinks: result.backlinks,
			virtualRootIds: result.virtualRootIds,
			aiMetadata: result.aiMetadata,
			s3File: result.s3File,
			changesMetadata: result.changesMetadata,
			referencesRoot: result.referencesRoot,
			calendar: result.calendar,
		}));
	}

	/**
	 * Store API response data for nodes
	 * @param apiNodes Array of nodes from the API
	 * @param parentId The parent ID these nodes belong to (null for root)
	 */
	storeApiResponse(apiNodes: WorkflowyNode[], parentId: string | null): void {
		runUnitOfWork(this.database, ({tx, systemTime}) => {
			storeChildren(tx, apiNodes, parentId, systemTime);
		});
	}

	/** {@link storeApiResponse} for several parents, as one unit of work: one transaction and one system time. */
	storeApiResponses(batches: {nodes: WorkflowyNode[]; parentId: string | null}[]): void {
		runUnitOfWork(this.database, ({tx, systemTime}) => {
			for (const {nodes, parentId} of batches) {
				storeChildren(tx, nodes, parentId, systemTime);
			}
		});
	}

	/**
	 * Record a backlink sync the server accepted, as one unit of work at one
	 * system time: deleted backlink items end their whole composite, the
	 * changed parents' children are replaced, and each created references root
	 * and backlink item gets its `references_roots`, `backlinks` and `mirrors`
	 * row.
	 */
	recordBacklinkSync(record: BacklinkSyncRecord): void {
		runUnitOfWork(this.database, (unitOfWork) => {
			const {tx, systemTime} = unitOfWork;
			endNodeComposites(unitOfWork, record.deleted);
			for (const {parentId, nodes} of record.children) {
				storeChildren(tx, nodes, parentId, systemTime);
			}
			const current = {systemFrom: systemTime, systemTo: FAR_FUTURE_DATE};
			for (const nodeId of record.referencesRoots) {
				tx.insert(referencesRoots)
					.values({nodeId, ...current})
					.run();
			}
			for (const {nodeId, sourceId, targetId} of record.backlinks) {
				tx.insert(backlinks)
					.values({nodeId, sourceId, targetId, ...current})
					.run();
				tx.insert(mirrors)
					.values({mirrorId: nodeId, originalId: sourceId, ...current})
					.run();
			}
		});
	}

	/**
	 * Insert a newly created node into the cache without affecting siblings.
	 * Use this for node creation operations where we're adding a single node
	 * and should NOT phase out existing siblings.
	 *
	 * This differs from storeApiResponse() which is designed for bulk sync operations
	 * where the API returns the complete list of children and we need to phase out
	 * any cached children that no longer exist.
	 *
	 * @param node The newly created node from the API
	 * @param parentId The parent ID this node belongs to (null for root)
	 */
	insertNode(node: WorkflowyNode, parentId: string | null): void {
		runUnitOfWork(this.database, ({tx, systemTime}) => {
			upsertNodeVersion(tx, node, parentId, systemTime);
		});
	}

	/**
	 * Delete a node and all its descendants from the cache using temporal pattern.
	 * This closes the records by setting systemTo to the current timestamp.
	 * @param nodeId The node ID to delete
	 */
	deleteNode(nodeId: string): void {
		// Collect all descendant IDs iteratively (BFS)
		const descendantIds: string[] = [nodeId];
		// for-of over an array visits elements pushed during the loop, so this walks every level.
		for (const parentId of descendantIds) {
			const children = this.database
				.select({id: nodeContent.id})
				.from(nodeContent)
				.where(and(eq(nodeContent.parentId, parentId), currentVersion(nodeContent)))
				.all();
			for (const child of children) {
				descendantIds.push(child.id);
			}
		}

		// A genuine deletion ends each node's whole composite (content, metadata and
		// every owned part) in one unit of work. Rows of surviving nodes that merely
		// reference a deleted node are left alone, except mirror rows, which close
		// when either side dies.
		runUnitOfWork(this.database, (unitOfWork) => {
			endNodeComposites(unitOfWork, descendantIds);
		});
	}

	/**
	 * Promote an original into its mirror's slot, as one unit of work: the
	 * mirror's composite ends (with its mirror row) and the original gets a new
	 * version under `parentId`, all at one system time.
	 * @param mirrorId The mirror removed upstream
	 * @param original The original as Workflowy returns it after the move
	 * @param parentId The parent the original now sits under
	 */
	promoteOriginal(mirrorId: string, original: WorkflowyNode, parentId: string | null): void {
		runUnitOfWork(this.database, (unitOfWork) => {
			endNodeComposites(unitOfWork, [mirrorId]);
			upsertNodeVersion(unitOfWork.tx, original, parentId, unitOfWork.systemTime);
		});
	}

	/**
	 * Find a node by path using cached data.
	 * Uses exact name matching with targeted SQL queries per path segment.
	 * @param path Array of exact node names to traverse
	 * @param rootId Optional root node ID to start from
	 */
	findNodeByPath(path: string[], rootId: string | null = null): Node | null {
		if (path.length === 0) {
			if (rootId) {
				const node = this.getNode(rootId);
				return node ?? null;
			}
			return null;
		}

		let currentParentId = rootId;

		for (const segment of path) {
			const matchingChild = this.getChildByName(currentParentId, segment);

			if (!matchingChild) {
				return null;
			}

			if (segment === path.at(-1)) {
				return matchingChild;
			}

			// A mirror's children live under its original.
			currentParentId = matchingChild.mirror.originalNodeId ?? matchingChild.id;
		}

		return null;
	}

	/**
	 * Get children for multiple parent IDs in a single query.
	 * Returns a Map from parentId to array of NodeWithRelations.
	 * This is more efficient than calling getChildrenWithMergedData multiple times.
	 */
	getChildrenForMultipleParents(parentIds: string[]): Map<string, NodeWithRelations[]> {
		if (parentIds.length === 0) {
			return new Map();
		}

		const children = this.database.query.nodeContent
			.findMany({
				where: and(inArray(nodeContent.parentId, parentIds), currentVersion(nodeContent)),
				with: {
					metadata: true,
					mirrorsAsOriginal: {
						where: currentVersion(mirrors),
					},
					mirrorsAsCopy: {
						where: currentVersion(mirrors),
					},
					backlinks: {
						where: currentVersion(backlinks),
					},
					virtualRootIds: {
						where: currentVersion(virtualRootIds),
					},
					aiMetadata: true,
					s3File: true,
					changesMetadata: true,
					referencesRoot: true,
					calendar: {
						columns: {
							root: true,
							level: true,
							value: true,
							dateId: true,
							timestamp: true,
							foundDates: true,
							dayPrefix: true,
						},
						with: {
							levels: true,
						},
					},
				},
			})
			.sync();

		// Sort in-memory since orderBy can't reference joined relation columns
		children.sort(compareByMetadata);

		const resultMap = new Map<string, NodeWithRelations[]>();

		for (const parentId of parentIds) {
			resultMap.set(parentId, []);
		}

		for (const child of children) {
			const {parentId} = child;
			if (!parentId) {
				continue;
			}

			const existingList = resultMap.get(parentId);
			if (existingList) {
				// Transform to NodeWithRelations format
				existingList.push({
					id: child.id,
					name: child.name,
					note: child.note,
					parentId: child.parentId,
					...metadataFields(metadataOf(child)),
					systemFrom: child.systemFrom,
					systemTo: child.systemTo,
					mirrorsAsOriginal: child.mirrorsAsOriginal,
					mirrorsAsCopy: child.mirrorsAsCopy,
					backlinks: child.backlinks,
					virtualRootIds: child.virtualRootIds,
					aiMetadata: child.aiMetadata,
					s3File: child.s3File,
					changesMetadata: child.changesMetadata,
					referencesRoot: child.referencesRoot,
					calendar: child.calendar,
				});
			}
		}

		return resultMap;
	}

	/**
	 * Resolve a short_id (12 hex chars from Workflowy URL) to a full UUID.
	 * Returns null if no matching node is found.
	 */
	resolveShortIdToUuid(shortId: string): string | null {
		const result = this.database.query.nodeMetadata
			.findFirst({
				where: and(eq(nodeMetadata.shortId, shortId), currentVersion(nodeMetadata)),
				columns: {nodeId: true},
			})
			.sync();
		return result?.nodeId ?? null;
	}

	/**
	 * Resolve multiple short_ids to full UUIDs in a single query.
	 * Returns a Map from short_id to full UUID.
	 */
	resolveMultipleShortIds(shortIds: string[]): Map<string, string> {
		if (shortIds.length === 0) {
			return new Map();
		}

		const results = this.database.query.nodeMetadata
			.findMany({
				where: and(inArray(nodeMetadata.shortId, shortIds), currentVersion(nodeMetadata)),
				columns: {nodeId: true, shortId: true},
			})
			.sync();

		const map = new Map<string, string>();
		for (const result of results) {
			if (result.shortId) {
				map.set(result.shortId, result.nodeId);
			}
		}
		return map;
	}

	/**
	 * Record the mirror, backlink and references-root rows an accepted push
	 * created, as one unit of work at one system time. Rows already current
	 * are left alone.
	 */
	recordRelationships(relationships: ItemRelationships): void {
		runUnitOfWork(this.database, (unitOfWork) => {
			recordItemRelationships(unitOfWork, relationships);
		});
	}

	/** Each node's upstream `mirror`/`backlink`/`isReferencesRoot` view, rebuilt from the edge tables. */
	relationshipMetadata(nodeIds: readonly string[]): Map<string, UpstreamRelationshipMetadata> {
		return upstreamRelationshipMetadata(this.database, nodeIds);
	}

	/**
	 * Record that mirrorId is a live mirror of originalId. Mirrors are otherwise
	 * sourced only from backup imports; this is the write-through path for a
	 * mirror the CLI just created.
	 */
	insertMirror(originalId: string, mirrorId: string): void {
		this.database
			.insert(mirrors)
			.values({
				originalId,
				mirrorId,
				systemFrom: newSystemTimestamp(),
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
	}

	/**
	 * The cached subtree under `nodeId` as a delete plans it (see
	 * {@link SubtreeMirrors}). Children are walked breadth-first, siblings in
	 * priority order then by id, and the walk stops at each mirror: a mirror's
	 * own children live under its original.
	 */
	getSubtreeMirrors(nodeId: string): SubtreeMirrors {
		const chunkSize = 10_000;
		const parents = new Map<string, string>();
		const inside: string[] = [];
		const nonMirrorIds: string[] = [nodeId];
		let level = [nodeId];
		while (level.length > 0) {
			const levelIndex = new Map(level.map((id, index) => [id, index]));
			const rows: {id: string; parentId: string; levelIndex: number; priority: number}[] = [];
			for (let i = 0; i < level.length; i += chunkSize) {
				const chunk = this.database
					.select({id: nodeContent.id, parentId: nodeContent.parentId, priority: nodeMetadata.priority})
					.from(nodeContent)
					.leftJoin(nodeMetadata, and(eq(nodeMetadata.nodeId, nodeContent.id), currentVersion(nodeMetadata)))
					.where(
						and(inArray(nodeContent.parentId, level.slice(i, i + chunkSize)), currentVersion(nodeContent)),
					)
					.all();
				for (const row of chunk) {
					// The WHERE clause matched parentId against this level, so both lookups succeed.
					const parentIndex = row.parentId === null ? undefined : levelIndex.get(row.parentId);
					if (row.parentId === null || parentIndex === undefined) {
						throw new Error(`Subtree row ${row.id} has a parent outside the current level`);
					}
					rows.push({
						id: row.id,
						parentId: row.parentId,
						levelIndex: parentIndex,
						priority: row.priority ?? 0,
					});
				}
			}
			rows.sort((a, b) => a.levelIndex - b.levelIndex || a.priority - b.priority || a.id.localeCompare(b.id));
			for (const row of rows) {
				parents.set(row.id, row.parentId);
			}
			const childIds = rows.map((row) => row.id);
			const childMirrors = loadMirrorOriginals(this.database, childIds);
			level = childIds.filter((id) => !childMirrors.has(id));
			inside.push(...childIds.filter((id) => childMirrors.has(id)));
			nonMirrorIds.push(...level);
		}

		const mirrorIds = new Map<string, string[]>();
		for (let i = 0; i < nonMirrorIds.length; i += chunkSize) {
			const rows = this.database
				.select({originalId: mirrors.originalId, mirrorId: mirrors.mirrorId})
				.from(mirrors)
				.innerJoin(nodeContent, and(eq(nodeContent.id, mirrors.mirrorId), currentVersion(nodeContent)))
				.where(
					and(
						inArray(mirrors.originalId, nonMirrorIds.slice(i, i + chunkSize)),
						currentVersion(mirrors),
						// A backlink item mirrors its source but is never a promotion target:
						// deleting the source leaves the item in place, as upstream does.
						notExists(
							this.database
								.select({nodeId: backlinks.nodeId})
								.from(backlinks)
								.where(and(eq(backlinks.nodeId, mirrors.mirrorId), currentVersion(backlinks))),
						),
					),
				)
				.all();
			for (const row of rows) {
				mirrorIds.set(row.originalId, [...(mirrorIds.get(row.originalId) ?? []), row.mirrorId]);
			}
		}
		const mirrorsOf = new Map<string, string[]>();
		for (const id of nonMirrorIds) {
			const ids = mirrorIds.get(id);
			if (ids !== undefined) {
				mirrorsOf.set(id, ids.toSorted());
			}
		}
		return {parents, inside, mirrorsOf};
	}

	/**
	 * Get the original node ID for a mirror node.
	 * Returns null if the node is not a mirror or not found.
	 */
	getMirrorOriginal(mirrorId: string): string | null {
		const result = this.database
			.select({originalId: mirrors.originalId})
			.from(mirrors)
			.where(and(eq(mirrors.mirrorId, mirrorId), currentVersion(mirrors)))
			.get();
		return result?.originalId ?? null;
	}
}
