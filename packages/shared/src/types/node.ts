/**
 * Canonical Node DTO.
 *
 * One shape, used everywhere downstream of ingestion: the DB read layer
 * (`NodeReader`), the REST API DTO, and the CLI output. Replaces the prior
 * three independent representations (`NodeContentType`+`NodeMetadataType`,
 * `WorkflowyNode`, `BackupNode`) and the hand-coded REST `NodeResponse`.
 *
 * Derived per-query fields (`hasChildren`, the resolved-from-mirror name
 * fallback) deliberately stay OFF this type. They live on the REST DTO only,
 * computed by the REST handler from a `Node` plus extra batched queries. The
 * CLI does not need them, so forcing every reader to compute them would be a
 * needless cost.
 */
export interface Node
{
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
	/** Creation timestamp, or null if unknown. */
	createdAt: Date | null;
	/** Last-modified timestamp, or null if unknown. */
	modifiedAt: Date | null;
	/** Completion timestamp, or null if the node is not completed. */
	completedAt: Date | null;
	/** Whether the node is collapsed in the UI. */
	collapsed: boolean;
	/** Mirror relationship info. */
	mirror:
	{
		/** Whether this node is a mirror of another node. */
		isMirror: boolean;
		/** Full UUID of the original node this mirrors, or null. */
		originalNodeId: string | null;
	};
	/** Temporal system-time lower bound (inclusive). */
	systemFrom: string;
	/** Temporal system-time upper bound (exclusive). */
	systemTo: string;
}
