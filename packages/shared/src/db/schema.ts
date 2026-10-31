import type {InferInsertModel, InferSelectModel} from "drizzle-orm";
import {relations, sql} from "drizzle-orm";
import {blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex} from "drizzle-orm/sqlite-core";

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
 * this table tracks timestamps for API-driven ingestion pipelines:
 *   - `account`: when the account tables were last refreshed or written (the 30s staleness check).
 *   - `expanded_nodes`: when a whole-tree import last seeded `expanded_nodes` (absent until then).
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
		uniqueIndex("api_import_timestamp_system_to_idx").on(table.name, table.systemTo),
		index("api_import_timestamp_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
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
 * account_state: the last applied calendar layout's undo writes, as one JSON
 * document under `calendar_layout_undo` (see `internal/adapter.ts`). Every other
 * account value lives in the typed temporal account tables below; deriving the
 * undo from temporal history removes this table.
 */
export const accountState = sqliteTable("account_state", {
	key: text("key").primaryKey(),
	json: text("json").notNull(),
	fetchedAt: integer("fetched_at").notNull(),
});

/**
 * account: the signed-in Workflowy account, from the initialization data: `date_joined_sec` (the epoch upstream's relative timestamps count from), `entropy_key` (the salt of deterministic ids), and `username`/`email` from its settings.
 */
export const account = sqliteTable(
	"account",
	{
		userId: integer("user_id").notNull(),
		fullName: text("full_name"),
		dateJoinedSec: integer("date_joined_sec").notNull(),
		entropyKey: text("entropy_key"),
		username: text("username"),
		email: text("email"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.userId, table.systemFrom]}),
		uniqueIndex("account_system_to_idx").on(table.userId, table.systemTo),
		index("account_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * root_preferences: the scalar values of upstream's root (Home) metadata, one column per key path (`slash.discovered` is `slash_discovered`, `weekly-report.on` is `weekly_report_on`, `layoutMode` is `home_layout_mode`). Booleans are 0/1; NULL means the key is absent.
 */
export const rootPreferences = sqliteTable(
	"root_preferences",
	{
		userId: integer("user_id").notNull(),
		dateFormat: text("date_format"),
		timeFormat: text("time_format"),
		weekStartDay: integer("week_start_day"),
		slashDiscovered: integer("slash_discovered"),
		notesRootId: text("notes_root_id"),
		weeklyReportOn: integer("weekly_report_on"),
		homeLayoutMode: text("home_layout_mode"),
		latestColorAttribute: integer("latest_color_attribute"),
		latestColorValue: integer("latest_color_value"),
		searchForChangesAfter: integer("search_for_changes_after"),
		starringIsSynced: integer("starring_is_synced"),
		aiEmbeddingStatus: text("ai_embedding_status"),
		aiEmbeddingTooltipDismissed: integer("ai_embedding_tooltip_dismissed"),
		aiMailboxId: text("ai_mailbox_id"),
		cmdMetricsFailed: integer("cmd_metrics_failed"),
		calendarRootId: text("calendar_root_id"),
		calendarTsAddedV2: integer("calendar_ts_added_v2"),
		calendarTooltipSeen: integer("calendar_tooltip_seen"),
		calendarDateIdAddedV1: integer("calendar_date_id_added_v1"),
		emojiSelected: text("emoji_selected"),
		inboxId: text("inbox_id"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.userId, table.systemFrom]}),
		uniqueIndex("root_preferences_system_to_idx").on(table.userId, table.systemTo),
		index("root_preferences_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * account_settings: the account's scalar server settings. Flags are 0/1 (upstream sends booleans or `"yes"`/`"no"`); NULL means the setting is absent.
 */
export const accountSettings = sqliteTable(
	"account_settings",
	{
		userId: integer("user_id").notNull(),
		theme: text("theme"),
		font: text("font"),
		timezone: text("timezone"),
		showCompleted: integer("show_completed"),
		showKeyboardShortcuts: integer("show_keyboard_shortcuts"),
		sameColorForLinks: integer("same_color_for_links"),
		displayImagePreviewsAsThumbnails: integer("display_image_previews_as_thumbnails"),
		ignoreYoutube: integer("ignore_youtube"),
		ignoreYtShort: integer("ignore_yt_short"),
		ignoreTwitter: integer("ignore_twitter"),
		ignoreLoom: integer("ignore_loom"),
		unsubscribeFromSummaryEmails: integer("unsubscribe_from_summary_emails"),
		unsubscribeFromCommentsEmails: integer("unsubscribe_from_comments_emails"),
		backupToDropbox: integer("backup_to_dropbox"),
		mfaEnabled: integer("mfa_enabled"),
		aiDefaultAgentId: text("ai_default_agent_id"),
		aiContextLimit: integer("ai_context_limit"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.userId, table.systemFrom]}),
		uniqueIndex("account_settings_system_to_idx").on(table.userId, table.systemTo),
		index("account_settings_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * tag_colors: root metadata `color.tags`: each tag's color index, keyed by the tag as upstream writes it (`#tag` or `@person`).
 */
export const tagColors = sqliteTable(
	"tag_colors",
	{
		tag: text("tag").notNull(),
		colorIndex: integer("color_index").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.tag, table.systemFrom]}),
		uniqueIndex("tag_colors_system_to_idx").on(table.tag, table.systemTo),
		index("tag_colors_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * stars: root metadata `starring.locations`: each starred location key and the tree root it belongs to (`"None"` for the main tree).
 */
export const stars = sqliteTable(
	"stars",
	{
		locationKey: text("location_key").notNull(),
		treeRoot: text("tree_root").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.locationKey, table.systemFrom]}),
		uniqueIndex("stars_system_to_idx").on(table.locationKey, table.systemTo),
		index("stars_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * star_order: root metadata `starring.order`, one row per comma-separated entry (`<treeRoot>/<nodeId>/<query>`) at its position; no rows when upstream sends no order. The entries are kept verbatim rather than as a position on `stars`, since upstream does not keep the two in step.
 */
export const starOrder = sqliteTable(
	"star_order",
	{
		position: integer("position").notNull(),
		entry: text("entry").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.position, table.systemFrom]}),
		uniqueIndex("star_order_system_to_idx").on(table.position, table.systemTo),
		index("star_order_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * location_renames: root metadata `location.renamed`: a star's custom name, keyed by its order entry.
 */
export const locationRenames = sqliteTable(
	"location_renames",
	{
		locationKey: text("location_key").notNull(),
		name: text("name").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.locationKey, table.systemFrom]}),
		uniqueIndex("location_renames_system_to_idx").on(table.locationKey, table.systemTo),
		index("location_renames_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * enabled_features: settings `features`: each feature flag upstream reports, 0/1.
 */
export const enabledFeatures = sqliteTable(
	"enabled_features",
	{
		codename: text("codename").notNull(),
		enabled: integer("enabled").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.codename, table.systemFrom]}),
		uniqueIndex("enabled_features_system_to_idx").on(table.codename, table.systemTo),
		index("enabled_features_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * visible_features: the server's visible feature list (one Settings > Features row each), in server order.
 */
export const visibleFeatures = sqliteTable(
	"visible_features",
	{
		codename: text("codename").notNull(),
		name: text("name").notNull(),
		label: text("label"),
		description: text("description"),
		position: integer("position").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.codename, table.systemFrom]}),
		uniqueIndex("visible_features_system_to_idx").on(table.codename, table.systemTo),
		index("visible_features_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * expanded_nodes: the account's expanded-node keys (the first 8 chars of each id, plus `v_` mirror-instance and `leftbar__` keys), one row per expanded key; see `cache/expansion-store.ts`.
 */
export const expandedNodes = sqliteTable(
	"expanded_nodes",
	{
		shortKey: text("short_key").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.shortKey, table.systemFrom]}),
		uniqueIndex("expanded_nodes_system_to_idx").on(table.shortKey, table.systemTo),
		index("expanded_nodes_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * changelog_reads: root metadata `changelog.read`: each changelog entry's read flag, 0/1.
 */
export const changelogReads = sqliteTable(
	"changelog_reads",
	{
		entry: text("entry").notNull(),
		read: integer("read").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.entry, table.systemFrom]}),
		uniqueIndex("changelog_reads_system_to_idx").on(table.entry, table.systemTo),
		index("changelog_reads_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * surveys: root metadata `surveys`: each in-app survey's status and when it was set (Unix ms).
 */
export const surveys = sqliteTable(
	"surveys",
	{
		survey: text("survey").notNull(),
		status: text("status"),
		at: integer("at"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.survey, table.systemFrom]}),
		uniqueIndex("surveys_system_to_idx").on(table.survey, table.systemTo),
		index("surveys_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * saved_views: settings `saved_views_json`, one row per saved view at its position: the zoomed project, its auxiliary tree root, and the search query.
 */
export const savedViews = sqliteTable(
	"saved_views",
	{
		position: integer("position").notNull(),
		projectId: text("project_id"),
		auxiliaryRootProjectId: text("auxiliary_root_project_id"),
		searchQuery: text("search_query"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.position, table.systemFrom]}),
		uniqueIndex("saved_views_system_to_idx").on(table.position, table.systemTo),
		index("saved_views_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * ai_assistants: settings `ai.assistants`: each AI assistant upstream offers, in its order.
 */
export const aiAssistants = sqliteTable(
	"ai_assistants",
	{
		assistantId: text("assistant_id").notNull(),
		name: text("name"),
		model: text("model"),
		systemUserId: integer("system_user_id"),
		position: integer("position").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.assistantId, table.systemFrom]}),
		uniqueIndex("ai_assistants_system_to_idx").on(table.assistantId, table.systemTo),
		index("ai_assistants_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * ai_prompt_buttons: settings `ai.prompt_buttons`: each prompt button of each kind (`draft`, `reply`) at its position.
 */
export const aiPromptButtons = sqliteTable(
	"ai_prompt_buttons",
	{
		kind: text("kind").notNull(),
		position: integer("position").notNull(),
		buttonId: text("button_id"),
		name: text("name"),
		icon: text("icon"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.kind, table.position, table.systemFrom]}),
		uniqueIndex("ai_prompt_buttons_system_to_idx").on(table.kind, table.position, table.systemTo),
		index("ai_prompt_buttons_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * tree_transactions: the transaction id a tree's edge tables are current to, which every `/push_and_poll` starts from (see `cache/tree-transaction.ts`); `tree_id` is `"main"` for the main tree.
 */
export const treeTransactions = sqliteTable(
	"tree_transactions",
	{
		treeId: text("tree_id").notNull(),
		transactionId: text("transaction_id").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.treeId, table.systemFrom]}),
		uniqueIndex("tree_transactions_system_to_idx").on(table.treeId, table.systemTo),
		index("tree_transactions_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

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
 * node_tags: each live item's distinct tags, derived from its live `node_content`
 * name and note (and `node_metadata.layout_mode`: a code block has none) by
 * `itemTags`. `tag_key` is the tag's lowercase form, `tag` its first-seen
 * casing in that item. Derived and rebuildable, so not bitemporal: every unit
 * of work rewrites the rows of the nodes it touched (see `cache/node-tags.ts`).
 */
export const nodeTags = sqliteTable(
	"node_tags",
	{
		nodeId: text("node_id").notNull(),
		tagKey: text("tag_key").notNull(),
		tag: text("tag").notNull(),
	},
	(table) => [primaryKey({columns: [table.nodeId, table.tagKey]}), index("node_tags_tag_key_idx").on(table.tagKey)],
);

/**
 * node_display_metadata: a node's display settings from upstream item
 * metadata that the public API does not return, imported from the internal
 * API's `/get_tree_data/` and written after accepted metadata edits. One row
 * only while any field is set; booleans are 0/1.
 *   - `numbered_start`: `metadata.numbered_start`, a numbered list's first number.
 *   - `restorable_unique_node`: `metadata.restorableUniqueNode`, set on calendar level nodes.
 *   - `table_headers`, `table_skip_headers`, `table_bg`: `metadata.table.headers`,
 *     `.skipHeaders` and `.bg`; `.sizes` lives in `node_table_cell_sizes`.
 *   - `priority_default_to_bottom`: `metadata.priority.defaultToBottom`.
 * Separate from `node_metadata`, which versions on every priority or modified
 * change, while these rarely change.
 */
export const nodeDisplayMetadata = sqliteTable(
	"node_display_metadata",
	{
		nodeId: text("node_id").notNull(),

		numberedStart: integer("numbered_start"),
		restorableUniqueNode: integer("restorable_unique_node"),
		tableHeaders: integer("table_headers"),
		tableSkipHeaders: integer("table_skip_headers"),
		tableBg: text("table_bg"),
		priorityDefaultToBottom: integer("priority_default_to_bottom"),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.systemFrom]}),
		uniqueIndex("node_display_metadata_system_to_idx").on(table.nodeId, table.systemTo),
		index("node_display_metadata_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

/**
 * node_table_cell_sizes: a table node's column widths, upstream's
 * `metadata.table.sizes` map of header cell (a node id) to width, one row per entry.
 */
export const nodeTableCellSizes = sqliteTable(
	"node_table_cell_sizes",
	{
		nodeId: text("node_id").notNull(),
		cellId: text("cell_id").notNull(),
		size: real("size").notNull(),

		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull(),
	},
	(table) => [
		primaryKey({columns: [table.nodeId, table.cellId, table.systemFrom]}),
		uniqueIndex("node_table_cell_sizes_system_to_idx").on(table.nodeId, table.cellId, table.systemTo),
		index("node_table_cell_sizes_closed_at_idx")
			.on(table.systemTo)
			.where(sql`system_to < '9999-12-31 23:59:59'`),
	],
);

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
export type NodeDisplayMetadata = InferSelectModel<typeof nodeDisplayMetadata>;
export type NewNodeDisplayMetadata = InferInsertModel<typeof nodeDisplayMetadata>;
export type NodeTableCellSize = InferSelectModel<typeof nodeTableCellSizes>;
export type NewNodeTableCellSize = InferInsertModel<typeof nodeTableCellSizes>;
