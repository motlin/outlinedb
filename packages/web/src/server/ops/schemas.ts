/**
 * Output schemas shared by several ops. Tests parse op values against them; production never does. The node shapes
 * here are the source of the wire types in `node-types.ts`, which the client imports.
 */

import {z} from "zod";

/** File-attachment metadata for a node, sourced from the `s3_files` cache table. */
export const NodeAttachmentSchema = z.strictObject(
	{
		fileName: z.string(),
		fileType: z.string(),
		objectFolder: z.string().nullable(),
		imageOriginalWidth: z.number().nullable(),
		imageOriginalHeight: z.number().nullable(),
		/** The upload's pixel density (a fractional upstream value such as 2.5); previews divide the original width by it. */
		imageOriginalPixels: z.number().nullable(),
		isAnimatedGif: z.boolean(),
		isDeleted: z.boolean(),
	},
);

/** The `metadata.table` fields the app reads and writes. */
export const TableMetadataSchema = z.strictObject(
	{
		headers: z.boolean().optional(),
		/** Set by table paste: toggling the table on adds no Headers row. */
		skipHeaders: z.boolean().optional(),
		sizes: z.record(z.string(), z.number()).optional(),
		bg: z.string().optional(),
	},
);

/** A 📆 Calendar node's role and settings, from its upstream `metadata.calendar`. */
export const CalendarInfoSchema = z.strictObject(
	{
		/** `day` / `week` / `month` / `year` on a date node, null on the root. */
		level: z.string().nullable(),
		/** `YYYYMMDD` (`YYYYMM00` for a month, `YYYY0000` for a year), null on the root. */
		dateId: z.number().nullable(),
		root: z.boolean(),
		/** Root setting: show Found Dates on day pages; null when unset (upstream treats it as on). */
		foundDates: z.boolean().nullable(),
		/** Root setting: Friendly day names (Yesterday, Today, Tomorrow); null when unset (on). */
		dayPrefix: z.boolean().nullable(),
		/** True on a level node the app created (upstream `restorableUniqueNode`), which upstream confines to its parent level. */
		restorableUniqueNode: z.boolean(),
	},
);

/**
 * A node in Workflowy REST API response shape (snake_case wire format). The derived/mirror fields are optional so
 * client-side optimistic constructions need not populate them; the server always sets them.
 */
export const NodeResponseSchema = z.strictObject(
	{
		id: z.string(),
		parent_id: z.string().nullable(),
		name: z.string().nullable(),
		note: z.string().nullable(),
		priority: z.number(),
		data: z.strictObject(
			{
				layoutMode: z.string().nullable(),
			},
		),
		/** The first number of a numbered list (`metadata.numbered_start`), or null when unset. */
		numberedStart: z.number().nullable().optional(),
		createdAt: z.number().nullable(),
		modifiedAt: z.number().nullable(),
		completedAt: z.number().nullable(),
		hasChildren: z.boolean().optional(),
		/** At least one child is uncompleted; with completed items hidden, this decides whether the row is a parent. */
		hasUncompletedChildren: z.boolean().optional(),
		/** Upstream blocks completing a read-only item. */
		readOnly: z.boolean().optional(),
		isMirror: z.boolean().optional(),
		/** The node is an original with at least one live mirror (upstream `isMirrorRoot` on the original). */
		hasMirrors: z.boolean().optional(),
		originalNodeId: z.string().nullable().optional(),
		attachment: NodeAttachmentSchema.nullable().optional(),
		/** Upstream `metadata.priority.defaultToBottom`: nodes dropped or moved into this one land at the bottom. */
		defaultToBottom: z.boolean().optional(),
		/** Upstream `metadata.table` of a table item: header-row flag, column widths by header cell id, cell color. */
		table: TableMetadataSchema.nullable().optional(),
		/** The node is a target's hidden references root (the zoom page of its Backlinks section). */
		isReferencesRoot: z.boolean().optional(),
		/** For a references root: its read-only name, "N Backlinks". */
		backlinksLabel: z.string().optional(),
		/** The node's 📆 Calendar role (root or date node), or null for any other node. */
		calendar: CalendarInfoSchema.nullable().optional(),
	},
);

/** One node, as `GET /nodes/:id` and the single-node writes answer it. */
export const NodeEnvelopeSchema = z.strictObject(
	{
		node: NodeResponseSchema,
	},
);

