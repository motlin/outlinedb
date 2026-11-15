-- Every writer sets order_key itself now, and imports map upstream positions onto it, so priority and the triggers
-- that derived order_key from it go.
DROP TRIGGER `node_metadata_order_key_insert`;--> statement-breakpoint
DROP TRIGGER `node_metadata_order_key_update`;--> statement-breakpoint
ALTER TABLE `node_metadata` DROP COLUMN `priority`;
