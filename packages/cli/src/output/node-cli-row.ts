import type {Node} from "@outlinedb/shared/types";

/**
 * CLI-facing serialization of a canonical {@link Node}.
 *
 * This is the JSON shape emitted by `node get`, `node list`, and `node search`.
 * It flattens the canonical type for display: temporal columns
 * (`systemFrom`/`systemTo`) are dropped, the nested `mirror` object is
 * flattened to `isMirror`/`originalNodeId`, `Date`s become ISO strings, and a
 * derived `completed` boolean is added alongside `completedAt`.
 */
export interface NodeCliRow {
	/** Full UUID of the node. */
	id: string;
	/** 12-character short ID from the Workflowy URL, or null if unknown. */
	shortId: string | null;
	/** Full UUID of the parent node, or null for root-level nodes. */
	parentId: string | null;
	/** Node text content, or null if blank. */
	name: string | null;
	/** Node note content, or null if absent. */
	note: string | null;
	/** Sibling ordering priority. */
	priority: number;
	/** Layout mode (e.g. bullets, board), or null for the default. */
	layoutMode: string | null;
	/** Creation timestamp as an ISO string, or null if unknown. */
	createdAt: string | null;
	/** Last-modified timestamp as an ISO string, or null if unknown. */
	modifiedAt: string | null;
	/** Completion timestamp as an ISO string, or null if not completed. */
	completedAt: string | null;
	/** Derived: whether the node is completed (`completedAt !== null`). */
	completed: boolean;
	/** Whether the node is collapsed in the UI. */
	collapsed: boolean;
	/** Whether this node is a mirror copy of another node. */
	isMirror: boolean;
	/** Full UUID of the original node this mirrors, or null. */
	originalNodeId: string | null;
}

/**
 * Convert a canonical {@link Node} into its CLI display row.
 *
 * Together with `nodeToRestDto`, this is one of the only two places in the
 * codebase where canonical-Node field shapes are converted for output. Any
 * future divergence between CLI and REST shapes should be a deliberate edit
 * here.
 */
export function nodeToCliRow(node: Node): NodeCliRow {
	return {
		id: node.id,
		shortId: node.shortId,
		parentId: node.parentId,
		name: node.name,
		note: node.note,
		priority: node.priority,
		layoutMode: node.layoutMode,
		createdAt: node.createdAt ? node.createdAt.toISOString() : null,
		modifiedAt: node.modifiedAt ? node.modifiedAt.toISOString() : null,
		completedAt: node.completedAt ? node.completedAt.toISOString() : null,
		completed: node.completedAt !== null,
		collapsed: node.collapsed,
		isMirror: node.mirror.isMirror,
		originalNodeId: node.mirror.originalNodeId,
	};
}
