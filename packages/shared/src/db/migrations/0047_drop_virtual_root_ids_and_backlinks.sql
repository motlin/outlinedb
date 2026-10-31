-- Drop virtual_root_ids (a flipped copy of mirrors) and backlinks (derived from mirrors + references_roots: a backlink
-- item is a live mirror whose parent is a references root, its source the mirror's original, its target that root's
-- parent). The rows that did not match mirrors were stale, so nothing is backfilled.
DROP TABLE virtual_root_ids;
--> statement-breakpoint
DROP TABLE backlinks;
