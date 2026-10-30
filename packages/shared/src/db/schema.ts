import type {InferInsertModel, InferSelectModel} from "drizzle-orm";
import {relations, sql} from "drizzle-orm";
import {blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex} from "drizzle-orm/sqlite-core";

/**
 * node_content: Fields that affect embeddings (name, note, parentId)
 */
export const nodeContent = sqliteTable(
	"node_content",
	{
		id: text("id").notNull(),

		name: text("name"),
		note: text("note"),
		parentId: text("parent_id"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.id, table.systemFrom]}),
		uniqueIndex("node_content_system_to_idx").on(table.id, table.systemTo),
		uniqueIndex("node_content_parent_idx").on(table.parentId, table.systemFrom, table.systemTo, table.id),
		index("node_content_system_from_idx").on(table.systemFrom),
		// Partial: a full system_to index would win every live-row lookup (system_to = far future).
		index("node_content_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * node_metadata: Fields that do NOT affect embeddings
 * Changes to these fields (like priority reordering) do not trigger embedding regeneration.
 */
export const nodeMetadata = sqliteTable(
	"node_metadata",
	{
		nodeId: text("node_id").notNull(),
		// Last 12 hex chars of UUID (after final hyphen), used for resolving Workflowy short links
		shortId: text("short_id"),

		priority: integer("priority"),

		createdAt: integer("created_at", {mode: "timestamp"}),
		modifiedAt: integer("modified_at", {mode: "timestamp"}),
		completedAt: integer("completed_at", {mode: "timestamp"}),

		layoutMode: text("layout_mode"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		index("node_metadata_system_to_idx").on(table.nodeId, table.systemTo),
		index("node_metadata_short_id_idx").on(table.shortId, table.systemTo),
		index("node_metadata_system_from_idx").on(table.systemFrom),
		// Partial: a full system_to index would win every live-row lookup (system_to = far future).
		index("node_metadata_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * calendar_metadata: Calendar-related metadata for nodes
 * Stores calendar information like root marking, calendar levels, associated dates, etc.
 *
 * 📅 `level` vs `calendar_levels` — complementary, not redundant (investigation 2026-05-21):
 * The two fields describe different node roles and are mutually exclusive in practice.
 *   - `level` (text: 'day' | 'week' | 'month' | 'year') is set on individual *date nodes*
 *     and names the single granularity that date represents (e.g. the "Feb 11" node has
 *     level='day'). Date nodes have NO row in `calendar_levels`.
 *   - `calendar_levels` (boolean flags) is set only on the *calendar root* node (the node
 *     with root=1) and records which granularities the calendar view exposes. The root
 *     node has level=NULL.
 * Backup data confirmed: of 271 nodes with calendar metadata, 270 carry `level` only and
 * exactly 1 (the root) carries `levels` only — zero nodes carry both. Workflowy emits both
 * keys on `CalendarSchema` because one schema covers both roles; a given node populates
 * only the field appropriate to its role.
 */
export const calendarMetadata = sqliteTable(
	"calendar_metadata",
	{
		nodeId: text("node_id").notNull(),

		root: integer("root"),
		level: text("level"),
		value: text("value"),
		dateId: integer("date_id"),
		timestamp: integer("timestamp"),
		foundDates: integer("found_dates"),
		dayPrefix: integer("day_prefix"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		index("calendar_metadata_system_to_idx").on(table.nodeId, table.systemTo),
	],
);

/**
 * calendar_levels: Normalized calendar level flags for the calendar root node.
 * Records which granularities (day, week, month, year) the calendar view exposes.
 * Populated only for the node with calendar_metadata.root=1; date nodes use
 * calendar_metadata.level instead. See the calendar_metadata doc comment above.
 */
export const calendarLevels = sqliteTable(
	"calendar_levels",
	{
		nodeId: text("node_id").notNull(),

		day: integer("day"),
		week: integer("week"),
		month: integer("month"),
		year: integer("year"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		index("calendar_levels_system_to_idx").on(table.nodeId, table.systemTo),
	],
);

export const nodeEmbeddings = sqliteTable(
	"node_embeddings",
	{
		nodeId: text("node_id").notNull(),
		model: text("model").notNull().default("minilm"),
		embedding: blob("embedding", {mode: "buffer"}).notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.model, table.systemFrom]}),
		index("node_embeddings_system_to_idx").on(table.nodeId, table.model, table.systemTo),
	],
);

/**
 * mirrors: Normalized mirror relationships
 * - originalId: The original node being mirrored
 * - mirrorId: The node that is a mirror/copy
 * Backlinks are derived via inverse queries (WHERE originalId = X)
 */
export const mirrors = sqliteTable(
	"mirrors",
	{
		mirrorId: text("mirror_id").notNull(),
		originalId: text("original_id").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.mirrorId, table.originalId, table.systemFrom]}),
		index("mirrors_mirror_idx").on(table.mirrorId, table.systemTo),
		index("mirrors_original_idx").on(table.originalId, table.systemTo),
	],
);

export const backlinks = sqliteTable(
	"backlinks",
	{
		nodeId: text("node_id").notNull(),
		sourceId: text("source_id").notNull(),
		targetId: text("target_id").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.sourceId, table.targetId, table.systemFrom]}),
		index("backlinks_node_idx").on(table.nodeId, table.systemTo),
		index("backlinks_source_idx").on(table.sourceId, table.systemTo),
		index("backlinks_target_idx").on(table.targetId, table.systemTo),
	],
);

