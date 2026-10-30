import {applyRows, NodeReader, runUnitOfWork} from "@workflowy/shared/cache";
import {eq, sql} from "drizzle-orm";
import {nodeContent, nodeMetadata} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {describe, expect, it} from "vite-plus/test";
import {
	buildTestDb,
	bulkImportWithWatermarkGuard,
	collectBackupMirrorRows,
	insertMirrorRows,
	loadFixtureBackup,
	loadFixtureRestApiResponse,
	nodeToRestDto,
	normalizeBackupNodes,
	normalizeRestNodes,
	restDtoToNormalizedRows,
	restImport,
} from "./helpers/round-trip-helpers.js";

/**
 * Phase 4a: in-process round-trip test infrastructure.
 *
 * These tests verify the shared infra (`buildTestDb`, `loadFixtureBackup`,
 * `loadFixtureRestApiResponse`) that all subsequent Phase 4 round-trip tests
 * build on. Everything runs in a single Vitest process: an in-memory SQLite
 * database with migrations applied, no filesystem state, no subprocess.
 */
describe("round-trip test infrastructure", () => {
	describe("buildTestDb", () => {
		it("creates an in-memory database with every migration applied", () => {
			const {sqlite} = buildTestDb();

			const tableRows = sqlite
				.prepare<[], {name: string}>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all();
			const tableNames = tableRows.map((row) => row.name);

			expect(tableNames).toStrictEqual([
				"__drizzle_migrations",
				"account_state",
				"ai_metadata",
				"backlinks",
				"backup_imports",
				"calendar_levels",
				"calendar_metadata",
				"changes_metadata",
				"config",
				"file_blobs",
				"local_settings",
				"mirrors",
				"node_content",
				"node_embeddings",
				"node_fts",
				"node_fts_config",
				"node_fts_content",
				"node_fts_data",
				"node_fts_docsize",
				"node_fts_idx",
				"node_internal_metadata",
				"node_metadata",
				"references_roots",
				"s3_files",
				"sqlite_sequence",
				"virtual_root_ids",
			]);

			sqlite.close();
		});

		it("records the full migration journal in __drizzle_migrations", () => {
			const {database, sqlite} = buildTestDb();

			const result = database.get<{count: number}>(sql`SELECT COUNT(*) AS count FROM __drizzle_migrations`);

			expect(result.count).toBe(40);

			sqlite.close();
		});

		it("returns an empty node_content table", () => {
			const {database, sqlite} = buildTestDb();

			const result = database.get<{count: number}>(sql`SELECT COUNT(*) AS count FROM node_content`);

			expect(result.count).toBe(0);

			sqlite.close();
		});
	});

	describe("loadFixtureBackup", () => {
		it("loads and validates the small backup fixture", () => {
			const nodes = loadFixtureBackup("small-backup");

			expect(
				nodes.map(({id, nm, ch, metadata}) => ({
					id,
					name: nm,
					childIds: ch?.map((child) => child.id) ?? [],
					mirror: metadata.mirror,
				})),
			).toStrictEqual([
				{
					id: "11111111-1111-1111-1111-111111111111",
					name: "Projects",
					childIds: ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"],
					mirror: undefined,
				},
				{
					id: "44444444-4444-4444-4444-444444444444",
					name: "Mirror of Ship Phase 4",
					childIds: [],
					mirror: {
						originalId: "33333333-3333-3333-3333-333333333333",
						isMirrorRoot: true,
					},
				},
			]);
		});
	});

	describe("loadFixtureRestApiResponse", () => {
		it("loads and validates the small REST API fixture", () => {
			const nodes = loadFixtureRestApiResponse("small-rest-api-response");

			expect(nodes.map(({id, completed, completedAt}) => ({id, completed, completedAt}))).toStrictEqual([
				{id: "11111111-1111-1111-1111-111111111111", completed: false, completedAt: null},
				{id: "22222222-2222-2222-2222-222222222222", completed: false, completedAt: null},
				{id: "33333333-3333-3333-3333-333333333333", completed: true, completedAt: 1_700_000_600},
			]);
		});
	});
});

