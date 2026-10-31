-- 📆 Undo a Calendar Layout from temporal history instead of stored JSON undo writes: record the system time
-- just before each root's last applied layout, and drop account_state with its calendar_layout_undo document.
-- A stored undo document carries no system time, so it is not carried over.
CREATE TABLE calendar_layout_applies (
	root_id TEXT NOT NULL,
	applied_at_system_time TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (root_id, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX calendar_layout_applies_system_to_idx ON calendar_layout_applies (root_id, system_to);
--> statement-breakpoint
CREATE INDEX calendar_layout_applies_closed_at_idx ON calendar_layout_applies (system_to) WHERE system_to < '9999-12-31 23:59:59';
--> statement-breakpoint
DROP TABLE account_state;