/**
 * `POST /nodes` answers the created node, plus a warning when a dated row landed under a 📆 Calendar month that
 * could not be tagged as that day (no internal API).
 */
export const CreateNodeResponseSchema = z.strictObject(
	{
		node: NodeResponseSchema,
		warning: z.string().optional(),
	},
);

/** A list of nodes, as `GET /nodes`, the moves and `POST /nodes/mirror` answer it. */
export const NodeListSchema = z.strictObject(
	{
		nodes: z.array(NodeResponseSchema),
	},
);

/** Each requested parent's live children, as `POST /nodes/children` answers it. */
export const NodeChildrenResponseSchema = z.strictObject(
	{
		children: z.record(z.string(), z.array(NodeResponseSchema)),
	},
);

/**
 * The server's side of the client's dev-only cache check, as `POST /nodes/verify` answers it: each requested node the
 * cache holds by its requested id, and the children of each requested parent (Home's under `null`) that still exists.
 */
export const NodeVerifyResponseSchema = z.strictObject(
	{
		nodes: z.record(z.string(), NodeResponseSchema),
		children: z.array(
			z.strictObject(
				{
					parentId: z.string().nullable(),
					nodes: z.array(NodeResponseSchema),
				},
			),
		),
	},
);

/** A node's ancestors, as `GET /nodes/:id/ancestors` answers it. */
export const AncestorsResponseSchema = z.strictObject(
	{
		ancestors: z.array(NodeResponseSchema),
	},
);

/** What `POST /nodes/:id/detach-mirror` answers: the detached copy, or null when there was nothing to copy. */
export const DetachMirrorResponseSchema = z.strictObject(
	{
		node: NodeResponseSchema.nullable(),
	},
);

/** What `POST /nodes/:id/swap-mirror-origin` answers: the swapped pair, or why nothing was swapped. */
export const SwapMirrorOriginResponseSchema = z.union([
	z.strictObject(
		{
			swapped: z.strictObject(
				{
					mirrorId: z.string(),
					originalId: z.string(),
				},
			),
		},
	),
	z.strictObject(
		{
			warning: z.string(),
		},
	),
]);

/** The ids of the roots a bulk create or duplicate made, in order. */
export const CreatedIdsSchema = z.strictObject(
	{
		ids: z.array(z.string()),
	},
);

/** One crumb in a backlink source's ancestor path, root first. */
export const BacklinkCrumbSchema = z.strictObject(
	{
		id: z.string(),
		name: z.string(),
	},
);

/** A backlink item: the mirror row (carrying its source's text and completion) and the source's ancestor crumbs. */
export const BacklinkItemSchema = z.strictObject(
	{
		node: NodeResponseSchema,
		sourceId: z.string(),
		/** The source's ancestors, root first, excluding the source; empty when the source is top level. */
		crumbs: z.array(BacklinkCrumbSchema),
	},
);

/** An item's Backlinks section: its references root and the backlink items whose source is current. */
export const BacklinksResponseSchema = z.strictObject(
	{
		rootId: z.string().nullable(),
		items: z.array(BacklinkItemSchema),
	},
);

/** A Found Dates item: the found node shown as a mirror of itself, and its ancestor crumbs. */
export const FoundDateItemSchema = z.strictObject(
	{
		node: NodeResponseSchema,
		/** The node's ancestors, root first, excluding the node; empty when it is top level. */
		crumbs: z.array(BacklinkCrumbSchema),
	},
);

/** A day page's Found Dates section: nodes elsewhere whose `<time>` covers the day, in tree order. */
export const FoundDatesResponseSchema = z.strictObject(
	{
		items: z.array(FoundDateItemSchema),
	},
);

/** One parent's children in an outline view (`POST /api/v1/nodes/view`), with its Backlinks section (null for Home). */
export const OutlineViewListSchema = z.strictObject(
	{
		parentId: z.string().nullable(),
		nodes: z.array(NodeResponseSchema),
		backlinks: BacklinksResponseSchema.nullable(),
	},
);

