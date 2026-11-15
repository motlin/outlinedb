CREATE TABLE `account_outbox` (
	`subject` text NOT NULL,
	`key` text NOT NULL,
	`enqueued_at` text NOT NULL,
	`last_error` text,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`subject`, `key`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_outbox_system_to_idx` ON `account_outbox` (`subject`,`key`,`system_to`);--> statement-breakpoint
CREATE INDEX `account_outbox_closed_at_idx` ON `account_outbox` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';
