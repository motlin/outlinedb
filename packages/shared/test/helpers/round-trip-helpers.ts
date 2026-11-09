import DatabaseConstructor from "better-sqlite3";
import type {Database} from "better-sqlite3";
import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import {mirrors, nodeContent} from "@outlinedb/shared/db";
import {applyRows, normalizeLayoutMode, runUnitOfWork, startUnitOfWork} from "@outlinedb/shared/cache";
import type {ApplyRowsResult, NormalizedRowsByTable} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {Node, WorkflowyNode} from "@outlinedb/shared/types";
import {ApiResponseSchema} from "@outlinedb/shared/types";
import {uuidToShortId} from "@outlinedb/shared/workflowy";
import {BackupFileSchema} from "@outlinedb/shared/schemas";
import type {BackupNode} from "@outlinedb/shared/schemas";

const currentDirectory = import.meta.dirname;
const migrationsFolder = join(currentDirectory, "../../src/db/migrations");
const fixturesFolder = join(currentDirectory, "../fixtures");

export interface TestDatabase {
	database: BetterSQLite3Database<typeof schema>;
	sqlite: Database;
}

/**
 * Build an in-memory SQLite database with every migration applied.
 *
 * Uses `better-sqlite3` with a `:memory:` database and runs the Drizzle
 * migrations directly from `packages/shared/src/db/migrations/`, so no build
 * step is required. All Phase 4 round-trip tests build on this.
 */
export function buildTestDb(): TestDatabase {
	const sqlite = new DatabaseConstructor(":memory:");
	const database = drizzle(sqlite, {schema});
	migrate(database, {migrationsFolder});
	sqlite.pragma("foreign_keys = ON");
	return {database, sqlite};
}

/**
 * Load a backup-export fixture by name (without the `.json` extension) from
 * `packages/shared/test/fixtures/` and validate it against `BackupFileSchema`.
 */
export function loadFixtureBackup(name: string): BackupNode[] {
	const filePath = join(fixturesFolder, `${name}.json`);
	const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
	return BackupFileSchema.parse(raw);
}

/**
 * Load a per-node REST API response fixture by name (without the `.json`
 * extension) from `packages/shared/test/fixtures/` and validate it against
 * `ApiResponseSchema`. Returns the contained nodes.
 */
export function loadFixtureRestApiResponse(name: string): WorkflowyNode[] {
	const filePath = join(fixturesFolder, `${name}.json`);
	const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
	const response = ApiResponseSchema.parse(raw);
	if (response.nodes === undefined) {
		throw new Error(`REST API fixture '${name}' has no 'nodes' array`);
	}
	return response.nodes;
}

/**
 * Convert a Unix-seconds timestamp (as carried by both the backup and REST
 * JSON shapes) to a `Date`, or null when the timestamp is absent.
 */
function unixSecondsToDate(seconds: number | null | undefined): Date | null {
	return seconds === null || seconds === undefined ? null : new Date(seconds * 1000);
}

/**
 * Bulk-export adapter (test-local).
 *
 * Mirrors the JSON-shape normalization that `packages/cli/.../cache-import.ts`
 * performs on a Workflowy backup/bulk-export tree: walk the nested `ch` tree,
 * carry the parent id down, map `nm`/`no`/`ct`/`lm`/`cp` to the canonical
 * column names, and turn `metadata.layoutMode` into its normalized form. The
 * production adapter lives in `packages/cli`, which `packages/shared` cannot
 * import, so this is the deliberate handcrafted twin from the Phase 4 plan.
 *
 * The bulk-export tree uses sibling order for priority: each node's priority is
 * its zero-based index among its siblings.
 */
