CREATE INDEX `account_outbox_pending_idx` ON `account_outbox` (`enqueued_at`,`subject`,`key`) WHERE system_to = 9007199254740991;--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`enqueued_at`,`node_id`,`aspect`) WHERE system_to = 9007199254740991;
