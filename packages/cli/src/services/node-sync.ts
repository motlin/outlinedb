import type {InternalTreeItem, WorkflowyApiClient} from "@outlinedb/shared/api";
import
{
	applyRows,
	collectItemRelationships,
	emptyItemRelationships,
	mergeItemRelationships,
	runUnitOfWork,
} from "@outlinedb/shared/cache";
import {nodeContent} from "@outlinedb/shared/db";
import type * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {eq} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {CacheService} from "./cache.js";
import {nonEmpty} from "../utils/non-empty.js";

export interface NodeSyncStats
{
	syncedCount: number;
}

export interface NodeSyncProgress
{
	phase: "syncing";
	nodeId: string | null;
	childCount: number;
	message?: string;
}

export interface NodeSyncOptions
{
	nodeId: string | null;
	recursive: boolean;
	onProgress?: (progress: NodeSyncProgress) => void;
}

/** Where a sync reads the internal `/get_tree_data/` items, whose metadata carries the relationships the public API omits. */
export interface RelationshipSource
{
	database: BetterSQLite3Database<typeof schema>;
	/** The tree items, or undefined when the internal API is not configured. */
	treeData: () => Promise<InternalTreeItem[] | undefined>;
}

/**
 * Merge the mirrors (backlink items included) and references roots in `treeItems` into the cache, through the
 * same normalizer as `cache import-api`. Only nodes the cache holds take part, so a partial sync neither
 * invents rows for uncached nodes nor closes rows whose nodes it knows nothing about.
 */
function mergeSyncedRelationships(database: BetterSQLite3Database<typeof schema>, treeItems: InternalTreeItem[]): void
{
	const live = new Set(
		database
			.select(
				{
					id: nodeContent.id,
				},
			)
			.from(nodeContent)
			.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
			.all()
			.map((row) => row.id),
	);
	const relationships = emptyItemRelationships();
	for (const item of treeItems)
	{
		collectItemRelationships(relationships, item.id, item.metadata);
	}
	runUnitOfWork(database, (unitOfWork) =>
	{
		applyRows(
			unitOfWork,
			{
				referencesRoots: relationships.referencesRoots.filter((row) => live.has(row.nodeId)),
			},
		);
		mergeItemRelationships(unitOfWork, relationships, live);
	});
}

export class NodeSyncService
{
	constructor(
		private readonly apiClient: WorkflowyApiClient,
		private readonly cacheService: CacheService,
		private readonly relationships?: RelationshipSource,
	)
	{
	}

	async syncNode(options: NodeSyncOptions): Promise<NodeSyncStats>
	{
		let syncedCount = 0;

		const syncRecursive = async (nodeId: string | null, parentId: string | null, recursive: boolean) =>
		{
			const nodes: WorkflowyNode[] =
				nodeId === null ? await this.apiClient.getRootNodes() : await this.apiClient.getChildNodes(nodeId);

			this.cacheService.storeApiResponse(nodes, nodeId);
			syncedCount += nodes.length;

			options.onProgress?.(
				{
					phase: "syncing",
					nodeId,
					childCount: nodes.length,
					message: `Synced ${nodes.length} children of ${nonEmpty(nodeId) ?? "root"}`,
				},
			);

			if (recursive)
			{
				for (const node of nodes)
				{
					await syncRecursive(node.id, nodeId, true);
				}
			}
		};

		await syncRecursive(options.nodeId, null, options.recursive);

		// Backlinks and references roots made on workflowy.com live only in the internal tree data.
		const treeItems = await this.relationships?.treeData();
		if (this.relationships !== undefined && treeItems !== undefined)
		{
			mergeSyncedRelationships(this.relationships.database, treeItems);
		}

		return {
			syncedCount,
		};
	}
}
