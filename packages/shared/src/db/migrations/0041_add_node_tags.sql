-- Each live item's distinct tags, derived from its live node_content text so tag
-- autocomplete counts with GROUP BY instead of parsing every item's HTML. Derived
-- and rebuildable, so not bitemporal. Every unit of work rewrites the rows of the
-- nodes it touched; ensureNodeTags backfills an empty table after migrating, since
-- the tag rules (findTags) live in TypeScript.
CREATE TABLE node_tags (
	node_id TEXT NOT NULL,
	tag_key TEXT NOT NULL,
	tag TEXT NOT NULL,
	PRIMARY KEY (node_id, tag_key)
);
--> statement-breakpoint
CREATE INDEX node_tags_tag_key_idx ON node_tags (tag_key);
