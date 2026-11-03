-- `node list --parent-id inbox` cached Workflowy's empty child list for the "inbox" API alias,
-- and the cache gave that unknown parent a blank placeholder row, which showed as an extra blank node at Home.
-- "inbox" is never a node id, so close those rows as never valid (system_to = system_from).
UPDATE `node_content` SET `system_to` = `system_from` WHERE `id` = 'inbox' AND `system_to` = '9999-12-31 23:59:59';
--> statement-breakpoint
UPDATE `node_metadata` SET `system_to` = `system_from` WHERE `node_id` = 'inbox' AND `system_to` = '9999-12-31 23:59:59';