export function normalizeBackupNodes(nodes: BackupNode[]): NormalizedRowsByTable {
	const contentRows: NonNullable<NormalizedRowsByTable["nodeContent"]> = [];
	const metadataRows: NonNullable<NormalizedRowsByTable["nodeMetadata"]> = [];

	const walk = (siblings: BackupNode[], parentId: string | null): void => {
		siblings.forEach((node, index) => {
			contentRows.push({
				id: node.id,
				name: node.nm ?? null,
				note: node.no ?? null,
				parentId,
			});
			metadataRows.push({
				nodeId: node.id,
				shortId: uuidToShortId(node.id),
				priority: index,
				createdAt: unixSecondsToDate(node.ct),
				modifiedAt: unixSecondsToDate(node.lm),
				completedAt: unixSecondsToDate(node.cp),
				layoutMode: normalizeLayoutMode(node.metadata.layoutMode),
			});
			if (node.ch !== undefined) {
				walk(node.ch, node.id);
			}
		});
	};

	walk(nodes, null);
	return {nodeContent: contentRows, nodeMetadata: metadataRows};
}

/**
 * Collect the `originalId` → `mirrorId` relationships carried by a backup
 * tree's `metadata.mirror` entries. `applyRows` does not manage the composite-
 * key `mirrors` table, so callers insert these rows directly.
 */
export function collectBackupMirrorRows(nodes: BackupNode[]): {originalId: string; mirrorId: string}[] {
	const rows: {originalId: string; mirrorId: string}[] = [];

	const walk = (siblings: BackupNode[]): void => {
		for (const node of siblings) {
			const mirror = node.metadata.mirror;
			if (mirror !== undefined && "originalId" in mirror) {
				rows.push({originalId: mirror.originalId, mirrorId: node.id});
			}
			if (node.ch !== undefined) {
				walk(node.ch);
			}
		}
	};

	walk(nodes);
	return rows;
}

/**
 * Per-node REST adapter (test-local).
 *
 * Mirrors the JSON-shape normalization that `packages/cli/.../cache-import-api.ts`
 * performs on a per-node REST API response: the response is already a flat list
 * carrying `parent_id`, `priority`, `createdAt`, etc., so there is no tree walk.
 * The field names differ from the bulk-export shape (`name` vs `nm`,
 * `parent_id` vs nesting, `completedAt` vs `cp`); this adapter remaps them onto
 * the same `Normalized*Row` shapes the bulk-export adapter produces. The two
 * adapters terminating in byte-identical rows is exactly the Phase 4b
 * regression net.
 */
export function normalizeRestNodes(nodes: WorkflowyNode[]): NormalizedRowsByTable {
	const contentRows: NonNullable<NormalizedRowsByTable["nodeContent"]> = [];
	const metadataRows: NonNullable<NormalizedRowsByTable["nodeMetadata"]> = [];

	for (const node of nodes) {
		contentRows.push({
			id: node.id,
			name: node.name,
			note: node.note ?? null,
			parentId: node.parent_id ?? null,
		});
		metadataRows.push({
			nodeId: node.id,
			shortId: uuidToShortId(node.id),
			priority: node.priority,
			createdAt: unixSecondsToDate(node.createdAt),
			modifiedAt: unixSecondsToDate(node.modifiedAt),
			completedAt: unixSecondsToDate(node.completedAt),
			layoutMode: normalizeLayoutMode(node.data?.layoutMode),
		});
	}

	return {nodeContent: contentRows, nodeMetadata: metadataRows};
}

/**
 * Serialize a canonical `Node` into the snake_case Workflowy-compatible REST
 * DTO. Twin of the private `nodeToRestDto` in `packages/web/.../routes/nodes.ts`;
 * `packages/shared` cannot import the web package, so the round-trip test
 * carries its own copy. The mirror name/note fallback and `hasChildren` flag
 * are REST-handler concerns and are intentionally omitted here.
 */
export interface RestDto {
	id: string;
	parent_id: string | null;
	name: string | null;
	note: string | null;
	priority: number;
	data: {layoutMode: string | null};
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
}

function dateToUnixSeconds(date: Date | null): number | null {
	return date === null ? null : Math.floor(date.getTime() / 1000);
}

export function nodeToRestDto(node: Node): RestDto {
	return {
		id: node.id,
		parent_id: node.parentId,
		name: node.name,
		note: node.note,
		priority: node.priority,
		data: {layoutMode: node.layoutMode},
		createdAt: dateToUnixSeconds(node.createdAt),
		modifiedAt: dateToUnixSeconds(node.modifiedAt),
		completedAt: dateToUnixSeconds(node.completedAt),
	};
}

