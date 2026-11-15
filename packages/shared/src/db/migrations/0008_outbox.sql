CREATE TABLE `outbox` (
	`node_id` text NOT NULL,
	`aspect` text NOT NULL,
	`enqueued_at` text NOT NULL,
	`last_error` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `aspect`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_system_to_idx` ON `outbox` (`node_id`,`aspect`,`system_to`);--> statement-breakpoint
CREATE INDEX `outbox_closed_at_idx` ON `outbox` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';
