/**
 * Normalized in-DB row shapes — the contract between import adapters and the
 * shared merge engine.
 *
 * The canonical representation begins *after* JSON parsing. Each import adapter
 * has its own input type (the bulk-export `BackupNode` tree vs. the per-node
 * `RestApiNodeResponse` object) and its own validation schema, but both
 * terminate in the same `Normalized*Row` shapes per destination table. Once an
 * adapter has produced these rows, its job is done: the rows are fed to
 * `temporalMerge` (see {@link ./temporal-merge.ts}), which is the only thing
 * that knows how to write them.
 *
 * There is deliberately NO `ImportPayload` super-shape pretending the two
 * sources are interchangeable — they are not. What IS shared is everything
 * downstream of normalization: these row shapes and the merge engine.
 *
 * Each row type is derived from the corresponding Drizzle insert type with the
 * temporal columns (`systemFrom` / `systemTo`) stripped. That stripping is
 * intentional and load-bearing: `temporalMerge`'s `buildInsertRow` callback
 * MUST return a row WITHOUT `systemFrom` / `systemTo`, because the merge engine
 * appends those itself. A `Normalized*Row` is exactly "the desired current
 * state of one row, minus its temporal envelope."
 */

import type {
	NewAiMetadata,
	NewCalendarLevels,
	NewCalendarMetadata,
	NewChangesMetadata,
	NewMirror,
	NewNodeContent,
	NewNodeMetadata,
	NewReferencesRoot,
	NewS3File,
} from "../db/schema.js";

/**
 * Strips the temporal envelope columns (`systemFrom` / `systemTo`) from a
 * Drizzle insert type. The merge engine appends those columns itself, so an
 * adapter's `buildInsertRow` output must not include them.
 */
export type WithoutTemporal<T> = Omit<T, "systemFrom" | "systemTo">;

/**
 * One `node_content` row as produced by an import adapter: id, name, note,
 * parentId. Affects embeddings.
 */
export type NormalizedNodeContentRow = WithoutTemporal<NewNodeContent>;

/**
 * One `node_metadata` row as produced by an import adapter: shortId, priority,
 * timestamps, layoutMode. Does NOT affect embeddings.
 */
export type NormalizedNodeMetadataRow = WithoutTemporal<NewNodeMetadata>;

/**
 * One `calendar_metadata` row: per-date-node calendar fields (`level`, `value`,
 * `dateId`, `timestamp`, ...) or the calendar root marker.
 */
export type NormalizedCalendarMetadataRow = WithoutTemporal<NewCalendarMetadata>;

/**
 * One `calendar_levels` row: the per-granularity boolean flags carried by the
 * calendar root node.
 */
export type NormalizedCalendarLevelsRow = WithoutTemporal<NewCalendarLevels>;

/**
 * One `mirrors` row: an `originalId` → `mirrorId` relationship.
 */
export type NormalizedMirrorRow = WithoutTemporal<NewMirror>;

/**
 * One `s3_files` row.
 */
export type NormalizedS3FileRow = WithoutTemporal<NewS3File>;

/**
 * One `changes_metadata` row.
 */
export type NormalizedChangesMetadataRow = WithoutTemporal<NewChangesMetadata>;

/**
 * One `ai_metadata` row: the `inChat` flag for a node.
 */
export type NormalizedAiMetadataRow = WithoutTemporal<NewAiMetadata>;

/**
 * One `references_roots` row: marks a node as a references root.
 */
export type NormalizedReferencesRootsRow = WithoutTemporal<NewReferencesRoot>;