/**
 * Parse a REST DTO back into the `Normalized*Row` shapes, closing the
 * `Node → DTO → DB` round-trip. A second `applyRows` of these rows must produce
 * zero temporal-row changes.
 */
export function restDtoToNormalizedRows(dtos: RestDto[]): NormalizedRowsByTable {
	const contentRows: NonNullable<NormalizedRowsByTable["nodeContent"]> = [];
	const metadataRows: NonNullable<NormalizedRowsByTable["nodeMetadata"]> = [];

	for (const dto of dtos) {
		contentRows.push({
			id: dto.id,
			name: dto.name,
			note: dto.note,
			parentId: dto.parent_id,
		});
		metadataRows.push({
			nodeId: dto.id,
			shortId: uuidToShortId(dto.id),
			priority: dto.priority,
			createdAt: unixSecondsToDate(dto.createdAt),
			modifiedAt: unixSecondsToDate(dto.modifiedAt),
			completedAt: unixSecondsToDate(dto.completedAt),
			layoutMode: normalizeLayoutMode(dto.data.layoutMode),
		});
	}

	return {nodeContent: contentRows, nodeMetadata: metadataRows};
}

/**
 * Insert mirror relationships directly into the temporal `mirrors` table.
 * `applyRows` only manages node-keyed tables, so the round-trip tests wire
 * mirrors in themselves.
 */
export function insertMirrorRows(
	database: BetterSQLite3Database<typeof schema>,
	rows: {originalId: string; mirrorId: string}[],
	importedAt: string,
): void {
	for (const row of rows) {
		database
			.insert(mirrors)
			.values({
				originalId: row.originalId,
				mirrorId: row.mirrorId,
				systemFrom: importedAt,
				systemTo: FAR_FUTURE_DATE,
			})
			.run();
	}
}

/**
 * Result of a watermark-guarded bulk import. `skipped` is true when the
 * stale-snapshot guard rejected the import.
 */
export interface GuardedBulkImportResult {
	skipped: boolean;
	mergeResult?: ApplyRowsResult;
}

/**
 * Bulk-export import with the stale-snapshot watermark guard.
 *
 * Twin of the pre-flight guard in `packages/cli/.../cache-import.ts`: the
 * bulk-export API can return stale snapshots, so an import whose newest node
 * timestamp predates the local cache's high watermark is rejected. Timestamps
 * are compared numerically (Unix ms), never lexicographically.
 *
 * The local watermark is the newest `system_from` among current `node_content`
 * rows; the incoming watermark is `importedAt`.
 */
export function bulkImportWithWatermarkGuard(
	database: BetterSQLite3Database<typeof schema>,
	nodes: BackupNode[],
	importedAt: Date,
): GuardedBulkImportResult {
	const localRow = database
		.select({systemFrom: nodeContent.systemFrom})
		.from(nodeContent)
		.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
		.all();
	const localWatermarkMs = localRow.reduce<number | null>((newest, row) => {
		const ms = Date.parse(`${row.systemFrom.replace(" ", "T")}Z`);
		return newest === null || ms > newest ? ms : newest;
	}, null);

	if (localWatermarkMs !== null && importedAt.getTime() <= localWatermarkMs) {
		return {skipped: true};
	}

	const rowsByTable = normalizeBackupNodes(nodes);
	const mergeResult = runUnitOfWork(
		database,
		(unitOfWork) => applyRows(unitOfWork, rowsByTable),
		startUnitOfWork(importedAt),
	);
	return {skipped: false, mergeResult};
}

/**
 * Per-node REST import — writes unconditionally, with no watermark guard.
 *
 * The per-node REST API is always fresh: a single-node response is
 * authoritative by definition, so this adapter never rejects an import,
 * regardless of how its timestamp compares to the local cache.
 */
export function restImport(
	database: BetterSQLite3Database<typeof schema>,
	nodes: WorkflowyNode[],
	importedAt: Date,
): ApplyRowsResult {
	const rowsByTable = normalizeRestNodes(nodes);
	return runUnitOfWork(database, (unitOfWork) => applyRows(unitOfWork, rowsByTable), startUnitOfWork(importedAt));
}