/** An outline view's lists, the root's first, then each expanded row's in document order. */
export const OutlineViewResponseSchema = z.strictObject(
	{
		lists: z.array(OutlineViewListSchema),
		/** For a request with `expandedIds: null`: the listed rows the account has expanded, in list order. */
		expandedIds: z.array(z.string()).optional(),
		/** For a calendar day root: its Found Dates section, so it renders in the view's swap. */
		foundDates: FoundDatesResponseSchema.optional(),
	},
);

/**
 * `GET /api/v1/nodes/changes?since=<mark>`'s answer: what changed in the tree after a high-water mark, so a client
 * patches its cache after a write instead of refetching every node query.
 */
export const NodeChangesResponseSchema = z.strictObject(
	{
		/** The new high-water mark: a system time trailing the clock by the transaction timeout (see `changeWatermark`). */
		latest: z.string(),
		/** Too much changed to list: refetch everything. The lists below are then empty. */
		reset: z.boolean(),
		/** Every node that changed (live or gone). Empty when no `since` was given. */
		changedIds: z.array(z.string()),
		/** The changed nodes no longer in the tree. */
		deletedIds: z.array(z.string()),
		/** The refreshed children of each parent a changed node sits under now or left, Home's under `null`. */
		children: z.array(
			z.strictObject(
				{
					parentId: z.string().nullable(),
					nodes: z.array(NodeResponseSchema),
				},
			),
		),
	},
);

/**
 * `GET /api/v1/expansion?version=<version>`'s answer: the stored keys' content version, and the account's expanded
 * ids when it differs from `version` (always without one), else null.
 */
export const ExpansionChangesResponseSchema = z.strictObject(
	{
		version: z.string(),
		expandedIds: z.array(z.string()).nullable(),
	},
);

/**
 * What a text save changed beyond the node's own copies: the nodes whose Backlinks gained or lost it as a
 * source, and whether its `<time>`s changed (which moves it between day pages' Found Dates).
 */
export const SaveEffectsSchema = z.strictObject(
	{
		backlinkTargets: z.array(z.string()),
		dates: z.boolean(),
	},
);

/** `POST /api/v1/nodes/:id`'s answer: the saved node and what else the save changed. */
export const UpdateNodeResponseSchema = z.strictObject(
	{
		node: NodeResponseSchema,
		effects: SaveEffectsSchema,
	},
);

/** One location a node appears at in `GET /api/v1/nodes/:id/mirrors`. */
export const MirrorLocationSchema = z.strictObject(
	{
		id: z.string(),
		/** The ancestors from the top, ending with the location itself. */
		path: z.array(
			z.strictObject(
				{
					id: z.string(),
					name: z.string(),
				},
			),
		),
		isOriginal: z.boolean(),
	},
);

/** `GET /api/v1/nodes/:id/mirrors`: the original first, then its mirrors. */
export const MirrorsResponseSchema = z.strictObject(
	{
		mirrors: z.array(MirrorLocationSchema),
		originalId: z.string(),
		nodeName: z.string(),
	},
);

/** One node of `POST /export-tree`: the raw stored text and the fields the export formatters read. */
export const ExportTreeItemSchema = z.strictObject(
	{
		id: z.string(),
		/** Raw stored HTML. */
		name: z.string(),
		/** Raw stored HTML. */
		note: z.string(),
		layoutMode: z.string().nullable(),
		numberedStart: z.number().nullable(),
		completed: z.boolean(),
		get children(): z.ZodArray<typeof ExportTreeItemSchema>
		{
			return z.array(ExportTreeItemSchema);
		},
	},
);

/** What `POST /export-tree` answers. */
export const ExportTreeResponseSchema = z.strictObject(
	{
		items: z.array(ExportTreeItemSchema),
	},
);

/** One descendant row of `GET /:id/subtree-ids`; `parentId` is the row it renders under (a mirror, not its original). */
export const SubtreeItemSchema = z.strictObject(
	{
		id: z.string(),
		parentId: z.string().nullable(),
		completed: z.boolean(),
		hasChildren: z.boolean(),
	},
);

/** What `GET /:id/subtree-ids` answers. */
export const SubtreeItemsResponseSchema = z.strictObject(
	{
		items: z.array(SubtreeItemSchema),
	},
);

/** Home's own metadata: its layoutMode ("bullets" when unset). */
export const HomeResponseSchema = z.strictObject(
	{
		layoutMode: z.string(),
	},
);

/** A value-less success: `null`, answered as 204. */
export const NoContentSchema = z.null();
