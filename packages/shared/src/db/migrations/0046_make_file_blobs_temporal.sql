-- Make file_blobs temporal: a retry phases out the error version and inserts the new one, so failure history is
-- kept. fetched_at (Unix ms) becomes each existing row's system_from.
CREATE TABLE file_blobs_temporal (
	node_id TEXT NOT NULL,
	status TEXT NOT NULL,
	sha256 TEXT,
	size INTEGER,
	content_type TEXT,
	local_path TEXT,
	error TEXT,
	system_from TEXT NOT NULL,
	system_to TEXT NOT NULL,
	PRIMARY KEY (node_id, system_from)
);
--> statement-breakpoint
INSERT INTO file_blobs_temporal (node_id, status, sha256, size, content_type, local_path, error, system_from, system_to)
SELECT node_id, status, sha256, size, content_type, local_path, error,
	strftime('%Y-%m-%d %H:%M:%f', fetched_at / 1000.0, 'unixepoch'), '9999-12-31 23:59:59'
FROM file_blobs;
--> statement-breakpoint
DROP TABLE file_blobs;
--> statement-breakpoint
ALTER TABLE file_blobs_temporal RENAME TO file_blobs;
--> statement-breakpoint
CREATE UNIQUE INDEX file_blobs_system_to_idx ON file_blobs (node_id, system_to);
--> statement-breakpoint
CREATE INDEX file_blobs_closed_at_idx ON file_blobs (system_to) WHERE system_to < '9999-12-31 23:59:59';
