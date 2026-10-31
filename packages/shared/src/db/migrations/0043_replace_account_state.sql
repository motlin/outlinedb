-- 👤 Replace the JSON account_state and local_settings stores with typed temporal account tables.
-- Each upstream key gets a column or a row; local_settings (the durable copy of every value written
-- to workflowy.com) is merged in and wins over account_state where both hold a value. account_state
-- keeps only calendar_layout_undo until undo derives from temporal history. Every backfilled row
-- takes one system time, staged in a scratch table (Durable Object SQLite has no temp tables).
CREATE TABLE api_import_timestamp (
	name TEXT NOT NULL,
	timestamp INTEGER,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (name, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX api_import_timestamp_system_to_idx ON api_import_timestamp (name, system_to);
--> statement-breakpoint
CREATE INDEX api_import_timestamp_closed_at_idx ON api_import_timestamp (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE account (
	user_id INTEGER NOT NULL,
	full_name TEXT,
	date_joined_sec INTEGER NOT NULL,
	entropy_key TEXT,
	username TEXT,
	email TEXT,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (user_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_system_to_idx ON account (user_id, system_to);
--> statement-breakpoint
CREATE INDEX account_closed_at_idx ON account (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE root_preferences (
	user_id INTEGER NOT NULL,
	date_format TEXT,
	time_format TEXT,
	week_start_day INTEGER,
	slash_discovered INTEGER,
	notes_root_id TEXT,
	weekly_report_on INTEGER,
	home_layout_mode TEXT,
	latest_color_attribute INTEGER,
	latest_color_value INTEGER,
	search_for_changes_after INTEGER,
	starring_is_synced INTEGER,
	ai_embedding_status TEXT,
	ai_embedding_tooltip_dismissed INTEGER,
	ai_mailbox_id TEXT,
	cmd_metrics_failed INTEGER,
	calendar_root_id TEXT,
	calendar_ts_added_v2 INTEGER,
	calendar_tooltip_seen INTEGER,
	calendar_date_id_added_v1 INTEGER,
	emoji_selected TEXT,
	inbox_id TEXT,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (user_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX root_preferences_system_to_idx ON root_preferences (user_id, system_to);
--> statement-breakpoint
CREATE INDEX root_preferences_closed_at_idx ON root_preferences (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE account_settings (
	user_id INTEGER NOT NULL,
	theme TEXT,
	font TEXT,
	timezone TEXT,
	show_completed INTEGER,
	show_keyboard_shortcuts INTEGER,
	same_color_for_links INTEGER,
	display_image_previews_as_thumbnails INTEGER,
	ignore_youtube INTEGER,
	ignore_yt_short INTEGER,
	ignore_twitter INTEGER,
	ignore_loom INTEGER,
	unsubscribe_from_summary_emails INTEGER,
	unsubscribe_from_comments_emails INTEGER,
	backup_to_dropbox INTEGER,
	mfa_enabled INTEGER,
	ai_default_agent_id TEXT,
	ai_context_limit INTEGER,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (user_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_settings_system_to_idx ON account_settings (user_id, system_to);
--> statement-breakpoint
CREATE INDEX account_settings_closed_at_idx ON account_settings (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE tag_colors (
	tag TEXT NOT NULL,
	color_index INTEGER NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (tag, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX tag_colors_system_to_idx ON tag_colors (tag, system_to);
--> statement-breakpoint
CREATE INDEX tag_colors_closed_at_idx ON tag_colors (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE stars (
	location_key TEXT NOT NULL,
	tree_root TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (location_key, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX stars_system_to_idx ON stars (location_key, system_to);
--> statement-breakpoint
CREATE INDEX stars_closed_at_idx ON stars (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE star_order (
	position INTEGER NOT NULL,
	entry TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (position, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX star_order_system_to_idx ON star_order (position, system_to);
--> statement-breakpoint
CREATE INDEX star_order_closed_at_idx ON star_order (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE location_renames (
	location_key TEXT NOT NULL,
	name TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (location_key, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX location_renames_system_to_idx ON location_renames (location_key, system_to);
--> statement-breakpoint
CREATE INDEX location_renames_closed_at_idx ON location_renames (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE enabled_features (
	codename TEXT NOT NULL,
	enabled INTEGER NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (codename, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX enabled_features_system_to_idx ON enabled_features (codename, system_to);
--> statement-breakpoint
CREATE INDEX enabled_features_closed_at_idx ON enabled_features (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE visible_features (
	codename TEXT NOT NULL,
	name TEXT NOT NULL,
	label TEXT,
	description TEXT,
	position INTEGER NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (codename, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX visible_features_system_to_idx ON visible_features (codename, system_to);
--> statement-breakpoint
CREATE INDEX visible_features_closed_at_idx ON visible_features (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE expanded_nodes (
	short_key TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (short_key, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX expanded_nodes_system_to_idx ON expanded_nodes (short_key, system_to);
--> statement-breakpoint
CREATE INDEX expanded_nodes_closed_at_idx ON expanded_nodes (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE changelog_reads (
	entry TEXT NOT NULL,
	read INTEGER NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (entry, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX changelog_reads_system_to_idx ON changelog_reads (entry, system_to);
--> statement-breakpoint
CREATE INDEX changelog_reads_closed_at_idx ON changelog_reads (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE surveys (
	survey TEXT NOT NULL,
	status TEXT,
	at INTEGER,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (survey, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX surveys_system_to_idx ON surveys (survey, system_to);
--> statement-breakpoint
CREATE INDEX surveys_closed_at_idx ON surveys (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE saved_views (
	position INTEGER NOT NULL,
	project_id TEXT,
	auxiliary_root_project_id TEXT,
	search_query TEXT,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (position, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX saved_views_system_to_idx ON saved_views (position, system_to);
--> statement-breakpoint
CREATE INDEX saved_views_closed_at_idx ON saved_views (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE ai_assistants (
	assistant_id TEXT NOT NULL,
	name TEXT,
	model TEXT,
	system_user_id INTEGER,
	position INTEGER NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (assistant_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ai_assistants_system_to_idx ON ai_assistants (assistant_id, system_to);
--> statement-breakpoint
CREATE INDEX ai_assistants_closed_at_idx ON ai_assistants (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE ai_prompt_buttons (
	kind TEXT NOT NULL,
	position INTEGER NOT NULL,
	button_id TEXT,
	name TEXT,
	icon TEXT,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (kind, position, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ai_prompt_buttons_system_to_idx ON ai_prompt_buttons (kind, position, system_to);
--> statement-breakpoint
CREATE INDEX ai_prompt_buttons_closed_at_idx ON ai_prompt_buttons (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE tree_transactions (
	tree_id TEXT NOT NULL,
	transaction_id TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (tree_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX tree_transactions_system_to_idx ON tree_transactions (tree_id, system_to);
--> statement-breakpoint
CREATE INDEX tree_transactions_closed_at_idx ON tree_transactions (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE migration_0043_system_time AS SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS system_time;
--> statement-breakpoint
CREATE TABLE migration_0043_state (account TEXT, root TEXT, settings TEXT);
--> statement-breakpoint
INSERT INTO migration_0043_state (account, root, settings)
SELECT
	(SELECT json FROM account_state WHERE key = 'account'),
	COALESCE((SELECT json FROM account_state WHERE key = 'root_metadata' AND json_type(json) = 'object'), '{}'),
	COALESCE((SELECT json FROM account_state WHERE key = 'settings' AND json_type(json) = 'object'), '{}');
--> statement-breakpoint
-- local_settings wins: overlay each durable value onto the cached document.
UPDATE migration_0043_state SET root = json_set(root, '$.dateFormat', json((SELECT json FROM local_settings WHERE key = 'root:dateFormat')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:dateFormat');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$.timeFormat', json((SELECT json FROM local_settings WHERE key = 'root:timeFormat')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:timeFormat');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$.weekStartDay', json((SELECT json FROM local_settings WHERE key = 'root:weekStartDay')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:weekStartDay');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$.slash.discovered', json((SELECT json FROM local_settings WHERE key = 'root:slashDiscovered')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:slashDiscovered');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$.notesRootId', json((SELECT json FROM local_settings WHERE key = 'root:notesRootId')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:notesRootId');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$."weekly-report".on', json((SELECT json FROM local_settings WHERE key = 'root:weeklyReportOn')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:weeklyReportOn');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$.starring.locations', json((SELECT json FROM local_settings WHERE key = 'root:starring.locations')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:starring.locations');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$.starring.order', json((SELECT json FROM local_settings WHERE key = 'root:starring.order')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:starring.order');
--> statement-breakpoint
UPDATE migration_0043_state SET root = json_set(root, '$.location.renamed', json((SELECT json FROM local_settings WHERE key = 'root:location.renamed')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'root:location.renamed');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.theme', json((SELECT json FROM local_settings WHERE key = 'setting:theme')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:theme');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.font', json((SELECT json FROM local_settings WHERE key = 'setting:font')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:font');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.show_completed', json((SELECT json FROM local_settings WHERE key = 'setting:show_completed')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:show_completed');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.show_keyboard_shortcuts', json((SELECT json FROM local_settings WHERE key = 'setting:show_keyboard_shortcuts')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:show_keyboard_shortcuts');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.same_color_for_links', json((SELECT json FROM local_settings WHERE key = 'setting:same_color_for_links')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:same_color_for_links');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.display_image_previews_as_thumbnails', json((SELECT json FROM local_settings WHERE key = 'setting:display_image_previews_as_thumbnails')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:display_image_previews_as_thumbnails');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.ignore_youtube', json((SELECT json FROM local_settings WHERE key = 'setting:ignore_youtube')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:ignore_youtube');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.ignore_yt_short', json((SELECT json FROM local_settings WHERE key = 'setting:ignore_yt_short')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:ignore_yt_short');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.ignore_twitter', json((SELECT json FROM local_settings WHERE key = 'setting:ignore_twitter')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:ignore_twitter');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.ignore_loom', json((SELECT json FROM local_settings WHERE key = 'setting:ignore_loom')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:ignore_loom');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.unsubscribe_from_summary_emails', json((SELECT json FROM local_settings WHERE key = 'setting:unsubscribe_from_summary_emails')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:unsubscribe_from_summary_emails');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.unsubscribe_from_comments_emails', json((SELECT json FROM local_settings WHERE key = 'setting:unsubscribe_from_comments_emails')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:unsubscribe_from_comments_emails');
--> statement-breakpoint
UPDATE migration_0043_state SET settings = json_set(settings, '$.features', json((SELECT json FROM local_settings WHERE key = 'setting:features')))
WHERE EXISTS (SELECT 1 FROM local_settings WHERE key = 'setting:features');
--> statement-breakpoint
INSERT INTO account (user_id, full_name, date_joined_sec, entropy_key, username, email, system_from, system_to)
SELECT
	json_extract(account, '$.userId'),
	CASE WHEN json_type(account, '$.fullName') = 'text' THEN json_extract(account, '$.fullName') END,
	json_extract(account, '$.dateJoinedSec'),
	(SELECT json_extract(json, '$') FROM account_state WHERE key = 'entropy_key' AND json_type(json) = 'text'),
	CASE WHEN json_type(settings, '$.username') = 'text' THEN json_extract(settings, '$.username') END,
	CASE WHEN json_type(settings, '$.email') = 'text' THEN json_extract(settings, '$.email') END,
	(SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state
WHERE json_type(account, '$.userId') = 'integer' AND json_type(account, '$.dateJoinedSec') = 'integer';
--> statement-breakpoint
INSERT INTO root_preferences (user_id, date_format, time_format, week_start_day, slash_discovered, notes_root_id, weekly_report_on, home_layout_mode, latest_color_attribute, latest_color_value, search_for_changes_after, starring_is_synced, ai_embedding_status, ai_embedding_tooltip_dismissed, ai_mailbox_id, cmd_metrics_failed, calendar_root_id, calendar_ts_added_v2, calendar_tooltip_seen, calendar_date_id_added_v1, emoji_selected, inbox_id, system_from, system_to)
SELECT
	json_extract(account, '$.userId'),
	CASE WHEN json_type(root, '$.dateFormat') = 'text' THEN json_extract(root, '$.dateFormat') END,
	CASE WHEN json_type(root, '$.timeFormat') = 'text' THEN json_extract(root, '$.timeFormat') END,
	CASE WHEN json_type(root, '$.weekStartDay') = 'integer' THEN json_extract(root, '$.weekStartDay') END,
	CASE json_type(root, '$.slash.discovered') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(root, '$.slash.discovered') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE WHEN json_type(root, '$.notesRootId') = 'text' THEN json_extract(root, '$.notesRootId') END,
	CASE json_type(root, '$."weekly-report".on') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(root, '$."weekly-report".on') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE WHEN json_type(root, '$.layoutMode') = 'text' THEN json_extract(root, '$.layoutMode') END,
	CASE WHEN json_type(root, '$.latestColor.attribute') = 'integer' THEN json_extract(root, '$.latestColor.attribute') END,
	CASE WHEN json_type(root, '$.latestColor.value') = 'integer' THEN json_extract(root, '$.latestColor.value') END,
	CASE WHEN json_type(root, '$.searchForChangesAfter') = 'integer' THEN json_extract(root, '$.searchForChangesAfter') END,
	CASE json_type(root, '$.starring.isSynced') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(root, '$.starring.isSynced') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE WHEN json_type(root, '$.ai.embeddingStatus') = 'text' THEN json_extract(root, '$.ai.embeddingStatus') END,
	CASE json_type(root, '$.ai.embedding_tooltip_dismissed') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(root, '$.ai.embedding_tooltip_dismissed') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE WHEN json_type(root, '$.ai.mailboxId') = 'text' THEN json_extract(root, '$.ai.mailboxId') END,
	CASE WHEN json_type(root, '$.cmd_metrics.failed') = 'integer' THEN json_extract(root, '$.cmd_metrics.failed') END,
	CASE WHEN json_type(root, '$.calendar.rootId') = 'text' THEN json_extract(root, '$.calendar.rootId') END,
	CASE json_type(root, '$.calendar.ts_added_v2') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(root, '$.calendar.ts_added_v2') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(root, '$.calendar.tooltip_seen') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(root, '$.calendar.tooltip_seen') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(root, '$.calendar.dateId_added_v1') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(root, '$.calendar.dateId_added_v1') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE WHEN json_type(root, '$.emoji.options.selected') = 'text' THEN json_extract(root, '$.emoji.options.selected') END,
	CASE WHEN json_type(root, '$.inbox_id') = 'text' THEN json_extract(root, '$.inbox_id') END,
	(SELECT system_time FROM migration_0043_system_time),
	'9999-12-31 23:59:59'
FROM migration_0043_state
WHERE json_type(account, '$.userId') = 'integer' AND json_type(account, '$.dateJoinedSec') = 'integer';
--> statement-breakpoint
INSERT INTO account_settings (user_id, theme, font, timezone, show_completed, show_keyboard_shortcuts, same_color_for_links, display_image_previews_as_thumbnails, ignore_youtube, ignore_yt_short, ignore_twitter, ignore_loom, unsubscribe_from_summary_emails, unsubscribe_from_comments_emails, backup_to_dropbox, mfa_enabled, ai_default_agent_id, ai_context_limit, system_from, system_to)
SELECT
	json_extract(account, '$.userId'),
	CASE WHEN json_type(settings, '$.theme') = 'text' THEN json_extract(settings, '$.theme') END,
	CASE WHEN json_type(settings, '$.font') = 'text' THEN json_extract(settings, '$.font') END,
	CASE WHEN json_type(settings, '$.timezone') = 'text' THEN json_extract(settings, '$.timezone') END,
	CASE json_type(settings, '$.show_completed') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.show_completed') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.show_keyboard_shortcuts') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.show_keyboard_shortcuts') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.same_color_for_links') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.same_color_for_links') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.display_image_previews_as_thumbnails') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.display_image_previews_as_thumbnails') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.ignore_youtube') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.ignore_youtube') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.ignore_yt_short') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.ignore_yt_short') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.ignore_twitter') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.ignore_twitter') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.ignore_loom') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.ignore_loom') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.unsubscribe_from_summary_emails') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.unsubscribe_from_summary_emails') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.unsubscribe_from_comments_emails') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.unsubscribe_from_comments_emails') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.backup_to_dropbox') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.backup_to_dropbox') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE json_type(settings, '$.mfa.enabled') WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE json_extract(settings, '$.mfa.enabled') WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END,
	CASE WHEN json_type(settings, '$.ai.default_agent_id') = 'text' THEN json_extract(settings, '$.ai.default_agent_id') END,
	CASE WHEN json_type(settings, '$.ai.context_limit') = 'integer' THEN json_extract(settings, '$.ai.context_limit') END,
	(SELECT system_time FROM migration_0043_system_time),
	'9999-12-31 23:59:59'
FROM migration_0043_state
WHERE json_type(account, '$.userId') = 'integer' AND json_type(account, '$.dateJoinedSec') = 'integer';
--> statement-breakpoint
INSERT INTO tag_colors (tag, color_index, system_from, system_to)
SELECT t.key, t.value, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(migration_0043_state.root, '$.color.tags') t
WHERE json_type(migration_0043_state.root, '$.color.tags') = 'object' AND t.type = 'integer';
--> statement-breakpoint
INSERT INTO stars (location_key, tree_root, system_from, system_to)
SELECT s.key, s.value, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(migration_0043_state.root, '$.starring.locations') s
WHERE json_type(migration_0043_state.root, '$.starring.locations') = 'object' AND s.type = 'text';
--> statement-breakpoint
INSERT INTO star_order (position, entry, system_from, system_to)
WITH RECURSIVE split(position, entry, rest) AS (
	SELECT -1, '', json_extract(root, '$.starring.order') || ',' FROM migration_0043_state WHERE json_type(root, '$.starring.order') = 'text'
	UNION ALL
	SELECT position + 1, substr(rest, 1, instr(rest, ',') - 1), substr(rest, instr(rest, ',') + 1) FROM split WHERE rest <> ''
)
SELECT position, entry, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59' FROM split WHERE position >= 0;
--> statement-breakpoint
INSERT INTO location_renames (location_key, name, system_from, system_to)
SELECT r.key, r.value, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(migration_0043_state.root, '$.location.renamed') r
WHERE json_type(migration_0043_state.root, '$.location.renamed') = 'object' AND r.type = 'text';
--> statement-breakpoint
INSERT INTO enabled_features (codename, enabled, system_from, system_to)
SELECT codename, enabled, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59' FROM (
	SELECT f.key AS codename,
		CASE f.type WHEN 'true' THEN 1 WHEN 'false' THEN 0 WHEN 'text' THEN CASE f.value WHEN 'yes' THEN 1 WHEN 'no' THEN 0 END END AS enabled
	FROM migration_0043_state, json_each(migration_0043_state.settings, '$.features') f
	WHERE json_type(migration_0043_state.settings, '$.features') = 'object'
)
WHERE enabled IS NOT NULL;
--> statement-breakpoint
INSERT INTO visible_features (codename, name, label, description, position, system_from, system_to)
SELECT json_extract(f.value, '$.codename'), json_extract(f.value, '$.name'),
	CASE WHEN json_type(f.value, '$.label') = 'text' THEN json_extract(f.value, '$.label') END, CASE WHEN json_type(f.value, '$.description') = 'text' THEN json_extract(f.value, '$.description') END, f.key, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM account_state a, json_each(a.json) f
WHERE a.key = 'visible_features' AND json_type(a.json) = 'array'
	AND json_type(f.value, '$.codename') = 'text' AND json_type(f.value, '$.name') = 'text';
--> statement-breakpoint
INSERT INTO changelog_reads (entry, read, system_from, system_to)
SELECT c.key, CASE c.type WHEN 'true' THEN 1 ELSE 0 END, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(migration_0043_state.root, '$.changelog.read') c
WHERE json_type(migration_0043_state.root, '$.changelog.read') = 'object' AND c.type IN ('true', 'false');
--> statement-breakpoint
INSERT INTO surveys (survey, status, at, system_from, system_to)
SELECT v.key, CASE WHEN json_type(v.value, '$.status') = 'text' THEN json_extract(v.value, '$.status') END, CASE WHEN json_type(v.value, '$.at') = 'integer' THEN json_extract(v.value, '$.at') END, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(migration_0043_state.root, '$.surveys') v
WHERE json_type(migration_0043_state.root, '$.surveys') = 'object';
--> statement-breakpoint
INSERT INTO saved_views (position, project_id, auxiliary_root_project_id, search_query, system_from, system_to)
SELECT v.key, CASE WHEN json_type(v.value, '$.zoomedProject.projectid') = 'text' THEN json_extract(v.value, '$.zoomedProject.projectid') END, CASE WHEN json_type(v.value, '$.zoomedProject.auxiliaryRootProjectId') = 'text' THEN json_extract(v.value, '$.zoomedProject.auxiliaryRootProjectId') END,
	CASE WHEN json_type(v.value, '$.searchQuery') = 'text' THEN json_extract(v.value, '$.searchQuery') END, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(json_extract(migration_0043_state.settings, '$.saved_views_json')) v
WHERE json_type(settings, '$.saved_views_json') = 'text' AND json_valid(json_extract(settings, '$.saved_views_json'))
	AND json_type(json_extract(settings, '$.saved_views_json')) = 'array';
--> statement-breakpoint
INSERT INTO ai_assistants (assistant_id, name, model, system_user_id, position, system_from, system_to)
SELECT json_extract(a.value, '$.id'), CASE WHEN json_type(a.value, '$.name') = 'text' THEN json_extract(a.value, '$.name') END, CASE WHEN json_type(a.value, '$.model') = 'text' THEN json_extract(a.value, '$.model') END,
	CASE WHEN json_type(a.value, '$.system_user_id') = 'integer' THEN json_extract(a.value, '$.system_user_id') END, a.key, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(migration_0043_state.settings, '$.ai.assistants') a
WHERE json_type(migration_0043_state.settings, '$.ai.assistants') = 'array' AND json_type(a.value, '$.id') = 'text';
--> statement-breakpoint
INSERT INTO ai_prompt_buttons (kind, position, button_id, name, icon, system_from, system_to)
SELECT k.key, b.key, CASE WHEN json_type(b.value, '$.id') = 'text' THEN json_extract(b.value, '$.id') END, CASE WHEN json_type(b.value, '$.name') = 'text' THEN json_extract(b.value, '$.name') END, CASE WHEN json_type(b.value, '$.icon') = 'text' THEN json_extract(b.value, '$.icon') END, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59'
FROM migration_0043_state, json_each(migration_0043_state.settings, '$.ai.prompt_buttons') k, json_each(k.value) b
WHERE json_type(migration_0043_state.settings, '$.ai.prompt_buttons') = 'object' AND k.type = 'array';
--> statement-breakpoint
-- The stored expanded keys, with each durable expansion:<key> flag applied; only a seeded store is backfilled.
INSERT INTO expanded_nodes (short_key, system_from, system_to)
SELECT short_key, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59' FROM (
	SELECT e.value AS short_key
	FROM account_state a, json_each(a.json) e
	WHERE a.key = 'expanded_keys' AND json_type(a.json) = 'array' AND e.type = 'text'
		AND NOT EXISTS (SELECT 1 FROM local_settings l WHERE l.key = 'expansion:' || e.value AND l.json = 'false')
	UNION
	SELECT substr(l.key, 11)
	FROM local_settings l
	WHERE l.key LIKE 'expansion:%' AND l.json = 'true'
		AND EXISTS (SELECT 1 FROM account_state WHERE key = 'expanded_keys')
);
--> statement-breakpoint
INSERT INTO api_import_timestamp (name, timestamp, system_from, system_to)
SELECT 'expanded_nodes', fetched_at / 1000, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59' FROM account_state WHERE key = 'expanded_keys';
--> statement-breakpoint
INSERT INTO api_import_timestamp (name, timestamp, system_from, system_to)
SELECT 'account', fetched_at / 1000, (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59' FROM account_state WHERE key = 'account'
	AND EXISTS (SELECT 1 FROM account WHERE system_to = '9999-12-31 23:59:59');
--> statement-breakpoint
INSERT INTO tree_transactions (tree_id, transaction_id, system_from, system_to)
SELECT 'main', json_extract(json, '$'), (SELECT system_time FROM migration_0043_system_time), '9999-12-31 23:59:59' FROM account_state WHERE key = 'tree_tx_id' AND json_type(json) = 'text';
--> statement-breakpoint
DELETE FROM account_state WHERE key <> 'calendar_layout_undo';
--> statement-breakpoint
DROP TABLE local_settings;
--> statement-breakpoint
DROP TABLE migration_0043_state;
--> statement-breakpoint
DROP TABLE migration_0043_system_time;
