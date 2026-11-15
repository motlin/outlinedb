-- LocalTreeWriter now writes order_key itself and leaves priority null, so the insert trigger derives order_key from
-- priority only for rows inserted without one. A new version that copies its row keeps the copied key.
DROP TRIGGER `node_metadata_order_key_insert`;--> statement-breakpoint
CREATE TRIGGER `node_metadata_order_key_insert` AFTER INSERT ON `node_metadata`
WHEN NEW.`order_key` IS NULL
BEGIN
	UPDATE `node_metadata` SET `order_key` = (
	SELECT char(CASE WHEN n >= 0 THEN 96 + len ELSE 91 - len END) || substr(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (v / 916132832) % 62 + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (v / 14776336) % 62 + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (v / 238328) % 62 + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (v / 3844) % 62 + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (v / 62) % 62 + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', v % 62 + 1, 1), 7 - len)
	FROM (
		SELECT n, len, CASE WHEN n >= 0 THEN n ELSE (CASE len WHEN 1 THEN 62 WHEN 2 THEN 3844 WHEN 3 THEN 238328 WHEN 4 THEN 14776336 WHEN 5 THEN 916132832 WHEN 6 THEN 56800235584 END) + n END AS v
		FROM (
			SELECT n, CASE WHEN n >= 0 THEN CASE WHEN n < 62 THEN 1 WHEN n < 3844 THEN 2 WHEN n < 238328 THEN 3 WHEN n < 14776336 THEN 4 WHEN n < 916132832 THEN 5 ELSE 6 END ELSE CASE WHEN -n <= 62 THEN 1 WHEN -n <= 3844 THEN 2 WHEN -n <= 238328 THEN 3 WHEN -n <= 14776336 THEN 4 WHEN -n <= 916132832 THEN 5 ELSE 6 END END AS len
			FROM (SELECT coalesce(NEW.priority, 0) AS n)
		)
	)
)
	WHERE `node_id` = NEW.`node_id` AND `system_from` = NEW.`system_from`;
END;
