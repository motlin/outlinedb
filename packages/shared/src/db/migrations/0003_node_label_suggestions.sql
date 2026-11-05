CREATE TABLE `node_label_suggestions` (
	`node_id` text NOT NULL,
	`label` text NOT NULL,
	`label_kind` text NOT NULL,
	`source` text NOT NULL,
	`score` real NOT NULL,
	`content_from` text NOT NULL,
	`system_from` text NOT NULL,
	`system_to` text NOT NULL,
	PRIMARY KEY(`node_id`, `label`, `source`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_label_suggestions_system_to_idx` ON `node_label_suggestions` (`node_id`,`label`,`source`,`system_to`);--> statement-breakpoint
CREATE INDEX `node_label_suggestions_closed_at_idx` ON `node_label_suggestions` (`system_to`) WHERE system_to < '9999-12-31 23:59:59';
