CREATE TABLE `__new_account` (
	`user_id` text NOT NULL,
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
INSERT INTO `__new_account`("user_id", "full_name", "date_joined_sec", "entropy_key", "username", "email", "system_from", "system_to") SELECT "user_id", "full_name", "date_joined_sec", "entropy_key", "username", "email", "system_from", "system_to" FROM `account`;--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_system_to_idx` ON `account` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_closed_at_idx` ON `account` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
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
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
INSERT INTO `__new_account_settings`("user_id", "theme", "font", "timezone", "show_completed", "show_keyboard_shortcuts", "same_color_for_links", "display_image_previews_as_thumbnails", "ignore_youtube", "ignore_yt_short", "ignore_twitter", "ignore_loom", "unsubscribe_from_summary_emails", "unsubscribe_from_comments_emails", "backup_to_dropbox", "mfa_enabled", "ai_default_agent_id", "ai_context_limit", "system_from", "system_to") SELECT "user_id", "theme", "font", "timezone", "show_completed", "show_keyboard_shortcuts", "same_color_for_links", "display_image_previews_as_thumbnails", "ignore_youtube", "ignore_yt_short", "ignore_twitter", "ignore_loom", "unsubscribe_from_summary_emails", "unsubscribe_from_comments_emails", "backup_to_dropbox", "mfa_enabled", "ai_default_agent_id", "ai_context_limit", "system_from", "system_to" FROM `account_settings`;--> statement-breakpoint
DROP TABLE `account_settings`;--> statement-breakpoint
ALTER TABLE `__new_account_settings` RENAME TO `account_settings`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_settings_system_to_idx` ON `account_settings` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_settings_closed_at_idx` ON `account_settings` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';--> statement-breakpoint
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
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`user_id`, `system_from`)
);
--> statement-breakpoint
INSERT INTO `__new_root_preferences`("user_id", "date_format", "time_format", "week_start_day", "slash_discovered", "notes_root_id", "weekly_report_on", "home_layout_mode", "latest_color_attribute", "latest_color_value", "search_for_changes_after", "starring_is_synced", "ai_embedding_status", "ai_embedding_tooltip_dismissed", "ai_mailbox_id", "cmd_metrics_failed", "calendar_root_id", "calendar_ts_added_v2", "calendar_tooltip_seen", "calendar_date_id_added_v1", "emoji_selected", "inbox_id", "system_from", "system_to") SELECT "user_id", "date_format", "time_format", "week_start_day", "slash_discovered", "notes_root_id", "weekly_report_on", "home_layout_mode", "latest_color_attribute", "latest_color_value", "search_for_changes_after", "starring_is_synced", "ai_embedding_status", "ai_embedding_tooltip_dismissed", "ai_mailbox_id", "cmd_metrics_failed", "calendar_root_id", "calendar_ts_added_v2", "calendar_tooltip_seen", "calendar_date_id_added_v1", "emoji_selected", "inbox_id", "system_from", "system_to" FROM `root_preferences`;--> statement-breakpoint
DROP TABLE `root_preferences`;--> statement-breakpoint
ALTER TABLE `__new_root_preferences` RENAME TO `root_preferences`;--> statement-breakpoint
CREATE UNIQUE INDEX `root_preferences_system_to_idx` ON `root_preferences` (`user_id`,`system_to`);--> statement-breakpoint
CREATE INDEX `root_preferences_closed_at_idx` ON `root_preferences` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';
