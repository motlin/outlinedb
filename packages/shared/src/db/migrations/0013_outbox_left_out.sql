ALTER TABLE `outbox` ADD `left_out_op` text;--> statement-breakpoint
CREATE INDEX `outbox_left_out_idx` ON `outbox` (`node_id`,`aspect`) WHERE system_to = 9007199254740991 AND left_out_op IS NOT NULL;
