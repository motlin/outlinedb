-- Databases migrated through the old 0000-0050 chain skip the collapsed 0000 baseline (same `when`),
-- so they never got its UNIQUE (key, system_to) indexes. For each table whose index was non-unique there:
-- close every version that shares (key, system_to) with a later one at that later version's system_from,
-- so the history becomes contiguous instead of overlapping, then rebuild the index as UNIQUE.
-- On a fresh database there is nothing to repair and the index is recreated unchanged.
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `ai_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `ai_metadata` o WHERE EXISTS (SELECT 1 FROM `ai_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `ai_metadata` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `ai_metadata`.`node_id` AND r.`system_from` = `ai_metadata`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `ai_metadata`.`node_id` AND r.`system_from` = `ai_metadata`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `ai_metadata_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_metadata_system_to_idx` ON `ai_metadata` (`node_id`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`filename`, o.`system_from`, (SELECT min(n.`system_from`) FROM `backup_imports` n WHERE n.`filename` = o.`filename` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `backup_imports` o WHERE EXISTS (SELECT 1 FROM `backup_imports` n WHERE n.`filename` = o.`filename` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `backup_imports` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`filename` = `backup_imports`.`filename` AND r.`system_from` = `backup_imports`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`filename` = `backup_imports`.`filename` AND r.`system_from` = `backup_imports`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `backup_imports_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_imports_system_to_idx` ON `backup_imports` (`filename`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `calendar_levels` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `calendar_levels` o WHERE EXISTS (SELECT 1 FROM `calendar_levels` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `calendar_levels` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `calendar_levels`.`node_id` AND r.`system_from` = `calendar_levels`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `calendar_levels`.`node_id` AND r.`system_from` = `calendar_levels`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `calendar_levels_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_levels_system_to_idx` ON `calendar_levels` (`node_id`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `calendar_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `calendar_metadata` o WHERE EXISTS (SELECT 1 FROM `calendar_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `calendar_metadata` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `calendar_metadata`.`node_id` AND r.`system_from` = `calendar_metadata`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `calendar_metadata`.`node_id` AND r.`system_from` = `calendar_metadata`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `calendar_metadata_new_system_to_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `calendar_metadata_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_metadata_system_to_idx` ON `calendar_metadata` (`node_id`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `changes_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `changes_metadata` o WHERE EXISTS (SELECT 1 FROM `changes_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `changes_metadata` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `changes_metadata`.`node_id` AND r.`system_from` = `changes_metadata`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `changes_metadata`.`node_id` AND r.`system_from` = `changes_metadata`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `changes_metadata_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `changes_metadata_system_to_idx` ON `changes_metadata` (`node_id`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`mirror_id`, o.`original_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `mirrors` n WHERE n.`mirror_id` = o.`mirror_id` AND n.`original_id` = o.`original_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `mirrors` o WHERE EXISTS (SELECT 1 FROM `mirrors` n WHERE n.`mirror_id` = o.`mirror_id` AND n.`original_id` = o.`original_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `mirrors` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`mirror_id` = `mirrors`.`mirror_id` AND r.`original_id` = `mirrors`.`original_id` AND r.`system_from` = `mirrors`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`mirror_id` = `mirrors`.`mirror_id` AND r.`original_id` = `mirrors`.`original_id` AND r.`system_from` = `mirrors`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `mirrors_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `mirrors_system_to_idx` ON `mirrors` (`mirror_id`,`original_id`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`model`, o.`system_from`, (SELECT min(n.`system_from`) FROM `node_embeddings` n WHERE n.`node_id` = o.`node_id` AND n.`model` = o.`model` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `node_embeddings` o WHERE EXISTS (SELECT 1 FROM `node_embeddings` n WHERE n.`node_id` = o.`node_id` AND n.`model` = o.`model` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `node_embeddings` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `node_embeddings`.`node_id` AND r.`model` = `node_embeddings`.`model` AND r.`system_from` = `node_embeddings`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `node_embeddings`.`node_id` AND r.`model` = `node_embeddings`.`model` AND r.`system_from` = `node_embeddings`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `node_embeddings_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `node_embeddings_system_to_idx` ON `node_embeddings` (`node_id`,`model`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `node_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `node_metadata` o WHERE EXISTS (SELECT 1 FROM `node_metadata` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `node_metadata` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `node_metadata`.`node_id` AND r.`system_from` = `node_metadata`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `node_metadata`.`node_id` AND r.`system_from` = `node_metadata`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `node_metadata_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `node_metadata_system_to_idx` ON `node_metadata` (`node_id`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `references_roots` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `references_roots` o WHERE EXISTS (SELECT 1 FROM `references_roots` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `references_roots` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `references_roots`.`node_id` AND r.`system_from` = `references_roots`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `references_roots`.`node_id` AND r.`system_from` = `references_roots`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `references_roots_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `references_roots_system_to_idx` ON `references_roots` (`node_id`,`system_to`);
--> statement-breakpoint
CREATE TABLE `__system_to_repair` AS SELECT o.`node_id`, o.`system_from`, (SELECT min(n.`system_from`) FROM `s3_files` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`) AS `next_from` FROM `s3_files` o WHERE EXISTS (SELECT 1 FROM `s3_files` n WHERE n.`node_id` = o.`node_id` AND n.`system_to` = o.`system_to` AND n.`system_from` > o.`system_from`);
--> statement-breakpoint
UPDATE `s3_files` SET `system_to` = (SELECT r.`next_from` FROM `__system_to_repair` r WHERE r.`node_id` = `s3_files`.`node_id` AND r.`system_from` = `s3_files`.`system_from`) WHERE EXISTS (SELECT 1 FROM `__system_to_repair` r WHERE r.`node_id` = `s3_files`.`node_id` AND r.`system_from` = `s3_files`.`system_from`);
--> statement-breakpoint
DROP TABLE `__system_to_repair`;
--> statement-breakpoint
DROP INDEX IF EXISTS `s3_files_system_to_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `s3_files_system_to_idx` ON `s3_files` (`node_id`,`system_to`);