export const virtualRootIds = sqliteTable(
	"virtual_root_ids",
	{
		nodeId: text("node_id").notNull(),
		virtualRootId: text("virtual_root_id").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.virtualRootId, table.systemFrom]}),
		index("virtual_root_ids_node_idx").on(table.nodeId, table.systemTo),
	],
);

export const aiMetadata = sqliteTable(
	"ai_metadata",
	{
		nodeId: text("node_id").notNull(),

		inChat: integer("in_chat").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		index("ai_metadata_system_to_idx").on(table.nodeId, table.systemTo),
	],
);

export const s3Files = sqliteTable(
	"s3_files",
	{
		nodeId: text("node_id").notNull(),

		fileName: text("file_name").notNull(),
		fileType: text("file_type").notNull(),
		objectFolder: text("object_folder"),
		isAnimatedGif: integer("is_animated_gif"),
		imageOriginalWidth: integer("image_original_width"),
		imageOriginalHeight: integer("image_original_height"),
		imageOriginalPixels: integer("image_original_pixels"),
		isDeleted: integer("is_deleted"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		index("s3_files_system_to_idx").on(table.nodeId, table.systemTo),
	],
);

export const changesMetadata = sqliteTable(
	"changes_metadata",
	{
		nodeId: text("node_id").notNull(),

		ctBy: integer("ct_by").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		index("changes_metadata_system_to_idx").on(table.nodeId, table.systemTo),
	],
);

export const referencesRoots = sqliteTable(
	"references_roots",
	{
		nodeId: text("node_id").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		index("references_roots_system_to_idx").on(table.nodeId, table.systemTo),
	],
);

export const backupImports = sqliteTable(
	"backup_imports",
	{
		filename: text("filename").notNull(),
		backupDate: text("backup_date").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.filename, table.systemFrom]}),
		index("backup_imports_system_to_idx").on(table.filename, table.systemTo),
	],
);

/**
 * api_import_timestamp: Tracks direct API import wall-clock times
 * Unlike backup_imports which tracks backup file high watermarks (filename + date),
 * this table tracks timestamps for API-driven ingestion pipelines.
 */
export const apiImportTimestamp = sqliteTable(
	"api_import_timestamp",
	{
		name: text("name").notNull(),
		timestamp: integer("timestamp", {mode: "timestamp"}),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.name, table.systemFrom]}),
		index("api_import_timestamp_system_to_idx").on(table.name, table.systemTo),
	],
);

/**
 * config: Local key-value store (e.g. the Workflowy epoch used for timestamp math).
 *
 * ⚙️ Temporal-pattern exemption — intentional.
 * Unlike every other table in this schema, `config` carries no `system_from`/`system_to`
 * columns and is not bitemporal. Rationale:
 *   - It is local-only. Values are set by the operator via `cache:config --set`; nothing
 *     here is ingested from Workflowy.com, so there is no upstream history to mirror.
 *   - It is a mutable key-value store with upsert (`onConflictDoUpdate`) semantics. There
 *     is no audit value in retaining superseded settings — the current value is the only
 *     value that matters. `created_at`/`updated_at` text columns cover the modest "when
 *     did this change" need without the cost of full bitemporal versioning.
 *   - It is excluded from `cache:temporal-rollback` for the same reason: rolling the cache
 *     back to an earlier system time must not revert local configuration.
 *
 * (The former `node_collapsed` table was the other exemption; it was ephemeral UI state
 * that was never populated and has been dropped — see migration 0025_drop_dead_columns.sql.)
 */
