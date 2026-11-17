CREATE TABLE `pane_expanded_nodes` (
	`pane_id` text NOT NULL,
	`short_key` text NOT NULL,
	`system_from` integer NOT NULL,
	`system_to` integer NOT NULL,
	PRIMARY KEY(`pane_id`, `short_key`, `system_from`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pane_expanded_nodes_system_to_idx` ON `pane_expanded_nodes` (`pane_id`,`short_key`,`system_to`);--> statement-breakpoint
CREATE INDEX `pane_expanded_nodes_closed_at_idx` ON `pane_expanded_nodes` (`system_to`) WHERE system_to < 9007199254740991;
