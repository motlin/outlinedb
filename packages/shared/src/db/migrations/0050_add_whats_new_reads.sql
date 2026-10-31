-- Our own What's New read state: one live row per entry of ours the user has seen. Upstream's changelog.read
-- (changelog_reads) stays upstream's key for upstream's entries, so ours never go there.
CREATE TABLE whats_new_reads (
	entry TEXT NOT NULL,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (entry, system_from)
);
--> statement-breakpoint
CREATE UNIQUE INDEX whats_new_reads_system_to_idx ON whats_new_reads (entry, system_to);
--> statement-breakpoint
CREATE INDEX whats_new_reads_closed_at_idx ON whats_new_reads (system_to) WHERE system_to < '9999-12-31 23:59:59';
