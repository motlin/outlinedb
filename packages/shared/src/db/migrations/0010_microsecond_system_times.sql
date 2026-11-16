-- System times become INTEGER microseconds since the epoch: each readable UTC text time converts to its millisecond
-- in microseconds, and the far-future sentinel '9999-12-31 23:59:59' becomes 9007199254740991 (Number.MAX_SAFE_INTEGER).
-- Rows whose time columns are not that readable text were written by the microsecond code before this migration ran
-- (numeric text such as '1794788809134486.0'); each duplicates a still-current text row, so they are deleted first.
-- The GLOB pattern stays within the 50 bytes a Durable Object's SQLite allows a LIKE or GLOB pattern.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account` (
	`user_id` text NOT NULL,
	`full_name` text,
	`date_joined_sec` integer NOT NULL,
	`entropy_key` text,
	`username` text,
	`email` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `account` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_account`("user_id", "full_name", "date_joined_sec", "entropy_key", "username", "email", "system_from", "system_to") SELECT "user_id", "full_name", "date_joined_sec", "entropy_key", "username", "email", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `account`;--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `account_system_to_idx` ON `account` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_closed_at_idx` ON `account` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_account_outbox` (
	`subject` text NOT NULL,
	`key` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`last_error` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`subject`, `key`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `account_outbox` WHERE "enqueued_at" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_account_outbox`("subject", "key", "enqueued_at", "last_error", "system_from", "system_to") SELECT "subject", "key", CASE WHEN "enqueued_at" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("enqueued_at") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, "last_error", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `account_outbox`;--> statement-breakpoint
