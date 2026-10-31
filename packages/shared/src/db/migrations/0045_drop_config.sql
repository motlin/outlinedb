-- Drop config: its one key, workflowy_epoch, is the account's join date (account.date_joined_sec). Without a live
-- account row, carry the epoch over as a placeholder row (user_id 0) that the next account import replaces.
INSERT INTO account (user_id, date_joined_sec, system_from, system_to)
SELECT 0, CAST(value AS INTEGER), strftime('%Y-%m-%d %H:%M:%f', 'now'), '9999-12-31 23:59:59'
FROM config
WHERE key = 'workflowy_epoch'
	AND value GLOB '[0-9]*'
	AND NOT EXISTS (SELECT 1 FROM account WHERE system_to = '9999-12-31 23:59:59');
--> statement-breakpoint
DROP TABLE config;
