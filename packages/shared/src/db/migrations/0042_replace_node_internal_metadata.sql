-- 🏷️ Replace the JSON node_internal_metadata cache with typed temporal tables.
-- calendar goes to calendar_metadata/calendar_levels, layoutMode stays on
-- node_metadata, and the rest to node_display_metadata and node_table_cell_sizes.
-- Every backfilled row takes one system time, staged in a scratch table
-- (Durable Object SQLite has no temp tables).
CREATE TABLE node_display_metadata (
	node_id TEXT NOT NULL,
	numbered_start INTEGER,
	restorable_unique_node INTEGER,
	table_headers INTEGER,
	table_skip_headers INTEGER,
	table_bg TEXT,
	priority_default_to_bottom INTEGER,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (node_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX node_display_metadata_system_to_idx ON node_display_metadata (node_id, system_to);
--> statement-breakpoint
CREATE INDEX node_display_metadata_closed_at_idx ON node_display_metadata (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE node_table_cell_sizes (
	node_id TEXT NOT NULL,
	cell_id TEXT NOT NULL,
	size REAL NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (node_id, cell_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX node_table_cell_sizes_system_to_idx ON node_table_cell_sizes (node_id, cell_id, system_to);
--> statement-breakpoint
CREATE INDEX node_table_cell_sizes_closed_at_idx ON node_table_cell_sizes (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
CREATE TABLE migration_0042_system_time AS SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS system_time;
--> statement-breakpoint
INSERT INTO node_display_metadata (node_id, numbered_start, restorable_unique_node, table_headers, table_skip_headers, table_bg, priority_default_to_bottom, system_from, system_to)
SELECT node_id, numbered_start, restorable_unique_node, table_headers, table_skip_headers, table_bg, priority_default_to_bottom,
	(SELECT system_time FROM migration_0042_system_time), '9999-12-31 23:59:59'
FROM (
	SELECT
		node_id,
		CASE WHEN json_type(metadata_json, '$.numbered_start') = 'integer' THEN json_extract(metadata_json, '$.numbered_start') END AS numbered_start,
		CASE json_type(metadata_json, '$.restorableUniqueNode') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS restorable_unique_node,
		CASE json_type(metadata_json, '$.table.headers') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS table_headers,
		CASE json_type(metadata_json, '$.table.skipHeaders') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS table_skip_headers,
		CASE WHEN json_type(metadata_json, '$.table.bg') = 'text' THEN json_extract(metadata_json, '$.table.bg') END AS table_bg,
		CASE json_type(metadata_json, '$.priority.defaultToBottom') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS priority_default_to_bottom
	FROM node_internal_metadata
)
WHERE numbered_start IS NOT NULL OR restorable_unique_node IS NOT NULL OR table_headers IS NOT NULL
	OR table_skip_headers IS NOT NULL OR table_bg IS NOT NULL OR priority_default_to_bottom IS NOT NULL;
--> statement-breakpoint
INSERT INTO node_table_cell_sizes (node_id, cell_id, size, system_from, system_to)
SELECT m.node_id, s.key, s.value, (SELECT system_time FROM migration_0042_system_time), '9999-12-31 23:59:59'
FROM node_internal_metadata m, json_each(m.metadata_json, '$.table.sizes') s
WHERE json_type(m.metadata_json, '$.table.sizes') = 'object' AND s.type IN ('integer', 'real');
--> statement-breakpoint
-- The calendar each node_internal_metadata row reports (refreshed by every /get_tree_data/ import, so fresher than
-- the backup-imported rows), as calendar_metadata columns.
CREATE TABLE migration_0042_calendar AS
SELECT
	node_id,
	CASE json_type(metadata_json, '$.calendar.root') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS root,
	CASE WHEN json_type(metadata_json, '$.calendar.level') = 'text' THEN json_extract(metadata_json, '$.calendar.level') END AS level,
	CASE WHEN json_type(metadata_json, '$.calendar.value') IS NOT NULL THEN CAST(json_extract(metadata_json, '$.calendar.value') AS TEXT) END AS value,
	CASE WHEN json_type(metadata_json, '$.calendar.dateId') = 'integer' THEN json_extract(metadata_json, '$.calendar.dateId') END AS date_id,
	CASE WHEN json_type(metadata_json, '$.calendar.timestamp') = 'integer' THEN json_extract(metadata_json, '$.calendar.timestamp') END AS timestamp,
	CASE json_type(metadata_json, '$.calendar.found_dates') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS found_dates,
	CASE json_type(metadata_json, '$.calendar.day_prefix') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS day_prefix,
	json_type(metadata_json, '$.calendar.levels') = 'object' AS has_levels,
	CASE json_type(metadata_json, '$.calendar.levels.day') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS level_day,
	CASE json_type(metadata_json, '$.calendar.levels.week') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS level_week,
	CASE json_type(metadata_json, '$.calendar.levels.month') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS level_month,
	CASE json_type(metadata_json, '$.calendar.levels.year') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS level_year
FROM node_internal_metadata
WHERE json_type(metadata_json, '$.calendar') = 'object';
--> statement-breakpoint
UPDATE calendar_metadata SET system_to = (SELECT system_time FROM migration_0042_system_time)
WHERE system_to = '9999-12-31 23:59:59'
	AND node_id IN (
		SELECT c.node_id FROM migration_0042_calendar c
		WHERE NOT EXISTS (
			SELECT 1 FROM calendar_metadata m
			WHERE m.node_id = c.node_id AND m.system_to = '9999-12-31 23:59:59'
				AND m.root IS c.root AND m.level IS c.level AND m.value IS c.value AND m.date_id IS c.date_id
				AND m.timestamp IS c.timestamp AND m.found_dates IS c.found_dates AND m.day_prefix IS c.day_prefix
		)
	);
--> statement-breakpoint
INSERT INTO calendar_metadata (node_id, root, level, value, date_id, timestamp, found_dates, day_prefix, system_from, system_to)
SELECT c.node_id, c.root, c.level, c.value, c.date_id, c.timestamp, c.found_dates, c.day_prefix,
	(SELECT system_time FROM migration_0042_system_time), '9999-12-31 23:59:59'
FROM migration_0042_calendar c
WHERE NOT EXISTS (SELECT 1 FROM calendar_metadata m WHERE m.node_id = c.node_id AND m.system_to = '9999-12-31 23:59:59');
--> statement-breakpoint
UPDATE calendar_levels SET system_to = (SELECT system_time FROM migration_0042_system_time)
WHERE system_to = '9999-12-31 23:59:59'
	AND node_id IN (
		SELECT c.node_id FROM migration_0042_calendar c
		WHERE NOT c.has_levels OR NOT EXISTS (
			SELECT 1 FROM calendar_levels l
			WHERE l.node_id = c.node_id AND l.system_to = '9999-12-31 23:59:59'
				AND l.day IS c.level_day AND l.week IS c.level_week AND l.month IS c.level_month AND l.year IS c.level_year
		)
	);
--> statement-breakpoint
INSERT INTO calendar_levels (node_id, day, week, month, year, system_from, system_to)
SELECT c.node_id, c.level_day, c.level_week, c.level_month, c.level_year,
	(SELECT system_time FROM migration_0042_system_time), '9999-12-31 23:59:59'
FROM migration_0042_calendar c
WHERE c.has_levels
	AND NOT EXISTS (SELECT 1 FROM calendar_levels l WHERE l.node_id = c.node_id AND l.system_to = '9999-12-31 23:59:59');
--> statement-breakpoint
DROP TABLE migration_0042_calendar;
--> statement-breakpoint
DROP TABLE migration_0042_system_time;
--> statement-breakpoint
DROP TABLE node_internal_metadata;