DROP TABLE `account_outbox`;--> statement-breakpoint
ALTER TABLE `__new_account_outbox` RENAME TO `account_outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_outbox_system_to_idx` ON `account_outbox` (`subject`,`key`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_outbox_closed_at_idx` ON `account_outbox` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_account_settings` (
	`user_id` text NOT NULL,
	`theme` text,
	`font` text,
	`timezone` text,
	`show_completed` integer,
	`show_keyboard_shortcuts` integer,
	`same_color_for_links` integer,
	`display_image_previews_as_thumbnails` integer,
	`ignore_youtube` integer,
	`ignore_yt_short` integer,
	`ignore_twitter` integer,
	`ignore_loom` integer,
	`unsubscribe_from_summary_emails` integer,
	`unsubscribe_from_comments_emails` integer,
	`backup_to_dropbox` integer,
	`mfa_enabled` integer,
	`ai_default_agent_id` text,
	`ai_context_limit` integer,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `account_settings` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_account_settings`("user_id", "theme", "font", "timezone", "show_completed", "show_keyboard_shortcuts", "same_color_for_links", "display_image_previews_as_thumbnails", "ignore_youtube", "ignore_yt_short", "ignore_twitter", "ignore_loom", "unsubscribe_from_summary_emails", "unsubscribe_from_comments_emails", "backup_to_dropbox", "mfa_enabled", "ai_default_agent_id", "ai_context_limit", "system_from", "system_to") SELECT "user_id", "theme", "font", "timezone", "show_completed", "show_keyboard_shortcuts", "same_color_for_links", "display_image_previews_as_thumbnails", "ignore_youtube", "ignore_yt_short", "ignore_twitter", "ignore_loom", "unsubscribe_from_summary_emails", "unsubscribe_from_comments_emails", "backup_to_dropbox", "mfa_enabled", "ai_default_agent_id", "ai_context_limit", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `account_settings`;--> statement-breakpoint
DROP TABLE `account_settings`;--> statement-breakpoint
ALTER TABLE `__new_account_settings` RENAME TO `account_settings`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_settings_system_to_idx` ON `account_settings` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_settings_closed_at_idx` ON `account_settings` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_ai_assistants` (
	`assistant_id` text NOT NULL,
	`name` text,
	`model` text,
	`system_user_id` integer,
	`position` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`assistant_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `ai_assistants` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_ai_assistants`("assistant_id", "name", "model", "system_user_id", "position", "system_from", "system_to") SELECT "assistant_id", "name", "model", "system_user_id", "position", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `ai_assistants`;--> statement-breakpoint
DROP TABLE `ai_assistants`;--> statement-breakpoint
ALTER TABLE `__new_ai_assistants` RENAME TO `ai_assistants`;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_assistants_system_to_idx` ON `ai_assistants` (`assistant_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `ai_assistants_closed_at_idx` ON `ai_assistants` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_ai_prompt_buttons` (
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`button_id` text,
	`name` text,
	`icon` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`kind`, `position`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `ai_prompt_buttons` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_ai_prompt_buttons`("kind", "position", "button_id", "name", "icon", "system_from", "system_to") SELECT "kind", "position", "button_id", "name", "icon", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `ai_prompt_buttons`;--> statement-breakpoint
DROP TABLE `ai_prompt_buttons`;--> statement-breakpoint
ALTER TABLE `__new_ai_prompt_buttons` RENAME TO `ai_prompt_buttons`;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_prompt_buttons_system_to_idx` ON `ai_prompt_buttons` (`kind`,`position`,`system_to`);--> statement-breakpoint
CREATE INDEX `ai_prompt_buttons_closed_at_idx` ON `ai_prompt_buttons` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_api_import_timestamp` (
	`name` text NOT NULL,
	`timestamp` integer,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`name`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `api_import_timestamp` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_api_import_timestamp`("name", "timestamp", "system_from", "system_to") SELECT "name", "timestamp", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `api_import_timestamp`;--> statement-breakpoint
DROP TABLE `api_import_timestamp`;--> statement-breakpoint
ALTER TABLE `__new_api_import_timestamp` RENAME TO `api_import_timestamp`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_import_timestamp_system_to_idx` ON `api_import_timestamp` (`name`,`system_to`);--> statement-breakpoint
CREATE INDEX `api_import_timestamp_closed_at_idx` ON `api_import_timestamp` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_calendar_layout_applies` (
	`root_id` text NOT NULL,
	`applied_at_system_time` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`root_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `calendar_layout_applies` WHERE "applied_at_system_time" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_calendar_layout_applies`("root_id", "applied_at_system_time", "system_from", "system_to") SELECT "root_id", CASE WHEN "applied_at_system_time" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("applied_at_system_time") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `calendar_layout_applies`;--> statement-breakpoint
DROP TABLE `calendar_layout_applies`;--> statement-breakpoint
ALTER TABLE `__new_calendar_layout_applies` RENAME TO `calendar_layout_applies`;--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_layout_applies_system_to_idx` ON `calendar_layout_applies` (`root_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `calendar_layout_applies_closed_at_idx` ON `calendar_layout_applies` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_changelog_reads` (
	`entry` text NOT NULL,
	`read` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`entry`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `changelog_reads` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_changelog_reads`("entry", "read", "system_from", "system_to") SELECT "entry", "read", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `changelog_reads`;--> statement-breakpoint
DROP TABLE `changelog_reads`;--> statement-breakpoint
ALTER TABLE `__new_changelog_reads` RENAME TO `changelog_reads`;--> statement-breakpoint
CREATE UNIQUE INDEX `changelog_reads_system_to_idx` ON `changelog_reads` (`entry`,`system_to`);--> statement-breakpoint
CREATE INDEX `changelog_reads_closed_at_idx` ON `changelog_reads` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_enabled_features` (
	`codename` text NOT NULL,
	`enabled` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`codename`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `enabled_features` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_enabled_features`("codename", "enabled", "system_from", "system_to") SELECT "codename", "enabled", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `enabled_features`;--> statement-breakpoint
DROP TABLE `enabled_features`;--> statement-breakpoint
ALTER TABLE `__new_enabled_features` RENAME TO `enabled_features`;--> statement-breakpoint
CREATE UNIQUE INDEX `enabled_features_system_to_idx` ON `enabled_features` (`codename`,`system_to`);--> statement-breakpoint
CREATE INDEX `enabled_features_closed_at_idx` ON `enabled_features` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_expanded_nodes` (
	`short_key` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`short_key`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `expanded_nodes` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_expanded_nodes`("short_key", "system_from", "system_to") SELECT "short_key", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `expanded_nodes`;--> statement-breakpoint
DROP TABLE `expanded_nodes`;--> statement-breakpoint
ALTER TABLE `__new_expanded_nodes` RENAME TO `expanded_nodes`;--> statement-breakpoint
CREATE UNIQUE INDEX `expanded_nodes_system_to_idx` ON `expanded_nodes` (`short_key`,`system_to`);--> statement-breakpoint
CREATE INDEX `expanded_nodes_closed_at_idx` ON `expanded_nodes` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_file_blobs` (
	`node_id` text NOT NULL,
	`status` text NOT NULL,
	`sha256` text,
	`size` integer,
	`content_type` text,
	`local_path` text,
	`error` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `file_blobs` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_file_blobs`("node_id", "status", "sha256", "size", "content_type", "local_path", "error", "system_from", "system_to") SELECT "node_id", "status", "sha256", "size", "content_type", "local_path", "error", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `file_blobs`;--> statement-breakpoint
DROP TABLE `file_blobs`;--> statement-breakpoint
ALTER TABLE `__new_file_blobs` RENAME TO `file_blobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `file_blobs_system_to_idx` ON `file_blobs` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `file_blobs_closed_at_idx` ON `file_blobs` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_location_renames` (
	`location_key` text NOT NULL,
	`name` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`location_key`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `location_renames` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_location_renames`("location_key", "name", "system_from", "system_to") SELECT "location_key", "name", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `location_renames`;--> statement-breakpoint
DROP TABLE `location_renames`;--> statement-breakpoint
ALTER TABLE `__new_location_renames` RENAME TO `location_renames`;--> statement-breakpoint
CREATE UNIQUE INDEX `location_renames_system_to_idx` ON `location_renames` (`location_key`,`system_to`);--> statement-breakpoint
CREATE INDEX `location_renames_closed_at_idx` ON `location_renames` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_node_content` (
	`id` text NOT NULL,
	`name` text,
	`note` text,
	`parent_id` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `node_content` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_node_content`("id", "name", "note", "parent_id", "system_from", "system_to") SELECT "id", "name", "note", "parent_id", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `node_content`;--> statement-breakpoint
DROP TABLE `node_content`;--> statement-breakpoint
ALTER TABLE `__new_node_content` RENAME TO `node_content`;--> statement-breakpoint
CREATE UNIQUE INDEX `node_content_system_to_idx` ON `node_content` (`id`,`system_to`);--> statement-breakpoint
CREATE UNIQUE INDEX `node_content_parent_idx` ON `node_content` (`parent_id`,`system_from`,`system_to`,`id`);--> statement-breakpoint
CREATE INDEX `node_content_system_from_idx` ON `node_content` (`system_from`);--> statement-breakpoint
CREATE INDEX `node_content_closed_at_idx` ON `node_content` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_node_display_metadata` (
	`node_id` text NOT NULL,
	`numbered_start` integer,
	`restorable_unique_node` integer,
	`table_headers` integer,
	`table_skip_headers` integer,
	`table_bg` text,
	`priority_default_to_bottom` integer,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `node_display_metadata` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_node_display_metadata`("node_id", "numbered_start", "restorable_unique_node", "table_headers", "table_skip_headers", "table_bg", "priority_default_to_bottom", "system_from", "system_to") SELECT "node_id", "numbered_start", "restorable_unique_node", "table_headers", "table_skip_headers", "table_bg", "priority_default_to_bottom", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `node_display_metadata`;--> statement-breakpoint
DROP TABLE `node_display_metadata`;--> statement-breakpoint
ALTER TABLE `__new_node_display_metadata` RENAME TO `node_display_metadata`;--> statement-breakpoint
CREATE UNIQUE INDEX `node_display_metadata_system_to_idx` ON `node_display_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_display_metadata_closed_at_idx` ON `node_display_metadata` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_node_label_suggestions` (
	`node_id` text NOT NULL,
	`label` text NOT NULL,
	`label_kind` text NOT NULL,
	`source` text NOT NULL,
	`score` real NOT NULL,
	`content_from` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `label`, `source`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `node_label_suggestions` WHERE "content_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_node_label_suggestions`("node_id", "label", "label_kind", "source", "score", "content_from", "system_from", "system_to") SELECT "node_id", "label", "label_kind", "source", "score", CASE WHEN "content_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("content_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `node_label_suggestions`;--> statement-breakpoint
DROP TABLE `node_label_suggestions`;--> statement-breakpoint
ALTER TABLE `__new_node_label_suggestions` RENAME TO `node_label_suggestions`;--> statement-breakpoint
CREATE UNIQUE INDEX `node_label_suggestions_system_to_idx` ON `node_label_suggestions` (`node_id`,`label`,`source`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_label_suggestions_closed_at_idx` ON `node_label_suggestions` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_node_metadata` (
	`node_id` text NOT NULL,
	`short_id` text,
	`order_key` text,
	`created_at` integer,
	`modified_at` integer,
	`completed_at` integer,
	`layout_mode` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `node_metadata` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_node_metadata`("node_id", "short_id", "order_key", "created_at", "modified_at", "completed_at", "layout_mode", "system_from", "system_to") SELECT "node_id", "short_id", "order_key", "created_at", "modified_at", "completed_at", "layout_mode", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `node_metadata`;--> statement-breakpoint
DROP TABLE `node_metadata`;--> statement-breakpoint
ALTER TABLE `__new_node_metadata` RENAME TO `node_metadata`;--> statement-breakpoint
CREATE UNIQUE INDEX `node_metadata_system_to_idx` ON `node_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_metadata_short_id_idx` ON `node_metadata` (`short_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_metadata_system_from_idx` ON `node_metadata` (`system_from`);--> statement-breakpoint
CREATE INDEX `node_metadata_closed_at_idx` ON `node_metadata` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_node_table_cell_sizes` (
	`node_id` text NOT NULL,
	`cell_id` text NOT NULL,
	`size` real NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `cell_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `node_table_cell_sizes` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_node_table_cell_sizes`("node_id", "cell_id", "size", "system_from", "system_to") SELECT "node_id", "cell_id", "size", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `node_table_cell_sizes`;--> statement-breakpoint
DROP TABLE `node_table_cell_sizes`;--> statement-breakpoint
ALTER TABLE `__new_node_table_cell_sizes` RENAME TO `node_table_cell_sizes`;--> statement-breakpoint
CREATE UNIQUE INDEX `node_table_cell_sizes_system_to_idx` ON `node_table_cell_sizes` (`node_id`,`cell_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_table_cell_sizes_closed_at_idx` ON `node_table_cell_sizes` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_outbox` (
	`node_id` text NOT NULL,
	`aspect` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`last_error` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `aspect`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `outbox` WHERE "enqueued_at" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_outbox`("node_id", "aspect", "enqueued_at", "last_error", "system_from", "system_to") SELECT "node_id", "aspect", CASE WHEN "enqueued_at" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("enqueued_at") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, "last_error", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_system_to_idx` ON `outbox` (`node_id`,`aspect`,`system_to`);--> statement-breakpoint
CREATE INDEX `outbox_closed_at_idx` ON `outbox` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_root_preferences` (
	`user_id` text NOT NULL,
	`date_format` text,
	`time_format` text,
	`week_start_day` integer,
	`slash_discovered` integer,
	`notes_root_id` text,
	`weekly_report_on` integer,
	`home_layout_mode` text,
	`latest_color_attribute` integer,
	`latest_color_value` integer,
	`search_for_changes_after` integer,
	`starring_is_synced` integer,
	`ai_embedding_status` text,
	`ai_embedding_tooltip_dismissed` integer,
	`ai_mailbox_id` text,
	`cmd_metrics_failed` integer,
	`calendar_root_id` text,
	`calendar_ts_added_v2` integer,
	`calendar_tooltip_seen` integer,
	`calendar_date_id_added_v1` integer,
	`emoji_selected` text,
	`inbox_id` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `root_preferences` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_root_preferences`("user_id", "date_format", "time_format", "week_start_day", "slash_discovered", "notes_root_id", "weekly_report_on", "home_layout_mode", "latest_color_attribute", "latest_color_value", "search_for_changes_after", "starring_is_synced", "ai_embedding_status", "ai_embedding_tooltip_dismissed", "ai_mailbox_id", "cmd_metrics_failed", "calendar_root_id", "calendar_ts_added_v2", "calendar_tooltip_seen", "calendar_date_id_added_v1", "emoji_selected", "inbox_id", "system_from", "system_to") SELECT "user_id", "date_format", "time_format", "week_start_day", "slash_discovered", "notes_root_id", "weekly_report_on", "home_layout_mode", "latest_color_attribute", "latest_color_value", "search_for_changes_after", "starring_is_synced", "ai_embedding_status", "ai_embedding_tooltip_dismissed", "ai_mailbox_id", "cmd_metrics_failed", "calendar_root_id", "calendar_ts_added_v2", "calendar_tooltip_seen", "calendar_date_id_added_v1", "emoji_selected", "inbox_id", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `root_preferences`;--> statement-breakpoint
DROP TABLE `root_preferences`;--> statement-breakpoint
ALTER TABLE `__new_root_preferences` RENAME TO `root_preferences`;--> statement-breakpoint
CREATE UNIQUE INDEX `root_preferences_system_to_idx` ON `root_preferences` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `root_preferences_closed_at_idx` ON `root_preferences` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_saved_views` (
	`position` integer NOT NULL,
	`project_id` text,
	`auxiliary_root_project_id` text,
	`search_query` text,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`position`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `saved_views` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_saved_views`("position", "project_id", "auxiliary_root_project_id", "search_query", "system_from", "system_to") SELECT "position", "project_id", "auxiliary_root_project_id", "search_query", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `saved_views`;--> statement-breakpoint
DROP TABLE `saved_views`;--> statement-breakpoint
ALTER TABLE `__new_saved_views` RENAME TO `saved_views`;--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_system_to_idx` ON `saved_views` (`position`,`system_to`);--> statement-breakpoint
CREATE INDEX `saved_views_closed_at_idx` ON `saved_views` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_star_order` (
	`position` integer NOT NULL,
	`entry` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`position`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `star_order` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_star_order`("position", "entry", "system_from", "system_to") SELECT "position", "entry", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `star_order`;--> statement-breakpoint
DROP TABLE `star_order`;--> statement-breakpoint
ALTER TABLE `__new_star_order` RENAME TO `star_order`;--> statement-breakpoint
CREATE UNIQUE INDEX `star_order_system_to_idx` ON `star_order` (`position`,`system_to`);--> statement-breakpoint
CREATE INDEX `star_order_closed_at_idx` ON `star_order` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_stars` (
	`location_key` text NOT NULL,
	`tree_root` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`location_key`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `stars` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_stars`("location_key", "tree_root", "system_from", "system_to") SELECT "location_key", "tree_root", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `stars`;--> statement-breakpoint
DROP TABLE `stars`;--> statement-breakpoint
ALTER TABLE `__new_stars` RENAME TO `stars`;--> statement-breakpoint
CREATE UNIQUE INDEX `stars_system_to_idx` ON `stars` (`location_key`,`system_to`);--> statement-breakpoint
CREATE INDEX `stars_closed_at_idx` ON `stars` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_surveys` (
	`survey` text NOT NULL,
	`status` text,
	`rating` integer,
	`at` integer,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`survey`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `surveys` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_surveys`("survey", "status", "rating", "at", "system_from", "system_to") SELECT "survey", "status", "rating", "at", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `surveys`;--> statement-breakpoint
DROP TABLE `surveys`;--> statement-breakpoint
ALTER TABLE `__new_surveys` RENAME TO `surveys`;--> statement-breakpoint
CREATE UNIQUE INDEX `surveys_system_to_idx` ON `surveys` (`survey`,`system_to`);--> statement-breakpoint
CREATE INDEX `surveys_closed_at_idx` ON `surveys` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_tag_colors` (
	`tag` text NOT NULL,
	`color_index` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`tag`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `tag_colors` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_tag_colors`("tag", "color_index", "system_from", "system_to") SELECT "tag", "color_index", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `tag_colors`;--> statement-breakpoint
DROP TABLE `tag_colors`;--> statement-breakpoint
ALTER TABLE `__new_tag_colors` RENAME TO `tag_colors`;--> statement-breakpoint
CREATE UNIQUE INDEX `tag_colors_system_to_idx` ON `tag_colors` (`tag`,`system_to`);--> statement-breakpoint
CREATE INDEX `tag_colors_closed_at_idx` ON `tag_colors` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_tree_transactions` (
	`tree_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`tree_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `tree_transactions` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_tree_transactions`("tree_id", "transaction_id", "system_from", "system_to") SELECT "tree_id", "transaction_id", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `tree_transactions`;--> statement-breakpoint
DROP TABLE `tree_transactions`;--> statement-breakpoint
ALTER TABLE `__new_tree_transactions` RENAME TO `tree_transactions`;--> statement-breakpoint
CREATE UNIQUE INDEX `tree_transactions_system_to_idx` ON `tree_transactions` (`tree_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `tree_transactions_closed_at_idx` ON `tree_transactions` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_visible_features` (
	`codename` text NOT NULL,
	`name` text NOT NULL,
	`label` text,
	`description` text,
	`position` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`codename`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `visible_features` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_visible_features`("codename", "name", "label", "description", "position", "system_from", "system_to") SELECT "codename", "name", "label", "description", "position", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `visible_features`;--> statement-breakpoint
DROP TABLE `visible_features`;--> statement-breakpoint
ALTER TABLE `__new_visible_features` RENAME TO `visible_features`;--> statement-breakpoint
CREATE UNIQUE INDEX `visible_features_system_to_idx` ON `visible_features` (`codename`,`system_to`);--> statement-breakpoint
CREATE INDEX `visible_features_closed_at_idx` ON `visible_features` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_whats_new_reads` (
	`entry` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`entry`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `whats_new_reads` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_whats_new_reads`("entry", "system_from", "system_to") SELECT "entry", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `whats_new_reads`;--> statement-breakpoint
DROP TABLE `whats_new_reads`;--> statement-breakpoint
ALTER TABLE `__new_whats_new_reads` RENAME TO `whats_new_reads`;--> statement-breakpoint
CREATE UNIQUE INDEX `whats_new_reads_system_to_idx` ON `whats_new_reads` (`entry`,`system_to`);--> statement-breakpoint
CREATE INDEX `whats_new_reads_closed_at_idx` ON `whats_new_reads` (`system_to`) WHERE system_to < 9007199254740991;--> statement-breakpoint
CREATE TABLE `__new_ai_metadata` (
	`node_id` text NOT NULL,
	`in_chat` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `ai_metadata` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_ai_metadata`("node_id", "in_chat", "system_from", "system_to") SELECT "node_id", "in_chat", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `ai_metadata`;--> statement-breakpoint
DROP TABLE `ai_metadata`;--> statement-breakpoint
ALTER TABLE `__new_ai_metadata` RENAME TO `ai_metadata`;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_metadata_system_to_idx` ON `ai_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `__new_backup_imports` (
	`filename` text NOT NULL,
	`backup_date` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`filename`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `backup_imports` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_backup_imports`("filename", "backup_date", "system_from", "system_to") SELECT "filename", "backup_date", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `backup_imports`;--> statement-breakpoint
DROP TABLE `backup_imports`;--> statement-breakpoint
ALTER TABLE `__new_backup_imports` RENAME TO `backup_imports`;--> statement-breakpoint
CREATE UNIQUE INDEX `backup_imports_system_to_idx` ON `backup_imports` (`filename`,`system_to`);--> statement-breakpoint
CREATE TABLE `__new_calendar_levels` (
	`node_id` text NOT NULL,
	`day` integer,
	`week` integer,
	`month` integer,
	`year` integer,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `calendar_levels` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_calendar_levels`("node_id", "day", "week", "month", "year", "system_from", "system_to") SELECT "node_id", "day", "week", "month", "year", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `calendar_levels`;--> statement-breakpoint
DROP TABLE `calendar_levels`;--> statement-breakpoint
ALTER TABLE `__new_calendar_levels` RENAME TO `calendar_levels`;--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_levels_system_to_idx` ON `calendar_levels` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `__new_calendar_metadata` (
	`node_id` text NOT NULL,
	`root` integer,
	`level` text,
	`value` text,
	`date_id` integer,
	`timestamp` integer,
	`found_dates` integer,
	`day_prefix` integer,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `calendar_metadata` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_calendar_metadata`("node_id", "root", "level", "value", "date_id", "timestamp", "found_dates", "day_prefix", "system_from", "system_to") SELECT "node_id", "root", "level", "value", "date_id", "timestamp", "found_dates", "day_prefix", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `calendar_metadata`;--> statement-breakpoint
DROP TABLE `calendar_metadata`;--> statement-breakpoint
ALTER TABLE `__new_calendar_metadata` RENAME TO `calendar_metadata`;--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_metadata_system_to_idx` ON `calendar_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `calendar_metadata_root_idx` ON `calendar_metadata` (`root`,`system_to`);--> statement-breakpoint
CREATE INDEX `calendar_metadata_level_idx` ON `calendar_metadata` (`level`,`system_to`,`date_id`);--> statement-breakpoint
CREATE TABLE `__new_changes_metadata` (
	`node_id` text NOT NULL,
	`ct_by` integer NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `changes_metadata` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_changes_metadata`("node_id", "ct_by", "system_from", "system_to") SELECT "node_id", "ct_by", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `changes_metadata`;--> statement-breakpoint
DROP TABLE `changes_metadata`;--> statement-breakpoint
ALTER TABLE `__new_changes_metadata` RENAME TO `changes_metadata`;--> statement-breakpoint
CREATE UNIQUE INDEX `changes_metadata_system_to_idx` ON `changes_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `__new_mirrors` (
	`mirror_id` text NOT NULL,
	`original_id` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`mirror_id`, `original_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `mirrors` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_mirrors`("mirror_id", "original_id", "system_from", "system_to") SELECT "mirror_id", "original_id", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `mirrors`;--> statement-breakpoint
DROP TABLE `mirrors`;--> statement-breakpoint
ALTER TABLE `__new_mirrors` RENAME TO `mirrors`;--> statement-breakpoint
CREATE UNIQUE INDEX `mirrors_system_to_idx` ON `mirrors` (`mirror_id`,`original_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `mirrors_mirror_idx` ON `mirrors` (`mirror_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `mirrors_original_idx` ON `mirrors` (`original_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `__new_node_embeddings` (
	`node_id` text NOT NULL,
	`model` text DEFAULT 'minilm' NOT NULL,
	`embedding` blob NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `model`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `node_embeddings` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_node_embeddings`("node_id", "model", "embedding", "system_from", "system_to") SELECT "node_id", "model", "embedding", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `node_embeddings`;--> statement-breakpoint
DROP TABLE `node_embeddings`;--> statement-breakpoint
ALTER TABLE `__new_node_embeddings` RENAME TO `node_embeddings`;--> statement-breakpoint
CREATE UNIQUE INDEX `node_embeddings_system_to_idx` ON `node_embeddings` (`node_id`,`model`,`system_to`);--> statement-breakpoint
CREATE TABLE `__new_references_roots` (
	`node_id` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `references_roots` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_references_roots`("node_id", "system_from", "system_to") SELECT "node_id", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `references_roots`;--> statement-breakpoint
DROP TABLE `references_roots`;--> statement-breakpoint
ALTER TABLE `__new_references_roots` RENAME TO `references_roots`;--> statement-breakpoint
CREATE UNIQUE INDEX `references_roots_system_to_idx` ON `references_roots` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `__new_s3_files` (
	`node_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_type` text NOT NULL,
	`object_folder` text,
	`is_animated_gif` integer,
	`image_original_width` integer,
	`image_original_height` integer,
	`image_original_pixels` integer,
	`is_deleted` integer,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
DELETE FROM `s3_files` WHERE "system_from" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*' OR "system_to" NOT GLOB '[0-9][0-9][0-9][0-9]-??-?? ??:??:??*';--> statement-breakpoint
INSERT INTO `__new_s3_files`("node_id", "file_name", "file_type", "object_folder", "is_animated_gif", "image_original_width", "image_original_height", "image_original_pixels", "is_deleted", "system_from", "system_to") SELECT "node_id", "file_name", "file_type", "object_folder", "is_animated_gif", "image_original_width", "image_original_height", "image_original_pixels", "is_deleted", CASE WHEN "system_from" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_from") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END, CASE WHEN "system_to" = '9999-12-31 23:59:59' THEN 9007199254740991 ELSE CAST(round((julianday("system_to") - 2440587.5) * 86400000.0) AS INTEGER) * 1000 END FROM `s3_files`;--> statement-breakpoint
DROP TABLE `s3_files`;--> statement-breakpoint
ALTER TABLE `__new_s3_files` RENAME TO `s3_files`;--> statement-breakpoint
CREATE UNIQUE INDEX `s3_files_system_to_idx` ON `s3_files` (`node_id`,`system_to`);
