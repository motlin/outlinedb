import {and, eq} from "drizzle-orm";
import {nodeContent} from "../db/schema.js";
import type {NodeContentType} from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {inIds} from "./in-ids.js";
import {notAMirror} from "./mirror-text.js";
import {PathBuilder} from "./path-builder.js";

/**
 * The current nodes worth indexing: those with children, excluding mirrors,
 * which have no text of their own (their original is indexed instead).
 */
export function loadEmbeddableNodes(database: AppDatabase, pathBuilder = new PathBuilder(database)): NodeContentType[]
{
	const currentNodes = database
		.select()
		.from(nodeContent)
		.where(and(eq(nodeContent.systemTo, FAR_FUTURE_DATE), notAMirror(nodeContent.id)))
		.all();
	const nonLeafIds = pathBuilder.getNonLeafNodeIds(currentNodes.map((n) => n.id));
	return currentNodes.filter((node) => nonLeafIds.has(node.id));
}

/** Which of `nodeIds` are embeddable (current containers that are not mirrors), in the order given. */
export function filterEmbeddable(
	database: AppDatabase,
	nodeIds: readonly string[],
	pathBuilder = new PathBuilder(database),
): string[]
{
	const current = new Set(
		database
			.select(
				{
					id: nodeContent.id,
				},
			)
			.from(nodeContent)
			.where(
				and(
					inIds(nodeContent.id, nodeIds),
					eq(nodeContent.systemTo, FAR_FUTURE_DATE),
					notAMirror(nodeContent.id),
				),
			)
			.all()
			.map((row) => row.id),
	);
	const nonLeafIds = pathBuilder.getNonLeafNodeIds([...current]);
	return nodeIds.filter((id) => current.has(id) && nonLeafIds.has(id));
}

/**
 * Each node's embedded document: its ancestor `PATH`, its own `CONTENT` (name and note) and, when it has any, its
 * direct `CHILDREN` as `name: note` lines. The CLI and the Worker embed exactly this text.
 */
export function buildEmbedTexts(
	database: AppDatabase,
	nodeIds: string[],
	pathBuilder = new PathBuilder(database),
): Map<string, string>
{
	const pathMap = pathBuilder.buildFullPathsBatch(nodeIds);
	const contentMap = pathBuilder.buildTextContentBatch(nodeIds);
	const childrenMap = pathBuilder.buildChildrenTextBatch(nodeIds);
	return new Map(
		nodeIds.map((id) =>
		{
			const fullPath = pathMap.get(id) ?? "";
			const textContent = contentMap.get(id) ?? "";
			const childrenText = childrenMap.get(id) ?? "";
			const text = childrenText
				? `PATH: ${fullPath}\nCONTENT: ${textContent}\nCHILDREN:\n${childrenText}`
				: `PATH: ${fullPath}\nCONTENT: ${textContent}`;
			return [id, text];
		}),
	);
}