/** Sort temporal rows by their `id` column for order-independent comparison. */
function sortById<T extends {id: string}>(rows: T[]): T[] {
	return [...rows].toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Sort temporal rows by their `nodeId` column for order-independent comparison. */
function sortByNodeId<T extends {nodeId: string}>(rows: T[]): T[] {
	return [...rows].toSorted((a, b) => a.nodeId.localeCompare(b.nodeId));
}

/**
 * Phase 4b: round-trip and adapter-equivalence tests.
 *
 * These exercise the kinds of bugs that motivated the IO rework: column drift
 * between the two import paths, dead-column accumulation, and re-import churn.
 * Everything runs in a single Vitest process against an in-memory SQLite
 * database.
 */
describe("round-trip equivalence", () => {
	describe("backup -> DB -> DTO -> DB equivalence", () => {
		it("produces zero new temporal rows on re-import of the round-tripped DTO", () => {
			const {database, sqlite} = buildTestDb();
			const importedAt = new Date("2026-05-22T10:00:00Z");

			const firstImport = bulkImportWithWatermarkGuard(database, loadFixtureBackup("small-backup"), importedAt);
			expect(firstImport.skipped).toBe(false);
			expect(firstImport.mergeResult?.nodeContent?.inserted).toBe(4);
			expect(firstImport.mergeResult?.nodeMetadata?.inserted).toBe(4);

			const reader = new NodeReader(database);
			const ids = database
				.select({id: nodeContent.id})
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((row) => row.id);
			expect(ids.toSorted()).toStrictEqual([
				"11111111-1111-1111-1111-111111111111",
				"22222222-2222-2222-2222-222222222222",
				"33333333-3333-3333-3333-333333333333",
				"44444444-4444-4444-4444-444444444444",
			]);

			const dtos = ids.map((id) => {
				const node = reader.getById(id);
				if (node === null) {
					throw new Error(`NodeReader returned null for ${id}`);
				}
				return nodeToRestDto(node);
			});

			// Re-import the round-tripped DTO rows through the same applyRows sink.
			// Because every node's content is byte-identical to what is already
			// current, the temporal merge must insert nothing and phase out
			// nothing — the whole point of the round-trip safety net.
			const reimportRows = restDtoToNormalizedRows(dtos);
			const reapplied = runUnitOfWork(database, (unitOfWork) => applyRows(unitOfWork, reimportRows), {
				systemTime: "2026-05-22 11:00:00",
				startedAt: Date.now(),
			});
			expect(reapplied.nodeContent?.inserted).toBe(0);
			expect(reapplied.nodeContent?.phasedOut).toBe(0);
			expect(reapplied.nodeContent?.unchanged).toBe(4);
			expect(reapplied.nodeMetadata?.inserted).toBe(0);
			expect(reapplied.nodeMetadata?.phasedOut).toBe(0);
			expect(reapplied.nodeMetadata?.unchanged).toBe(4);

			const contentVersions = database.get<{count: number}>(sql`SELECT COUNT(*) AS count FROM node_content`);
			const metadataVersions = database.get<{count: number}>(sql`SELECT COUNT(*) AS count FROM node_metadata`);
			expect(contentVersions.count).toBe(4);
			expect(metadataVersions.count).toBe(4);

			sqlite.close();
		});
	});

	describe("two-adapter equivalence", () => {
		it("writes byte-identical node_content and node_metadata rows from both adapters", () => {
			const importedAt = new Date("2026-05-22T10:00:00Z");

			const bulkDb = buildTestDb();
			bulkImportWithWatermarkGuard(bulkDb.database, loadFixtureBackup("equivalence-backup"), importedAt);

			const restDb = buildTestDb();
			restImport(restDb.database, loadFixtureRestApiResponse("equivalence-rest-api-response"), importedAt);

			const bulkContent = bulkDb.database.select().from(nodeContent).all();
			const restContent = restDb.database.select().from(nodeContent).all();
			const bulkMetadata = bulkDb.database.select().from(nodeMetadata).all();
			const restMetadata = restDb.database.select().from(nodeMetadata).all();

			expect(sortById(restContent)).toStrictEqual(sortById(bulkContent));
			expect(sortByNodeId(restMetadata)).toStrictEqual(sortByNodeId(bulkMetadata));

			bulkDb.sqlite.close();
			restDb.sqlite.close();
		});

		it("confirms the test-local adapters agree on the normalized row shapes", () => {
			const bulkRows = normalizeBackupNodes(loadFixtureBackup("equivalence-backup"));
			const restRows = normalizeRestNodes(loadFixtureRestApiResponse("equivalence-rest-api-response"));

			expect(sortById(restRows.nodeContent ?? [])).toStrictEqual(sortById(bulkRows.nodeContent ?? []));
			expect(sortByNodeId(restRows.nodeMetadata ?? [])).toStrictEqual(sortByNodeId(bulkRows.nodeMetadata ?? []));
		});
	});

	describe("watermark guard", () => {
		it("rejects a bulk import older than the local high watermark", () => {
			const {database, sqlite} = buildTestDb();

			const newer = bulkImportWithWatermarkGuard(
				database,
				loadFixtureBackup("small-backup"),
				new Date("2026-05-22T10:00:00Z"),
			);
			expect(newer.skipped).toBe(false);

			const older = bulkImportWithWatermarkGuard(
				database,
				loadFixtureBackup("small-backup"),
				new Date("2026-05-21T10:00:00Z"),
			);
			expect(older).toStrictEqual({skipped: true});

			sqlite.close();
		});

		it("accepts a bulk import newer than the local high watermark", () => {
			const {database, sqlite} = buildTestDb();

			bulkImportWithWatermarkGuard(database, loadFixtureBackup("small-backup"), new Date("2026-05-22T10:00:00Z"));
			const newer = bulkImportWithWatermarkGuard(
				database,
				loadFixtureBackup("small-backup"),
				new Date("2026-05-23T10:00:00Z"),
			);

			expect(newer.skipped).toBe(false);

			sqlite.close();
		});

		it("lets the per-node REST adapter write unconditionally regardless of timestamp order", () => {
			const {database, sqlite} = buildTestDb();
			const restNodes = loadFixtureRestApiResponse("small-rest-api-response");

			restImport(database, restNodes, new Date("2026-05-22T10:00:00Z"));

			// A second import at an OLDER timestamp carrying a changed name. The
			// bulk-export watermark guard would reject this; the per-node REST
			// adapter has no guard and must apply the change unconditionally.
			const editedNodes = restNodes.map((node) =>
				node.id === "11111111-1111-1111-1111-111111111111" ? {...node, name: "Projects (renamed)"} : node,
			);
			const olderResult = restImport(database, editedNodes, new Date("2026-05-21T10:00:00Z"));
			expect(olderResult.nodeContent?.inserted).toBe(1);

			const renamed = new NodeReader(database).getById("11111111-1111-1111-1111-111111111111");
			expect(renamed?.name).toBe("Projects (renamed)");
			expect(renamed?.systemFrom).toMatch(/^2026-05-21/u);

			sqlite.close();
		});
	});

	describe("mirror name resolution", () => {
		it("ignores text stored on a mirror and uses its original text, even when the original is blank", () => {
			const {database, sqlite} = buildTestDb();
			const importedAt = new Date("2026-05-22T10:00:00Z");

			const backup = loadFixtureBackup("mirror-backup");
			const result = bulkImportWithWatermarkGuard(database, backup, importedAt);
			expect(result.skipped).toBe(false);
			insertMirrorRows(database, collectBackupMirrorRows(backup), "2026-05-22 10:00:00");

			const reader = new NodeReader(database);
			const mirrorId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
			const originalId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

			const mirror = reader.getById(mirrorId);
			expect(mirror).toStrictEqual({
				id: mirrorId,
				shortId: "ffffffffffff",
				parentId: null,
				name: null,
				note: null,
				priority: 1,
				layoutMode: null,
				createdAt: new Date("2023-11-14T22:20:00.000Z"),
				modifiedAt: new Date("2023-11-14T22:21:40.000Z"),
				completedAt: null,
				collapsed: false,
				mirror: {isMirror: true, originalNodeId: originalId},
				systemFrom: "2026-05-22 10:00:00.000",
				systemTo: "9999-12-31 23:59:59",
			});

			const original = reader.getById(originalId);
			expect(original).toStrictEqual({
				id: originalId,
				shortId: "eeeeeeeeeeee",
				parentId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
				name: null,
				note: null,
				priority: 0,
				layoutMode: null,
				createdAt: new Date("2023-11-14T22:16:40.000Z"),
				modifiedAt: new Date("2023-11-14T22:18:20.000Z"),
				completedAt: null,
				collapsed: false,
				mirror: {isMirror: false, originalNodeId: null},
				systemFrom: "2026-05-22 10:00:00.000",
				systemTo: "9999-12-31 23:59:59",
			});

			sqlite.close();
		});
	});
});
