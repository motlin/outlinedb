-- The nodes changes feed reads system times with a watermark trailing the clock by
-- the transaction timeout (Reladomo's change notification), so the commit-ordered
-- node_change_log and the triggers that filled it go.
DROP TRIGGER IF EXISTS node_change_log_prune;
--> statement-breakpoint
DROP TRIGGER IF EXISTS node_content_change_log_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS node_content_change_log_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS node_content_change_log_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS node_metadata_change_log_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS node_metadata_change_log_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS node_metadata_change_log_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mirrors_change_log_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mirrors_change_log_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mirrors_change_log_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS references_roots_change_log_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS references_roots_change_log_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS references_roots_change_log_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ai_metadata_change_log_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ai_metadata_change_log_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ai_metadata_change_log_delete;
--> statement-breakpoint
DROP TABLE IF EXISTS node_change_log;