export const config = sqliteTable("config", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

/**
 * account_state: Workflowy account state cached from the internal API (see
 * `internal/adapter.ts`), one JSON document per key: `account`, `root_metadata`,
 * `settings`, `expanded_keys`, and `tree_tx_id`, the main tree's transaction
 * id the edge tables are current to, which every `/push_and_poll` starts from
 * (see `cache/tree-transaction.ts`). `fetched_at` is Unix ms of the refresh or
 * accepted write that produced the row. A write-through cache, so non-bitemporal and excluded from
 * temporal rollback.
 */
export const accountState = sqliteTable("account_state", {
	key: text("key").primaryKey(),
	json: text("json").notNull(),
	fetchedAt: integer("fetched_at").notNull(),
});

/**
 * local_settings: the app's own durable copy of every setting written to
 * workflowy.com (account settings and root-metadata preferences). Unlike
 * `account_state`, which is a cache that a re-import overwrites, this table is
 * never refreshed from the server, so the values survive when the app later runs
 * without workflowy.com. `json` is the JSON-encoded value; `updated_at` is Unix ms.
 */
export const localSettings = sqliteTable("local_settings", {
	key: text("key").primaryKey(),
	json: text("json").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/**
 * file_blobs: local copies of attachment bytes downloaded by `files mirror`.
 * One row per attachment node; `local_path` is relative to the mirror's store
 * directory and content-addressed by `sha256`. `status` is "ok" or "error"
 * (with `error` holding the message); error rows are retried on the next run.
 * `fetched_at` is Unix ms. Local state, so not bitemporal.
 */
export const fileBlobs = sqliteTable("file_blobs", {
	nodeId: text("node_id").primaryKey(),
	status: text("status").notNull(),
	sha256: text("sha256"),
	size: integer("size"),
	contentType: text("content_type"),
	localPath: text("local_path"),
	error: text("error"),
	fetchedAt: integer("fetched_at").notNull(),
});

/**
 * node_internal_metadata: item metadata the public API does not return,
 * imported from the internal API's `/get_tree_data/` (see
 * `importInternalMetadata` in `cache/importer.ts`). `metadata_json` holds only
 * the keys the app uses: `numbered_start`, `calendar`,
 * `priority.defaultToBottom` and `layoutMode`. `fetched_at` is Unix ms of the
 * import or accepted write that produced the row. A write-through cache, so
 * non-bitemporal and excluded from temporal rollback.
 */
export const nodeInternalMetadata = sqliteTable("node_internal_metadata", {
	nodeId: text("node_id").primaryKey(),
	metadataJson: text("metadata_json").notNull(),
	fetchedAt: integer("fetched_at").notNull(),
});

export const nodeContentRelations = relations(nodeContent, ({one, many}) => ({
	metadata: one(nodeMetadata, {
		fields: [nodeContent.id, nodeContent.systemTo],
		references: [nodeMetadata.nodeId, nodeMetadata.systemTo],
	}),
	// Mirrors where this node is the original (backlinks = nodes that mirror this one)
	mirrorsAsOriginal: many(mirrors, {relationName: "original"}),
	// Mirrors where this node is the mirror copy
	mirrorsAsCopy: many(mirrors, {relationName: "mirror"}),
	backlinks: many(backlinks),
	virtualRootIds: many(virtualRootIds),
	aiMetadata: one(aiMetadata, {
		fields: [nodeContent.id, nodeContent.systemTo],
		references: [aiMetadata.nodeId, aiMetadata.systemTo],
	}),
	s3File: one(s3Files, {
		fields: [nodeContent.id, nodeContent.systemTo],
		references: [s3Files.nodeId, s3Files.systemTo],
	}),
	changesMetadata: one(changesMetadata, {
		fields: [nodeContent.id, nodeContent.systemTo],
		references: [changesMetadata.nodeId, changesMetadata.systemTo],
	}),
	referencesRoot: one(referencesRoots, {
		fields: [nodeContent.id, nodeContent.systemTo],
		references: [referencesRoots.nodeId, referencesRoots.systemTo],
	}),
	calendar: one(calendarMetadata, {
		fields: [nodeContent.id, nodeContent.systemTo],
		references: [calendarMetadata.nodeId, calendarMetadata.systemTo],
	}),
	nodeEmbeddings: many(nodeEmbeddings),
}));

export const nodeMetadataRelations = relations(nodeMetadata, ({one}) => ({
	content: one(nodeContent, {
		fields: [nodeMetadata.nodeId, nodeMetadata.systemTo],
		references: [nodeContent.id, nodeContent.systemTo],
	}),
}));

export const mirrorsRelations = relations(mirrors, ({one}) => ({
	// The original node being mirrored
	original: one(nodeContent, {
		fields: [mirrors.originalId],
		references: [nodeContent.id],
		relationName: "original",
	}),
	// The node that is the mirror/copy
	mirror: one(nodeContent, {
		fields: [mirrors.mirrorId],
		references: [nodeContent.id],
		relationName: "mirror",
	}),
}));

export const backlinksRelations = relations(backlinks, ({one}) => ({
	content: one(nodeContent, {
		fields: [backlinks.nodeId],
		references: [nodeContent.id],
	}),
}));

export const virtualRootIdsRelations = relations(virtualRootIds, ({one}) => ({
	content: one(nodeContent, {
		fields: [virtualRootIds.nodeId],
		references: [nodeContent.id],
	}),
}));

export const aiMetadataRelations = relations(aiMetadata, ({one}) => ({
	content: one(nodeContent, {
		fields: [aiMetadata.nodeId, aiMetadata.systemTo],
		references: [nodeContent.id, nodeContent.systemTo],
	}),
}));

export const s3FilesRelations = relations(s3Files, ({one}) => ({
	content: one(nodeContent, {
		fields: [s3Files.nodeId, s3Files.systemTo],
		references: [nodeContent.id, nodeContent.systemTo],
	}),
}));

export const changesMetadataRelations = relations(changesMetadata, ({one}) => ({
	content: one(nodeContent, {
		fields: [changesMetadata.nodeId, changesMetadata.systemTo],
		references: [nodeContent.id, nodeContent.systemTo],
	}),
}));

export const referencesRootsRelations = relations(referencesRoots, ({one}) => ({
	content: one(nodeContent, {
		fields: [referencesRoots.nodeId, referencesRoots.systemTo],
		references: [nodeContent.id, nodeContent.systemTo],
	}),
}));

export const nodeEmbeddingsRelations = relations(nodeEmbeddings, ({one}) => ({
	content: one(nodeContent, {
		fields: [nodeEmbeddings.nodeId],
		references: [nodeContent.id],
	}),
}));

export const calendarMetadataRelations = relations(calendarMetadata, ({one}) => ({
	content: one(nodeContent, {
		fields: [calendarMetadata.nodeId, calendarMetadata.systemTo],
		references: [nodeContent.id, nodeContent.systemTo],
	}),
	levels: one(calendarLevels, {
		fields: [calendarMetadata.nodeId, calendarMetadata.systemTo],
		references: [calendarLevels.nodeId, calendarLevels.systemTo],
	}),
}));

export const calendarLevelsRelations = relations(calendarLevels, ({one}) => ({
	calendarMetadata: one(calendarMetadata, {
		fields: [calendarLevels.nodeId, calendarLevels.systemTo],
		references: [calendarMetadata.nodeId, calendarMetadata.systemTo],
	}),
}));

// Type exports for use in the application
export type NodeContentType = InferSelectModel<typeof nodeContent>;
export type NewNodeContent = InferInsertModel<typeof nodeContent>;
export type NodeMetadataType = InferSelectModel<typeof nodeMetadata>;
export type NewNodeMetadata = InferInsertModel<typeof nodeMetadata>;

export type NodeEmbedding = InferSelectModel<typeof nodeEmbeddings>;
export type NewNodeEmbedding = InferInsertModel<typeof nodeEmbeddings>;
export type Mirror = InferSelectModel<typeof mirrors>;
export type NewMirror = InferInsertModel<typeof mirrors>;
export type Backlink = InferSelectModel<typeof backlinks>;
export type NewBacklink = InferInsertModel<typeof backlinks>;
export type VirtualRootId = InferSelectModel<typeof virtualRootIds>;
export type NewVirtualRootId = InferInsertModel<typeof virtualRootIds>;
export type AiMetadata = InferSelectModel<typeof aiMetadata>;
export type NewAiMetadata = InferInsertModel<typeof aiMetadata>;
export type S3File = InferSelectModel<typeof s3Files>;
export type NewS3File = InferInsertModel<typeof s3Files>;
export type ChangesMetadata = InferSelectModel<typeof changesMetadata>;
export type NewChangesMetadata = InferInsertModel<typeof changesMetadata>;
export type ReferencesRoot = InferSelectModel<typeof referencesRoots>;
export type NewReferencesRoot = InferInsertModel<typeof referencesRoots>;
export type BackupImport = InferSelectModel<typeof backupImports>;
export type NewBackupImport = InferInsertModel<typeof backupImports>;
export type ApiImportTimestamp = InferSelectModel<typeof apiImportTimestamp>;
export type NewApiImportTimestamp = InferInsertModel<typeof apiImportTimestamp>;
export type CalendarMetadata = InferSelectModel<typeof calendarMetadata>;
export type NewCalendarMetadata = InferInsertModel<typeof calendarMetadata>;
export type CalendarLevels = InferSelectModel<typeof calendarLevels>;
export type NewCalendarLevels = InferInsertModel<typeof calendarLevels>;
