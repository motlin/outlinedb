import type {AppDatabase} from "../db/types.js";
import {nodeContent} from "../db/schema.js";
import {stripHtmlTags} from "../html/strip-tags.js";
import {and} from "drizzle-orm";
import {currentVersion} from "./cache-temporal.js";
import {inIds} from "./in-ids.js";
import {withMirrorText} from "./mirror-text.js";

interface NodeInfo {
	name: string | null;
	parentId: string | null;
}

/**
 * Builds ancestor paths, plain-text content, and leaf/non-leaf classification for
 * nodes, using level-by-level batched queries. A mirror's text comes from its
 * original. Shared by the CLI (path headers,
 * search enrichment, embeddings) and the web server (path enrichment) so ancestor
 * walking lives in one place.
 */
export class PathBuilder {
	private readonly database: AppDatabase;

	constructor(database: AppDatabase) {
		this.database = database;
	}

	/** A node's ancestor path, or "Home" for `null` (the top level). */
	buildFullPath(nodeId: string | null): string {
		if (nodeId === null) {
			return "Home";
		}
		const paths = this.buildFullPathsBatch([nodeId]);
		return paths.get(nodeId) ?? "";
	}

	/**
	 * Build the ancestor name-parts (root-first, blanks skipped) for multiple nodes
	 * using level-by-level batching, reducing O(nodes × depth) queries to O(depth).
	 *
	 * Algorithm:
	 * 1. Start with the set of node IDs we need paths for
	 * 2. Query all those nodes to get their names and parent IDs
	 * 3. Collect unique parent IDs not yet in our map
	 * 4. Repeat until we've reached all roots (no more new parents)
	 * 5. Reconstruct each path by walking the in-memory map
	 */
	buildFullPathPartsBatch(nodeIds: string[]): Map<string, string[]> {
		if (nodeIds.length === 0) {
			return new Map();
		}

		const nodeMap = new Map<string, NodeInfo>();
		let currentIds = [...new Set(nodeIds)];

		while (currentIds.length > 0) {
			const nextIds: string[] = [];

			const results = withMirrorText(
				this.database,
				this.database
					.select({
						id: nodeContent.id,
						name: nodeContent.name,
						note: nodeContent.note,
						parentId: nodeContent.parentId,
					})
					.from(nodeContent)
					.where(and(inIds(nodeContent.id, currentIds), currentVersion(nodeContent)))
					.all(),
			);

			for (const row of results) {
				if (!nodeMap.has(row.id)) {
					nodeMap.set(row.id, {
						name: row.name,
						parentId: row.parentId,
					});

					if (row.parentId && !nodeMap.has(row.parentId)) {
						nextIds.push(row.parentId);
					}
				}
			}

			currentIds = [...new Set(nextIds)];
		}

		const partsMap = new Map<string, string[]>();

		for (const nodeId of nodeIds) {
			const pathParts: string[] = [];
			let currentId: string | null = nodeId;

			while (currentId) {
				const info = nodeMap.get(currentId);
				if (!info) {
					break;
				}

				const name = stripHtmlTags(info.name ?? "");
				if (name) {
					pathParts.unshift(name);
				}

				currentId = info.parentId;
			}

			partsMap.set(nodeId, pathParts);
		}

		return partsMap;
	}

	/**
	 * Build full `' > '`-joined paths for multiple nodes.
	 */
	buildFullPathsBatch(nodeIds: string[]): Map<string, string> {
		const partsMap = this.buildFullPathPartsBatch(nodeIds);
		const pathMap = new Map<string, string>();
		for (const [id, parts] of partsMap) {
			pathMap.set(id, parts.join(" > "));
		}
		return pathMap;
	}

	buildTextContent(nodeId: string): string {
		const contents = this.buildTextContentBatch([nodeId]);
		return contents.get(nodeId) ?? "";
	}

	/**
	 * Build text content for multiple nodes.
	 */
	buildTextContentBatch(nodeIds: string[]): Map<string, string> {
		if (nodeIds.length === 0) {
			return new Map();
		}

		const contentMap = new Map<string, string>();

		const results = withMirrorText(
			this.database,
			this.database
				.select({
					id: nodeContent.id,
					name: nodeContent.name,
					note: nodeContent.note,
				})
				.from(nodeContent)
				.where(and(inIds(nodeContent.id, nodeIds), currentVersion(nodeContent)))
				.all(),
		);

		for (const node of results) {
			const name = stripHtmlTags(node.name ?? "");
			const note = node.note ? stripHtmlTags(node.note) : "";
			contentMap.set(node.id, note ? `${name}\n\n${note}` : name);
		}

		return contentMap;
	}

	/**
	 * Identify which nodes have children (are non-leaf nodes).
	 * Returns a Set of node IDs that have at least one child.
	 */
	getNonLeafNodeIds(nodeIds: string[]): Set<string> {
		if (nodeIds.length === 0) {
			return new Set();
		}

		const nonLeafIds = new Set<string>();

		// Find all nodes whose parentId is in nodeIds
		const results = this.database
			.selectDistinct({
				parentId: nodeContent.parentId,
			})
			.from(nodeContent)
			.where(and(inIds(nodeContent.parentId, nodeIds), currentVersion(nodeContent)))
			.all();

		for (const row of results) {
			if (row.parentId) {
				nonLeafIds.add(row.parentId);
			}
		}

		return nonLeafIds;
	}

	/**
	 * Build text content for direct children of multiple nodes.
	 * Returns a map of parent node ID to combined children text content.
	 * Only includes direct children (one level deep).
	 */
	buildChildrenTextBatch(parentIds: string[]): Map<string, string> {
		if (parentIds.length === 0) {
			return new Map();
		}

		const childrenMap = new Map<string, string[]>();

		const results = withMirrorText(
			this.database,
			this.database
				.select({
					id: nodeContent.id,
					parentId: nodeContent.parentId,
					name: nodeContent.name,
					note: nodeContent.note,
				})
				.from(nodeContent)
				.where(and(inIds(nodeContent.parentId, parentIds), currentVersion(nodeContent)))
				.all(),
		);

		for (const row of results) {
			if (!row.parentId) {
				continue;
			}

			const name = stripHtmlTags(row.name ?? "");
			const note = row.note ? stripHtmlTags(row.note) : "";
			const childText = note ? `${name}: ${note}` : name;

			let siblings = childrenMap.get(row.parentId);
			if (siblings === undefined) {
				siblings = [];
				childrenMap.set(row.parentId, siblings);
			}
			siblings.push(childText);
		}

		// Convert array of children texts to combined string
		const contentMap = new Map<string, string>();
		for (const [parentId, childTexts] of childrenMap) {
			contentMap.set(parentId, childTexts.join("\n"));
		}

		return contentMap;
	}
}
