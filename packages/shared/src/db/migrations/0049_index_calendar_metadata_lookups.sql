-- Index the live calendar_metadata lookups: the calendar root (root = 1) and a month's day nodes
-- (level = 'day' AND date_id BETWEEN ...), both filtered to system_to = the far-future sentinel.
CREATE INDEX calendar_metadata_root_idx ON calendar_metadata (root, system_to);
--> statement-breakpoint
CREATE INDEX calendar_metadata_level_idx ON calendar_metadata (level, system_to, date_id);
