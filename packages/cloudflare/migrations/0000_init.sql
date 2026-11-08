-- Auth database (AUTH_DB) bootstrap: records which schema this D1 holds. Better Auth tables arrive in later migrations.
CREATE TABLE schema_meta (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('schema', 'outlinedb-auth');
