import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import type * as schema from "@outlinedb/shared/db";
import {NodeReader} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {Node} from "@outlinedb/shared/types";
import {and, asc, eq, isNotNull} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {logger} from "./logger.js";

export class QueryHelpers {
	private readonly database: BetterSQLite3Database<typeof schema>;
	private readonly nodeReader: NodeReader;

	constructor(database: BetterSQLite3Database<typeof schema>) {
		this.database = database;
		this.nodeReader = new NodeReader(database);
	}

	/**
	 * Fetch a single node by ID
	 */
	getNodeById(id: string): Node | undefined {
		const result = this.nodeReader.getById(id) ?? undefined;
		logger.logSqlResult("getNodeById", result);
		return result;
	}

	/**
	 * Fetch children of a node ordered by priority, then createdAt
	 */
	getChildren(parentId: string | null): Node[] {
		const results = this.nodeReader.getChildren(parentId);
		logger.logSqlResult("getChildren", results);
		return results;
	}

	/**
	 * Find all nodes that have been completed
	 */
	getCompletedTasks(): Node[] {
		const completedRows = this.database
			.select({id: nodeMetadata.nodeId})
			.from(nodeContent)
			.innerJoin(
				nodeMetadata,
				and(eq(nodeContent.id, nodeMetadata.nodeId), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
			)
			.where(and(isNotNull(nodeMetadata.completedAt), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.orderBy(asc(nodeMetadata.completedAt))
			.all();
		const nodesById = this.nodeReader.getMany(completedRows.map((row) => row.id));
		const results = completedRows
			.map((row) => nodesById.get(row.id))
			.filter((node): node is Node => node !== undefined);
		logger.logSqlResult("getCompletedTasks", results);
		return results;
	}

	/**
	 * Traverse a path from root to find a specific node
	 * @param path Array of node names to traverse (e.g., ['Work', 'Journal', 'Archive'])
	 * @param rootId Optional root node ID to start from (null for absolute root)
	 */
	findNodeByPath(path: string[], rootId: string | null = null): Node | undefined {
		if (path.length === 0) {
			if (rootId) {
				return this.getNodeById(rootId);
			}
			return undefined;
		}

		let currentParentId = rootId;

		for (const segment of path) {
			const children = this.getChildren(currentParentId);
			logger.logSqlResult("findNodeByPath.children", children);

			// Using 'includes' because names might contain HTML tags
			const matchingChild = children.find(
				(child) => child.name !== null && child.name !== "" && child.name.includes(segment),
			);

			if (!matchingChild) {
				return undefined;
			}

			if (segment === path.at(-1)) {
				return matchingChild;
			}

			currentParentId = matchingChild.id;
		}

		return undefined;
	}
}
