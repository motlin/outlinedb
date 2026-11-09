import type * as schema from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import {nodeContent} from "../db/schema.js";
import type {Node} from "../types/node.js";
import {and, eq, isNull} from "drizzle-orm";
import {currentVersion} from "./cache-temporal.js";
import {inIds} from "./in-ids.js";
import {applyMirrorText, loadMirrorOriginals} from "./mirror-text.js";

/**
 * Raw joined row shape returned by the nodeContent + nodeMetadata queries.
 */
type ContentWithMetadata = schema.NodeContentType & {
	metadata: schema.NodeMetadataType | null;
};

/**
 * Single read service for loading current nodes from the SQLite cache.
 *
 * `NodeReader` owns every "load current node(s) with relationships" query.
 * It is the only construction site for the canonical `Node` DTO. All
 * `FAR_FUTURE_DATE` temporal filtering and mirror relationship resolution
 * happens inside this class, so callers receive a fully-formed `Node`. A
 * mirror's name and note always come from its original; any text stored on
 * the mirror row itself is ignored.
 *
 * Derived per-query fields (`hasChildren`) deliberately stay off the `Node`
 * DTO — REST handlers compute those from a `Node` plus extra batched queries.
 */
export class NodeReader {
	private readonly database: AppDatabase;

	constructor(database: AppDatabase) {
		this.database = database;
	}

	/**
	 * Load a single current node by full UUID. Returns null when the node
	 * does not exist or has no current temporal record.
	 */
	getById(id: string): Node | null {
		const result = this.database.query.nodeContent
			.findFirst({
				where: and(eq(nodeContent.id, id), currentVersion(nodeContent)),
				with: {metadata: true},
			})
			.sync();
		if (!result) {
			return null;
		}
		return this.toNodes([result])[0] ?? null;
	}

	/**
	 * Load the current children of a parent node, ordered by priority then
	 * creation time. Pass null to load root-level nodes.
	 */
	getChildren(parentId: string | null): Node[] {
		const whereClause =
			parentId === null
				? and(isNull(nodeContent.parentId), currentVersion(nodeContent))
				: and(eq(nodeContent.parentId, parentId), currentVersion(nodeContent));

		const results = this.database.query.nodeContent
			.findMany({
				where: whereClause,
				with: {metadata: true},
			})
			.sync();

		return this.toNodes(results).toSorted((a, b) => {
			const priorityDifference = a.priority - b.priority;
			if (priorityDifference !== 0) {
				return priorityDifference;
			}
			const aTime = a.createdAt?.getTime() ?? 0;
			const bTime = b.createdAt?.getTime() ?? 0;
			return aTime - bTime;
		});
	}

	/**
	 * Load many current nodes by full UUID in a single query. Missing IDs are
	 * absent from the returned map.
	 */
	getMany(ids: string[]): Map<string, Node> {
		if (ids.length === 0) {
			return new Map();
		}

		const results = this.database.query.nodeContent
			.findMany({
				where: and(inIds(nodeContent.id, ids), currentVersion(nodeContent)),
				with: {metadata: true},
			})
			.sync();

		return new Map(this.toNodes(results).map((node) => [node.id, node]));
	}

	/**
	 * Construct `Node` DTOs for a batch of rows, giving each mirror its
	 * original's id and text.
	 */
	private toNodes(rows: ContentWithMetadata[]): Node[] {
		const mirrorOriginals = loadMirrorOriginals(
			this.database,
			rows.map((row) => row.id),
		);
		return applyMirrorText(this.database, rows, mirrorOriginals).map((row) =>
			this.toNode(row, mirrorOriginals.get(row.id) ?? null),
		);
	}

	/**
	 * Construct the canonical `Node` DTO from a joined content + metadata row.
	 */
	private toNode(row: ContentWithMetadata, mirrorOriginalId: string | null): Node {
		return {
			id: row.id,
			shortId: row.metadata?.shortId ?? null,
			parentId: row.parentId,
			name: row.name,
			note: row.note,
			priority: row.metadata?.priority ?? 0,
			layoutMode: row.metadata?.layoutMode ?? null,
			createdAt: row.metadata?.createdAt ?? null,
			modifiedAt: row.metadata?.modifiedAt ?? null,
			completedAt: row.metadata?.completedAt ?? null,
			collapsed: false,
			mirror: {
				isMirror: mirrorOriginalId !== null,
				originalNodeId: mirrorOriginalId,
			},
			systemFrom: row.systemFrom,
			systemTo: row.systemTo,
		};
	}
}
