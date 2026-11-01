CREATE TABLE `account` (
	`user_id` integer NOT NULL,
	`full_name` text,
	`date_joined_sec` integer NOT NULL,
	`entropy_key` text,
	`username` text,
	`email` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_system_to_idx` ON `account` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_closed_at_idx` ON `account` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `account_settings` (
	`user_id` integer NOT NULL,
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
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_settings_system_to_idx` ON `account_settings` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_settings_closed_at_idx` ON `account_settings` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `ai_assistants` (
	`assistant_id` text NOT NULL,
	`name` text,
	`model` text,
	`system_user_id` integer,
	`position` integer NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`assistant_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_assistants_system_to_idx` ON `ai_assistants` (`assistant_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `ai_assistants_closed_at_idx` ON `ai_assistants` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `ai_metadata` (
	`node_id` text NOT NULL,
	`in_chat` integer NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_metadata_system_to_idx` ON `ai_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `ai_prompt_buttons` (
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`button_id` text,
	`name` text,
	`icon` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`kind`, `position`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_prompt_buttons_system_to_idx` ON `ai_prompt_buttons` (`kind`,`position`,`system_to`);--> statement-breakpoint
CREATE INDEX `ai_prompt_buttons_closed_at_idx` ON `ai_prompt_buttons` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `api_import_timestamp` (
	`name` text NOT NULL,
	`timestamp` integer,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`name`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_import_timestamp_system_to_idx` ON `api_import_timestamp` (`name`,`system_to`);--> statement-breakpoint
CREATE INDEX `api_import_timestamp_closed_at_idx` ON `api_import_timestamp` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `backup_imports` (
	`filename` text NOT NULL,
	`backup_date` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`filename`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_imports_system_to_idx` ON `backup_imports` (`filename`,`system_to`);--> statement-breakpoint
CREATE TABLE `calendar_layout_applies` (
	`root_id` text NOT NULL,
	`applied_at_system_time` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`root_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_layout_applies_system_to_idx` ON `calendar_layout_applies` (`root_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `calendar_layout_applies_closed_at_idx` ON `calendar_layout_applies` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `calendar_levels` (
	`node_id` text NOT NULL,
	`day` integer,
	`week` integer,
	`month` integer,
	`year` integer,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_levels_system_to_idx` ON `calendar_levels` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `calendar_metadata` (
	`node_id` text NOT NULL,
	`root` integer,
	`level` text,
	`value` text,
	`date_id` integer,
	`timestamp` integer,
	`found_dates` integer,
	`day_prefix` integer,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_metadata_system_to_idx` ON `calendar_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `calendar_metadata_root_idx` ON `calendar_metadata` (`root`,`system_to`);--> statement-breakpoint
CREATE INDEX `calendar_metadata_level_idx` ON `calendar_metadata` (`level`,`system_to`,`date_id`);--> statement-breakpoint
CREATE TABLE `changelog_reads` (
	`entry` text NOT NULL,
	`read` integer NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`entry`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `changelog_reads_system_to_idx` ON `changelog_reads` (`entry`,`system_to`);--> statement-breakpoint
CREATE INDEX `changelog_reads_closed_at_idx` ON `changelog_reads` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `changes_metadata` (
	`node_id` text NOT NULL,
	`ct_by` integer NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `changes_metadata_system_to_idx` ON `changes_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `enabled_features` (
	`codename` text NOT NULL,
	`enabled` integer NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`codename`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enabled_features_system_to_idx` ON `enabled_features` (`codename`,`system_to`);--> statement-breakpoint
CREATE INDEX `enabled_features_closed_at_idx` ON `enabled_features` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `expanded_nodes` (
	`short_key` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`short_key`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expanded_nodes_system_to_idx` ON `expanded_nodes` (`short_key`,`system_to`);--> statement-breakpoint
CREATE INDEX `expanded_nodes_closed_at_idx` ON `expanded_nodes` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `file_blobs` (
	`node_id` text NOT NULL,
	`status` text NOT NULL,
	`sha256` text,
	`size` integer,
	`content_type` text,
	`local_path` text,
	`error` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_blobs_system_to_idx` ON `file_blobs` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `file_blobs_closed_at_idx` ON `file_blobs` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `location_renames` (
	`location_key` text NOT NULL,
	`name` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`location_key`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_renames_system_to_idx` ON `location_renames` (`location_key`,`system_to`);--> statement-breakpoint
CREATE INDEX `location_renames_closed_at_idx` ON `location_renames` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `mirrors` (
	`mirror_id` text NOT NULL,
	`original_id` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`mirror_id`, `original_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mirrors_system_to_idx` ON `mirrors` (`mirror_id`,`original_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `mirrors_mirror_idx` ON `mirrors` (`mirror_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `mirrors_original_idx` ON `mirrors` (`original_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `node_content` (
	`id` text NOT NULL,
	`name` text,
	`note` text,
	`parent_id` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_content_system_to_idx` ON `node_content` (`id`,`system_to`);--> statement-breakpoint
CREATE UNIQUE INDEX `node_content_parent_idx` ON `node_content` (`parent_id`,`system_from`,`system_to`,`id`);--> statement-breakpoint
CREATE INDEX `node_content_system_from_idx` ON `node_content` (`system_from`);--> statement-breakpoint
CREATE INDEX `node_content_closed_at_idx` ON `node_content` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `node_display_metadata` (
	`node_id` text NOT NULL,
	`numbered_start` integer,
	`restorable_unique_node` integer,
	`table_headers` integer,
	`table_skip_headers` integer,
	`table_bg` text,
	`priority_default_to_bottom` integer,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_display_metadata_system_to_idx` ON `node_display_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_display_metadata_closed_at_idx` ON `node_display_metadata` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `node_embeddings` (
	`node_id` text NOT NULL,
	`model` text DEFAULT 'minilm' NOT NULL,
	`embedding` blob NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `model`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_embeddings_system_to_idx` ON `node_embeddings` (`node_id`,`model`,`system_to`);--> statement-breakpoint
CREATE TABLE `node_metadata` (
	`node_id` text NOT NULL,
	`short_id` text,
	`priority` integer,
	`created_at` integer,
	`modified_at` integer,
	`completed_at` integer,
	`layout_mode` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_metadata_system_to_idx` ON `node_metadata` (`node_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_metadata_short_id_idx` ON `node_metadata` (`short_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_metadata_system_from_idx` ON `node_metadata` (`system_from`);--> statement-breakpoint
CREATE INDEX `node_metadata_closed_at_idx` ON `node_metadata` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `node_table_cell_sizes` (
	`node_id` text NOT NULL,
	`cell_id` text NOT NULL,
	`size` real NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `cell_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_table_cell_sizes_system_to_idx` ON `node_table_cell_sizes` (`node_id`,`cell_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_table_cell_sizes_closed_at_idx` ON `node_table_cell_sizes` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `node_tags` (
	`node_id` text NOT NULL,
	`tag_key` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`node_id`, `tag_key`)
);
--> statement-breakpoint
CREATE INDEX `node_tags_tag_key_idx` ON `node_tags` (`tag_key`);--> statement-breakpoint
CREATE TABLE `references_roots` (
	`node_id` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `references_roots_system_to_idx` ON `references_roots` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `root_preferences` (
	`user_id` integer NOT NULL,
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
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `root_preferences_system_to_idx` ON `root_preferences` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `root_preferences_closed_at_idx` ON `root_preferences` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `s3_files` (
	`node_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_type` text NOT NULL,
	`object_folder` text,
	`is_animated_gif` integer,
	`image_original_width` integer,
	`image_original_height` integer,
	`image_original_pixels` integer,
	`is_deleted` integer,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `s3_files_system_to_idx` ON `s3_files` (`node_id`,`system_to`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`position` integer NOT NULL,
	`project_id` text,
	`auxiliary_root_project_id` text,
	`search_query` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`position`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_system_to_idx` ON `saved_views` (`position`,`system_to`);--> statement-breakpoint
CREATE INDEX `saved_views_closed_at_idx` ON `saved_views` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `star_order` (
	`position` integer NOT NULL,
	`entry` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`position`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `star_order_system_to_idx` ON `star_order` (`position`,`system_to`);--> statement-breakpoint
CREATE INDEX `star_order_closed_at_idx` ON `star_order` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `stars` (
	`location_key` text NOT NULL,
	`tree_root` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`location_key`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stars_system_to_idx` ON `stars` (`location_key`,`system_to`);--> statement-breakpoint
CREATE INDEX `stars_closed_at_idx` ON `stars` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `surveys` (
	`survey` text NOT NULL,
	`status` text,
	`rating` integer,
	`at` integer,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`survey`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `surveys_system_to_idx` ON `surveys` (`survey`,`system_to`);--> statement-breakpoint
CREATE INDEX `surveys_closed_at_idx` ON `surveys` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `tag_colors` (
	`tag` text NOT NULL,
	`color_index` integer NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`tag`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_colors_system_to_idx` ON `tag_colors` (`tag`,`system_to`);--> statement-breakpoint
CREATE INDEX `tag_colors_closed_at_idx` ON `tag_colors` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `tree_transactions` (
	`tree_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`tree_id`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tree_transactions_system_to_idx` ON `tree_transactions` (`tree_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `tree_transactions_closed_at_idx` ON `tree_transactions` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `visible_features` (
	`codename` text NOT NULL,
	`name` text NOT NULL,
	`label` text,
	`description` text,
	`position` integer NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`codename`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visible_features_system_to_idx` ON `visible_features` (`codename`,`system_to`);--> statement-breakpoint
CREATE INDEX `visible_features_closed_at_idx` ON `visible_features` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
CREATE TABLE `whats_new_reads` (
	`entry` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`entry`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `whats_new_reads_system_to_idx` ON `whats_new_reads` (`entry`,`system_to`);--> statement-breakpoint
CREATE INDEX `whats_new_reads_closed_at_idx` ON `whats_new_reads` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
-- Full-text index for keyword search; drizzle-kit does not generate virtual tables.
CREATE VIRTUAL TABLE node_fts USING fts5(
    node_id UNINDEXED,
    content,
    tokenize='porter unicode61'
);
