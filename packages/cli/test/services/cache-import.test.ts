import {countStrandedRows, currentBacklinkItems, TRANSACTION_TIMEOUT_MS} from "@workflowy/shared/cache";
import {mirrors, nodeContent, nodeMetadata} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@workflowy/shared/temporal";
import {and, eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {BACKUP_IMPORT_CHUNK_SIZE, importBackup} from "../../src/services/cache-import.js";
import {importFromApi} from "../../src/services/cache-import-api.js";
import {cleanupTestDatabase, createTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {expectActiveRecord} from "../helpers/assertion-helpers.js";
import {createApiNode, createNodeFromContent} from "../helpers/node-fixtures.js";
import {assert, it, afterEach, expect, describe, beforeEach, vi} from "vite-plus/test";

const T0 = new Date("2024-01-01T00:00:00Z");
const T1 = new Date("2024-01-01T00:01:00Z");

type ImportResult = Awaited<ReturnType<typeof importBackup>>;

function expectImportStats(
	result: ImportResult,
	expected: {
		totalNodes: number;
		nodesAdded: number;
		nodesUpdated: number;
		nodesUnchanged: number;
		nodesDeleted: number;
		nodesPhasedOut: number;
		contentUpdated: number;
		metadataUpdated: number;
		priorityUpdated: number;
	},
) {
	expect(result.importTimestamp).toBeInstanceOf(Date);
	const {
		totalNodes,
		nodesAdded,
		nodesUpdated,
		nodesUnchanged,
		nodesDeleted,
		nodesPhasedOut,
		contentUpdated,
		metadataUpdated,
		priorityUpdated,
	} = result;
	const stats = {
		totalNodes,
		nodesAdded,
		nodesUpdated,
		nodesUnchanged,
		nodesDeleted,
		nodesPhasedOut,
		contentUpdated,
		metadataUpdated,
		priorityUpdated,
	};
	expect(stats).toStrictEqual(expected);
}

describe("cache-import service", () => {
	let tempDir: string;
	let testDatabase: TestDatabase;
	let originalEpoch: string | undefined;

	beforeEach(() => {
		originalEpoch = process.env.WORKFLOWY_EPOCH;
		process.env.WORKFLOWY_EPOCH = "0";

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-import-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
	});

	afterEach(() => {
		if (originalEpoch === undefined) {
			delete process.env.WORKFLOWY_EPOCH;
		} else {
			process.env.WORKFLOWY_EPOCH = originalEpoch;
		}

		cleanupTestDatabase(testDatabase);
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	function writeBackupFile(content: unknown): string {
		const filePath = path.join(tempDir, "backup.json");
		fs.writeFileSync(filePath, JSON.stringify(content));
		return filePath;
	}

	describe("import into empty database", () => {
		it("imports a single node", async () => {
			const backupContent = [
				{
					id: "node-1",
					nm: "Test Node",
				},
			];
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expectImportStats(result, {
				totalNodes: 1,
				nodesAdded: 1,
				nodesUpdated: 0,
				nodesUnchanged: 0,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
			});

			const [node] = testDatabase.db.select().from(nodeContent).all();
			assert(node);
			// oxlint-disable-next-line @typescript-eslint/no-unused-vars
			const {systemFrom, ...contentRest} = node;
			expect(contentRest).toStrictEqual({
				id: "node-1",
				name: "Test Node",
				note: null,
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});
			expectActiveRecord(createNodeFromContent(node));
		});

		it("imports multiple root nodes", async () => {
			const backupContent = [
				{id: "node-1", nm: "First Node"},
				{id: "node-2", nm: "Second Node"},
				{id: "node-3", nm: "Third Node"},
			];
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expectImportStats(result, {
				totalNodes: 3,
				nodesAdded: 3,
				nodesUpdated: 0,
				nodesUnchanged: 0,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
			});

			const allContent = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all();
			expect(allContent.map((n) => n.id).toSorted()).toStrictEqual(["node-1", "node-2", "node-3"]);

			const allMetadata = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.systemTo, FAR_FUTURE_DATE))
				.all();
			expect(allMetadata.map((m) => m.priority)).toStrictEqual([0, 100, 200]);
		});

		it("imports nested nodes with correct parent relationships", async () => {
			const backupContent = [
				{
					id: "parent-1",
					nm: "Parent Node",
					ch: [
						{id: "child-1", nm: "First Child"},
						{id: "child-2", nm: "Second Child"},
					],
				},
			];
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expect(result.nodesAdded).toBe(3);

			const parent = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "parent-1")).get()!;
			expect(createNodeFromContent(parent)).toStrictEqual(
				createNodeFromContent({
					id: "parent-1",
					name: "Parent Node",
					note: null,
					parentId: null,
					systemFrom: parent.systemFrom,
					systemTo: FAR_FUTURE_DATE,
				}),
			);

			const childContentRecords = ["child-1", "child-2"].map((id) =>
				testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, id)).get()!,
			);
			expect(childContentRecords.map((c) => ({id: c.id, parentId: c.parentId}))).toStrictEqual([
				{id: "child-1", parentId: "parent-1"},
				{id: "child-2", parentId: "parent-1"},
			]);

			const childMetaRecords = ["child-1", "child-2"].map((id) =>
				testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, id)).get()!,
			);
			expect(childMetaRecords.map((m) => ({nodeId: m.nodeId, priority: m.priority}))).toStrictEqual([
				{nodeId: "child-1", priority: 0},
				{nodeId: "child-2", priority: 100},
			]);
		});

		it("imports deeply nested tree", async () => {
			const backupContent = [
				{
					id: "level-1",
					nm: "Level 1",
					ch: [
						{
							id: "level-2",
							nm: "Level 2",
							ch: [
								{
									id: "level-3",
									nm: "Level 3",
									ch: [{id: "level-4", nm: "Level 4"}],
								},
							],
						},
					],
				},
			];
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expect(result.nodesAdded).toBe(4);

			const level4 = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "level-4")).get()!;
			expect(level4.parentId).toBe("level-3");
		});

		it("imports node with all metadata", async () => {
			const backupContent = [
				{
					id: "full-node",
					nm: "Full Node",
					no: "This is a note",
					cp: 1_704_067_200,
					lm: 1_704_153_600,
					ct: 1_703_980_800,
					metadata: {
						layoutMode: "board",
					},
				},
			];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const content = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "full-node")).get()!;
			// oxlint-disable-next-line @typescript-eslint/no-unused-vars
			const {systemFrom, ...contentRest} = content;
			expect(contentRest).toStrictEqual({
				id: "full-node",
				name: "Full Node",
				note: "This is a note",
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});

			const metadata = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "full-node"))
				.get()!;
			expect({completedAt: metadata.completedAt, layoutMode: metadata.layoutMode}).toStrictEqual({
				completedAt: new Date(1_704_067_200 * 1000),
				layoutMode: "board",
			});
		});
	});

	describe("re-import identical backup", () => {
		it("does not create duplicates for unchanged nodes", async () => {
			const backupContent = [{id: "node-1", nm: "Test Node"}];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const firstImportNode = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.id, "node-1"))
				.get()!;
			const firstSystemFrom = firstImportNode.systemFrom;

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expectImportStats(result, {
				totalNodes: 1,
				nodesAdded: 0,
				nodesUpdated: 0,
				nodesUnchanged: 1,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
			});

			const allNodes = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).all();
			expect(allNodes.map((n) => ({systemFrom: n.systemFrom, systemTo: n.systemTo}))).toStrictEqual([
				{systemFrom: firstSystemFrom, systemTo: FAR_FUTURE_DATE},
			]);
		});

		it("handles multiple re-imports correctly", async () => {
			const backupContent = [{id: "node-1", nm: "Test Node"}];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");
			await importBackup(testDatabase.db, filePath, "backup.json");
			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expect(result.nodesUnchanged).toBe(1);

			const activeNodes = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all();
			expect(activeNodes.map((n) => n.id)).toStrictEqual(["node-1"]);
		});
	});

	describe("import with modifications", () => {
		it("stores correct priority order during initial import", async () => {
			const initialBackup = [
				{id: "node-1", nm: "First"},
				{id: "node-2", nm: "Second"},
			];

			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json");

			const metas = ["node-1", "node-2"].map((id) =>
				testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, id)).get()!,
			);
			expect(metas.map((m) => ({nodeId: m.nodeId, priority: m.priority}))).toStrictEqual([
				{nodeId: "node-1", priority: 0},
				{nodeId: "node-2", priority: 100},
			]);
		});

		it("stores correct parent-child relationships", async () => {
			const initialBackup = [
				{id: "parent-a", nm: "Parent A", ch: [{id: "child-1", nm: "Child"}]},
				{id: "parent-b", nm: "Parent B"},
			];

			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json");

			const records = ["child-1", "parent-a"].map((id) =>
				testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, id)).get()!,
			);
			expect(records.map((r) => ({id: r.id, parentId: r.parentId}))).toStrictEqual([
				{id: "child-1", parentId: "parent-a"},
				{id: "parent-a", parentId: null},
			]);
		});
	});

	describe("import with deleted nodes", () => {
		it("phases out nodes that are missing from backup", async () => {
			const initialBackup = [
				{id: "node-1", nm: "Keep Me"},
				{id: "node-2", nm: "Delete Me"},
			];
			const reducedBackup = [{id: "node-1", nm: "Keep Me"}];

			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const reducedPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(reducedPath, JSON.stringify(reducedBackup));

			await importBackup(testDatabase.db, reducedPath, "backup.json", false, T1);

			const activeIds = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((n) => n.id)
				.toSorted();
			expect(activeIds).toStrictEqual(["node-1"]);
		});
	});

	describe("import of a snapshot older than the cache", () => {
		// A backup only describes the tree as of the moment it was taken, so it
		// cannot testify that a node written afterwards was deleted. Nodes newer
		// than the snapshot survive; everything else still merges normally.
		const currentBackup = [
			{id: "node-1", nm: "Original", ct: 1000, lm: 1000},
			{id: "node-2", nm: "Added after the snapshot", ct: 5000, lm: 5000},
		];
		const olderSnapshot = [{id: "node-1", nm: "Renamed in the older snapshot", ct: 1000, lm: 2000}];

		async function importBoth(force: boolean): Promise<ImportResult> {
			const currentPath = writeBackupFile(currentBackup);
			await importBackup(testDatabase.db, currentPath, "backup.json", false, T0);

			const olderPath = path.join(tempDir, "older.json");
			fs.writeFileSync(olderPath, JSON.stringify(olderSnapshot));
			return importBackup(testDatabase.db, olderPath, "older.json", false, T1, force);
		}

		function activeNames(): string[] {
			return testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((n) => n.name ?? "")
				.toSorted();
		}

		it("applies the snapshot but keeps nodes newer than it", async () => {
			const result = await importBoth(false);

			expect(result.skipped).toBe(false);
			expect(result.nodesPreserved).toBe(1);
			expect(activeNames()).toStrictEqual(["Added after the snapshot", "Renamed in the older snapshot"]);
		});

		it("phases out the newer nodes when forced", async () => {
			const result = await importBoth(true);

			expect(result.nodesPreserved).toBe(0);
			expect(activeNames()).toStrictEqual(["Renamed in the older snapshot"]);
		});
	});

	describe("temporal timestamps", () => {
		it("uses correct systemFrom timestamp for new records", async () => {
			const backupContent = [{id: "node-1", nm: "Test Node"}];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json", false, T0);

			const node = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
			expect(node.systemFrom).toBe("2024-01-01 00:00:00.000");
		});

		it("sets systemTo to FAR_FUTURE_DATE for active records", async () => {
			const backupContent = [{id: "node-1", nm: "Test Node"}];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const node = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
			expect(node.systemTo).toBe(FAR_FUTURE_DATE);
		});

		it("preserves systemFrom timestamp for unchanged nodes", async () => {
			const backupContent = [{id: "node-1", nm: "Test Node"}];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json", false, T0);
			const firstNode = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
			const originalSystemFrom = firstNode.systemFrom;

			await importBackup(testDatabase.db, filePath, "backup.json", false, T1);
			const secondNode = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;

			expect(secondNode.systemFrom).toBe(originalSystemFrom);
		});
	});

	describe("node_content and node_metadata tables", () => {
		it("creates content records with correct data", async () => {
			const backupContent = [
				{
					id: "node-1",
					nm: "Test Name",
					no: "Test Note",
					ch: [{id: "child-1", nm: "Child"}],
				},
			];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const content = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
			// oxlint-disable-next-line @typescript-eslint/no-unused-vars
			const {systemFrom, ...contentRest} = content;
			expect(contentRest).toStrictEqual({
				id: "node-1",
				name: "Test Name",
				note: "Test Note",
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});

			const childContent = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "child-1")).get()!;
			// oxlint-disable-next-line @typescript-eslint/no-unused-vars
			const {systemFrom: _childSf, ...childRest} = childContent;
			expect(childRest).toStrictEqual({
				id: "child-1",
				name: "Child",
				note: null,
				parentId: "node-1",
				systemTo: FAR_FUTURE_DATE,
			});
		});

		it("creates metadata records with correct data", async () => {
			const backupContent = [
				{
					id: "node-1",
					nm: "Test",
					ct: 1_704_067_200,
					lm: 1_704_153_600,
					cp: 1_704_240_000,
					metadata: {
						layoutMode: "document",
					},
				},
			];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const metadata = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "node-1"))
				.get()!;
			// oxlint-disable-next-line @typescript-eslint/no-unused-vars
			const {systemFrom: _metaSf, ...metaRest} = metadata;
			expect(metaRest).toStrictEqual({
				nodeId: "node-1",
				shortId: "node1",
				priority: 0,
				createdAt: new Date(1_704_067_200 * 1000),
				modifiedAt: new Date(1_704_153_600 * 1000),
				completedAt: new Date(1_704_240_000 * 1000),
				layoutMode: "document",
				systemTo: FAR_FUTURE_DATE,
			});
		});

		it("creates content and metadata records together on initial import", async () => {
			const backupContent = [{id: "node-1", nm: "Test Node", ct: 1_704_067_200}];

			const filePath = writeBackupFile(backupContent);
			await importBackup(testDatabase.db, filePath, "backup.json");

			const content = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
			expect({name: content.name, systemTo: content.systemTo}).toStrictEqual({
				name: "Test Node",
				systemTo: FAR_FUTURE_DATE,
			});

			const metadata = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "node-1"))
				.get()!;
			// oxlint-disable-next-line @typescript-eslint/no-unused-vars
			const {systemFrom: _metaSf2, ...metaRest2} = metadata;
			expect(metaRest2).toStrictEqual({
				nodeId: "node-1",
				shortId: "node1",
				priority: 0,
				createdAt: new Date(1_704_067_200 * 1000),
				modifiedAt: null,
				completedAt: null,
				layoutMode: null,
				systemTo: FAR_FUTURE_DATE,
			});
		});
	});

	describe("mirror records", () => {
		it("imports mirror originalId", async () => {
			const backupContent = [
				{id: "original-node", nm: "Original"},
				{
					id: "mirror-node",
					nm: "Mirror",
					metadata: {
						mirror: {
							originalId: "original-node",
							isMirrorRoot: true,
						},
					},
				},
			];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const mirror = testDatabase.db.select().from(mirrors).where(eq(mirrors.mirrorId, "mirror-node")).get()!;
			expect({originalId: mirror.originalId, systemTo: mirror.systemTo}).toStrictEqual({
				originalId: "original-node",
				systemTo: FAR_FUTURE_DATE,
			});
		});

		it("updates mirror when originalId changes", async () => {
			const initialBackup = [
				{id: "original-1", nm: "Original 1"},
				{id: "original-2", nm: "Original 2"},
				{
					id: "mirror-node",
					nm: "Mirror",
					metadata: {mirror: {originalId: "original-1", isMirrorRoot: true}},
				},
			];
			const modifiedBackup = [
				{id: "original-1", nm: "Original 1"},
				{id: "original-2", nm: "Original 2"},
				{
					id: "mirror-node",
					nm: "Mirror",
					metadata: {mirror: {originalId: "original-2", isMirrorRoot: true}},
				},
			];

			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const modifiedPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(modifiedPath, JSON.stringify(modifiedBackup));
			await importBackup(testDatabase.db, modifiedPath, "backup.json", false, T1);

			const allMirrors = testDatabase.db.select().from(mirrors).where(eq(mirrors.mirrorId, "mirror-node")).all();
			expect(
				allMirrors.map((m) => ({originalId: m.originalId, active: m.systemTo === FAR_FUTURE_DATE})),
			).toStrictEqual([
				{originalId: "original-1", active: false},
				{originalId: "original-2", active: true},
			]);
		});

		it("imports mirrorRootIds with the owning node as the original", async () => {
			// A node carrying `mirrorRootIds` is the original; the listed ids are its
			// mirror copies. The original keeps its own content; the mirrors are empty.
			const backupContent = [
				{
					id: "original-node",
					nm: "⏰ Tasks (due dates) (work)",
					metadata: {
						mirror: {
							mirrorRootIds: {"mirror-a": true},
						},
					},
				},
				{id: "mirror-a", nm: ""},
			];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const mirror = testDatabase.db.select().from(mirrors).where(eq(mirrors.mirrorId, "mirror-a")).get()!;
			expect({originalId: mirror.originalId, mirrorId: mirror.mirrorId}).toStrictEqual({
				originalId: "original-node",
				mirrorId: "mirror-a",
			});
			// The owning node must never be recorded as a mirror of its own copies.
			const inverted = testDatabase.db.select().from(mirrors).where(eq(mirrors.mirrorId, "original-node")).all();
			expect(inverted).toStrictEqual([]);
		});
	});

	describe("dangling mirror records", () => {
		// Workflowy keeps a mirror's `originalId` after its original is deleted,
		// and an original's `mirrorRootIds` after one of its mirrors is deleted.
		// A relationship is only recorded while both of its nodes exist.
		function activeMirrorRows() {
			return testDatabase.db
				.select({originalId: mirrors.originalId, mirrorId: mirrors.mirrorId, systemTo: mirrors.systemTo})
				.from(mirrors)
				.all()
				.map((m) => ({originalId: m.originalId, mirrorId: m.mirrorId, active: m.systemTo === FAR_FUTURE_DATE}));
		}

		it("skips a mirror whose original is absent from the backup", async () => {
			const filePath = writeBackupFile([
				{id: "mirror-node", nm: "", metadata: {mirror: {originalId: "deleted-original", isMirrorRoot: true}}},
			]);

			await importBackup(testDatabase.db, filePath, "backup.json");

			expect(activeMirrorRows()).toStrictEqual([]);
		});

		it("skips mirrorRootIds and backlinkMirrorRootIds naming mirrors absent from the backup", async () => {
			const filePath = writeBackupFile([
				{
					id: "original-node",
					nm: "Original",
					metadata: {
						mirror: {
							mirrorRootIds: {"deleted-mirror": true, "live-mirror": true},
							backlinkMirrorRootIds: {"deleted-backlink-mirror": true},
						},
					},
				},
				{id: "live-mirror", nm: ""},
			]);

			await importBackup(testDatabase.db, filePath, "backup.json");

			expect(activeMirrorRows()).toStrictEqual([
				{originalId: "original-node", mirrorId: "live-mirror", active: true},
			]);
		});

		it("closes a mirror row once its original disappears from a later backup", async () => {
			const mirrorNode = {
				id: "mirror-node",
				nm: "",
				metadata: {mirror: {originalId: "original-node", isMirrorRoot: true}},
			};
			await importBackup(
				testDatabase.db,
				writeBackupFile([{id: "original-node", nm: "Original"}, mirrorNode]),
				"backup.json",
				false,
				T0,
			);

			const laterPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(laterPath, JSON.stringify([mirrorNode]));
			await importBackup(testDatabase.db, laterPath, "backup2.json", false, T1);

			expect(activeMirrorRows()).toStrictEqual([
				{originalId: "original-node", mirrorId: "mirror-node", active: false},
			]);
		});
	});

	describe("backlink records", () => {
		/** A target whose references root holds a backlink item carrying `metadata`, and the linking source. */
		const backlinkBackup = (metadata: Record<string, unknown>) => [
			{id: "source-node", nm: "Links to Target"},
			{
				id: "target-node",
				nm: "Target",
				ch: [{id: "refs", nm: "", metadata: {isReferencesRoot: true}, ch: [{id: "bn", nm: "", metadata}]}],
			},
		];

		it("imports a backlink item as a mirror of its source, from which the backlink derives", async () => {
			await importBackup(
				testDatabase.db,
				writeBackupFile(backlinkBackup({backlink: {sourceID: "source-node", targetID: "target-node"}})),
				"backup.json",
			);

			expect(currentBacklinkItems(testDatabase.db, undefined)).toStrictEqual([
				{nodeId: "bn", sourceId: "source-node", targetId: "target-node"},
			]);
		});

		it("closes a backlink globally when it disappears on re-import, even if the node keeps none", async () => {
			await importBackup(
				testDatabase.db,
				writeBackupFile(backlinkBackup({backlink: {sourceID: "source-node", targetID: "target-node"}})),
				"backup.json",
				false,
				T0,
			);

			// Re-import: the item still exists, but its backlink is gone. A full backup is
			// the complete desired state, so its mirror row must close.
			await importBackup(testDatabase.db, writeBackupFile(backlinkBackup({})), "backup.json", false, T1);

			expect(currentBacklinkItems(testDatabase.db, undefined)).toStrictEqual([]);
		});

		it("ends a backlink item whose source is absent from the backup, leaving no stranded rows", async () => {
			const backup = backlinkBackup({backlink: {sourceID: "source-node", targetID: "target-node"}}).filter(
				(node) => node.id !== "source-node",
			);

			await importBackup(testDatabase.db, writeBackupFile(backup), "backup.json", false, T0);

			expect({
				refsChildren: testDatabase.db
					.select({id: nodeContent.id})
					.from(nodeContent)
					.where(and(eq(nodeContent.parentId, "refs"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
					.all(),
				stranded: countStrandedRows(testDatabase.db),
			}).toStrictEqual({
				refsChildren: [],
				stranded: {backlinkItems: 0, mirrors: 0, referencesRoots: 0},
			});
		});

		it("never writes a version of a backlink item whose source is absent from the backup", async () => {
			const backup = backlinkBackup({backlink: {sourceID: "source-node", targetID: "target-node"}}).filter(
				(node) => node.id !== "source-node",
			);

			// The clock ticks on every node insert, so no two units of work share a system time.
			vi.useFakeTimers({toFake: ["Date"], now: T0});
			testDatabase.sqlite.function("advance_clock", () => {
				vi.setSystemTime(Date.now() + 1);
				return 0;
			});
			testDatabase.sqlite.exec(
				"CREATE TEMP TRIGGER advance_clock_on_insert AFTER INSERT ON node_content BEGIN SELECT advance_clock(); END",
			);
			try {
				await importBackup(testDatabase.db, writeBackupFile(backup), "backup.json");
				await importBackup(testDatabase.db, writeBackupFile(backup), "backup.json");
			} finally {
				vi.useRealTimers();
			}

			expect(
				testDatabase.db
					.select({id: nodeContent.id, systemFrom: nodeContent.systemFrom, systemTo: nodeContent.systemTo})
					.from(nodeContent)
					.where(eq(nodeContent.id, "bn"))
					.all(),
			).toStrictEqual([]);
		});
	});

	describe("units of work", () => {
		it("keeps the committed node chunks and rolls back the final unit when merging a relationship table fails", async () => {
			await importBackup(
				testDatabase.db,
				writeBackupFile([
					{id: "kept", nm: "Kept"},
					{id: "doomed", nm: "Doomed"},
					{id: "gone", nm: "Gone"},
				]),
				"backup.json",
				false,
				T0,
			);
			const currentContent = () =>
				testDatabase.db
					.select({id: nodeContent.id, name: nodeContent.name})
					.from(nodeContent)
					.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
					.orderBy(nodeContent.id)
					.all();
			testDatabase.sqlite.exec(
				"CREATE TRIGGER fail_mirror BEFORE INSERT ON mirrors BEGIN SELECT RAISE(ABORT, 'mirror failed'); END",
			);

			await expect(
				importBackup(
					testDatabase.db,
					writeBackupFile([
						{
							id: "kept",
							nm: "Kept, renamed",
							metadata: {mirror: {originalId: "doomed", isMirrorRoot: true}},
						},
						{id: "doomed", nm: "Doomed"},
					]),
					"backup.json",
					false,
					T1,
				),
			).rejects.toThrow("mirror failed");

			// The node chunk committed the rename; the final unit's deletion of "gone" rolled back with the mirror.
			expect(currentContent()).toStrictEqual([
				{id: "doomed", name: "Doomed"},
				{id: "gone", name: "Gone"},
				{id: "kept", name: "Kept, renamed"},
			]);
		});
	});

	describe("validation errors", () => {
		it("throws error for invalid backup format", async () => {
			const backupContent = [
				{id: "valid-node", nm: "Valid Node"},
				{id: null, nm: "Invalid Node"},
				{id: "another-valid", nm: "Another Valid"},
			];
			const filePath = writeBackupFile(backupContent);

			const error = await importBackup(testDatabase.db, filePath, "backup.json").catch(
				(caught: unknown) => caught,
			);
			assert(error instanceof Error);
			expect({name: error.name, message: error.message}).toStrictEqual({
				name: "ZodError",
				message: `[
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
      1,
      "id"
    ],
    "message": "Invalid input: expected string, received null"
  }
]`,
			});
		});

		it("aborts without closing any node when one node fails schema validation", async () => {
			const initialPath = writeBackupFile([
				{id: "node-1", nm: "Keep Me"},
				{id: "node-2", nm: "Unknown Field"},
			]);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const invalidPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(
				invalidPath,
				JSON.stringify([
					{id: "node-1", nm: "Keep Me"},
					{id: "node-2", nm: "Unknown Field", metadata: {color: "red"}},
				]),
			);
			const error = await importBackup(testDatabase.db, invalidPath, "backup.json", false, T1).catch(
				(caught: unknown) => caught,
			);

			const activeIds = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((n) => n.id)
				.toSorted();
			assert(error instanceof Error);
			expect({name: error.name, activeIds}).toStrictEqual({name: "ZodError", activeIds: ["node-1", "node-2"]});
		});

		it("imports valid nodes from file with all valid entries", async () => {
			const backupContent = [
				{id: "valid-node-1", nm: "Valid Node 1"},
				{id: "valid-node-2", nm: "Valid Node 2"},
			];
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expect(result.nodesAdded).toBe(2);
		});
	});

	describe("batch processing", () => {
		it("handles large number of nodes", async () => {
			const backupContent: {id: string; nm: string}[] = [];
			for (let i = 0; i < 2500; i++) {
				backupContent.push({id: `node-${i}`, nm: `Node ${i}`});
			}
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expectImportStats(result, {
				totalNodes: 2500,
				nodesAdded: 2500,
				nodesUpdated: 0,
				nodesUnchanged: 0,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
			});

			const count = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all().length;
			expect(count).toBe(2500);
		});
	});

	describe("empty backup", () => {
		it("handles empty backup file", async () => {
			const backupContent: unknown[] = [];
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expectImportStats(result, {
				totalNodes: 0,
				nodesAdded: 0,
				nodesUpdated: 0,
				nodesUnchanged: 0,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
			});
		});

		it("phases out all existing nodes when importing empty backup", async () => {
			const initialBackup = [
				{id: "node-1", nm: "Node 1"},
				{id: "node-2", nm: "Node 2"},
			];
			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const emptyBackup: unknown[] = [];
			const emptyPath = path.join(tempDir, "empty.json");
			fs.writeFileSync(emptyPath, JSON.stringify(emptyBackup));

			await importBackup(testDatabase.db, emptyPath, "empty.json", false, T1);

			const activeNodes = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all();
			expect(activeNodes).toStrictEqual([]);
		});
	});

	describe("special characters", () => {
		it("handles special characters in node names", async () => {
			const backupContent = [
				{id: "node-1", nm: 'Hello <b>World</b> & "Quotes"'},
				{id: "node-2", nm: "Unicode: 日本語 🎉 émojis"},
				{id: "node-3", nm: "Newlines\nin\nnames"},
			];
			const filePath = writeBackupFile(backupContent);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expect(result.nodesAdded).toBe(3);

			const node1 = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
			expect(node1.name).toBe('Hello <b>World</b> & "Quotes"');

			const node2 = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-2")).get()!;
			expect(node2.name).toBe("Unicode: 日本語 🎉 émojis");
		});
	});

	describe("priority inference for new nodes", () => {
		it("infers priorities for new nodes at front of existing siblings", async () => {
			const initialBackup = [
				{
					id: "parent-1",
					nm: "Parent",
					ch: [
						{id: "existing-1", nm: "Existing 1"},
						{id: "existing-2", nm: "Existing 2"},
					],
				},
			];
			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const meta1 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "existing-1"))
				.get()!;
			const meta2 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "existing-2"))
				.get()!;
			expect(meta1.priority).toBe(0);
			expect(meta2.priority).toBe(100);

			const updatedBackup = [
				{
					id: "parent-1",
					nm: "Parent",
					ch: [
						{id: "new-1", nm: "New 1"},
						{id: "new-2", nm: "New 2"},
						{id: "existing-1", nm: "Existing 1"},
						{id: "existing-2", nm: "Existing 2"},
					],
				},
			];
			const updatedPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(updatedPath, JSON.stringify(updatedBackup));
			await importBackup(testDatabase.db, updatedPath, "backup.json", false, T1);

			const newMeta1 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "new-1"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;
			const newMeta2 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "new-2"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;

			expect(newMeta2.priority).toBe(-100);
			expect(newMeta1.priority).toBe(-200);

			const existingMeta1 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "existing-1"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;
			expect(existingMeta1.priority).toBe(0);
		});

		it("infers priorities for new nodes at end of existing siblings", async () => {
			const initialBackup = [
				{
					id: "parent-1",
					nm: "Parent",
					ch: [
						{id: "existing-1", nm: "Existing 1"},
						{id: "existing-2", nm: "Existing 2"},
					],
				},
			];
			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const updatedBackup = [
				{
					id: "parent-1",
					nm: "Parent",
					ch: [
						{id: "existing-1", nm: "Existing 1"},
						{id: "existing-2", nm: "Existing 2"},
						{id: "new-1", nm: "New 1"},
						{id: "new-2", nm: "New 2"},
					],
				},
			];
			const updatedPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(updatedPath, JSON.stringify(updatedBackup));
			await importBackup(testDatabase.db, updatedPath, "backup.json", false, T1);

			const newMeta1 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "new-1"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;
			const newMeta2 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "new-2"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;

			expect(newMeta1.priority).toBe(200);
			expect(newMeta2.priority).toBe(300);
		});

		it("infers priority for new node between existing nodes", async () => {
			const initialBackup = [
				{
					id: "parent-1",
					nm: "Parent",
					ch: [
						{id: "existing-1", nm: "Existing 1"},
						{id: "existing-2", nm: "Existing 2"},
					],
				},
			];
			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const updatedBackup = [
				{
					id: "parent-1",
					nm: "Parent",
					ch: [
						{id: "existing-1", nm: "Existing 1"},
						{id: "new-middle", nm: "New Middle"},
						{id: "existing-2", nm: "Existing 2"},
					],
				},
			];
			const updatedPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(updatedPath, JSON.stringify(updatedBackup));
			await importBackup(testDatabase.db, updatedPath, "backup.json", false, T1);

			const newMeta = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "new-middle"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;

			expect(newMeta.priority).toBe(50);
		});

		it("respaces siblings instead of tying a new node with its neighbour when the gap is used up", async () => {
			const existing = [
				{id: "existing-1", nm: "Existing 1"},
				{id: "existing-2", nm: "Existing 2"},
			];
			const initialPath = writeBackupFile([{id: "parent-1", nm: "Parent", ch: existing}]);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			// Eight new nodes between priorities 0 and 100 halve the gap down to nothing: 50, 75, 87, 93, 96, 98, 99, 99.
			const newNodes = Array.from({length: 8}, (_, i) => ({id: `new-${i + 1}`, nm: `New ${i + 1}`}));
			const updatedPath = path.join(tempDir, "backup2.json");
			fs.writeFileSync(
				updatedPath,
				JSON.stringify([{id: "parent-1", nm: "Parent", ch: [existing[0], ...newNodes, existing[1]]}]),
			);
			await importBackup(testDatabase.db, updatedPath, "backup.json", false, T1);

			const current = testDatabase.db
				.select({nodeId: nodeMetadata.nodeId, priority: nodeMetadata.priority})
				.from(nodeMetadata)
				.where(eq(nodeMetadata.systemTo, FAR_FUTURE_DATE))
				.all()
				.filter((m) => m.nodeId !== "parent-1")
				.toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

			expect(current).toStrictEqual([
				{nodeId: "existing-1", priority: -800},
				{nodeId: "new-1", priority: -700},
				{nodeId: "new-2", priority: -600},
				{nodeId: "new-3", priority: -500},
				{nodeId: "new-4", priority: -400},
				{nodeId: "new-5", priority: -300},
				{nodeId: "new-6", priority: -200},
				{nodeId: "new-7", priority: -100},
				{nodeId: "new-8", priority: 0},
				{nodeId: "existing-2", priority: 100},
			]);
		});

		it("handles all new nodes with no existing siblings", async () => {
			const backupContent = [
				{
					id: "parent-1",
					nm: "Parent",
					ch: [
						{id: "child-1", nm: "Child 1"},
						{id: "child-2", nm: "Child 2"},
						{id: "child-3", nm: "Child 3"},
					],
				},
			];
			const filePath = writeBackupFile(backupContent);

			await importBackup(testDatabase.db, filePath, "backup.json");

			const meta1 = testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, "child-1")).get()!;
			const meta2 = testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, "child-2")).get()!;
			const meta3 = testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, "child-3")).get()!;

			expect(meta1.priority).toBe(0);
			expect(meta2.priority).toBe(100);
			expect(meta3.priority).toBe(200);
		});

		it("preserves existing priority on re-import even if tree position changes", async () => {
			const initialBackup = [
				{id: "node-1", nm: "Node 1"},
				{id: "node-2", nm: "Node 2"},
			];
			const initialPath = writeBackupFile(initialBackup);
			await importBackup(testDatabase.db, initialPath, "backup.json", false, T0);

			const initialMeta1 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "node-1"))
				.get()!;
			const initialMeta2 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "node-2"))
				.get()!;
			expect(initialMeta1.priority).toBe(0);
			expect(initialMeta2.priority).toBe(100);

			const result = await importBackup(testDatabase.db, initialPath, "backup.json", false, T1);

			expect(result.nodesUnchanged).toBe(2);
			expect(result.nodesUpdated).toBe(0);

			const finalMeta1 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "node-1"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;
			const finalMeta2 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "node-2"))
				.all()
				.find((m) => m.systemTo === FAR_FUTURE_DATE)!;
			expect(finalMeta1.priority).toBe(0);
			expect(finalMeta2.priority).toBe(100);
		});
	});

	describe("stale-snapshot watermark guard", () => {
		// Backup ct/lm/cp are Unix seconds (epoch=0 in this suite). Both watermarks
		// are source content timestamps, so the `timestamp` argument passed to
		// importBackup (a cache-write time) does not affect them.
		const DATE_EARLIER = new Date("2026-04-01T00:00:00Z");
		const DATE_MIDDLE = new Date("2026-04-05T00:00:00Z");
		const DATE_LATER = new Date("2026-04-10T00:00:00Z");
		const T_EARLIER = Math.floor(DATE_EARLIER.getTime() / 1000);
		const T_MIDDLE = Math.floor(DATE_MIDDLE.getTime() / 1000);
		const T_LATER = Math.floor(DATE_LATER.getTime() / 1000);

		// Regression: the local watermark once read node_content.systemFrom, a
		// cache-write time that `cache import-api` stamps with the wall clock on
		// every daily run. That made the cache look newer than every backup
		// forever, so backup imports silently stopped contributing the fields only
		// backups carry (attachments, mirrors). Both write times below are
		// deliberately newer than both content watermarks; only the content
		// timestamps may drive the comparison. They differ from each other because
		// two versions of one node cannot share a system_from.
		const WRITE_1 = new Date("2026-05-01T00:00:00Z");
		const WRITE_2 = new Date("2026-05-02T00:00:00Z");

		it("ignores the cache write time when comparing watermarks", async () => {
			const seedPath = writeBackupFile([{id: "node-1", nm: "Seed", ct: T_EARLIER, lm: T_EARLIER}]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, WRITE_1);

			const newerPath = writeBackupFile([
				{id: "node-1", nm: "Renamed", ct: T_EARLIER, lm: T_MIDDLE},
				{id: "node-2", nm: "Added", ct: T_MIDDLE, lm: T_MIDDLE},
			]);
			const result = await importBackup(testDatabase.db, newerPath, "backup.json", false, WRITE_2);

			expect(result.skipped).toBe(false);
			expect(result.localWatermark).toBe("2026-04-01 00:00:00.000");
			expect(result.incomingWatermark).toBe("2026-04-05 00:00:00.000");
			expect(result.nodesPreserved).toBe(0);
			expect(result.nodesAdded).toBe(1);

			const activeNames = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((n) => n.name ?? "")
				.toSorted();
			expect(activeNames).toStrictEqual(["Added", "Renamed"]);
		});

		it("imports a stale snapshot while protecting the nodes it predates", async () => {
			const seedPath = writeBackupFile([{id: "node-1", nm: "Seed", ct: T_LATER, lm: T_LATER}]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, DATE_LATER);

			const stalePath = writeBackupFile([{id: "node-2", nm: "Stale", ct: T_EARLIER, lm: T_EARLIER}]);
			const result = await importBackup(testDatabase.db, stalePath, "backup.json", false, DATE_LATER);

			expect(result.skipped).toBe(false);
			expect(result.localWatermark).toBe("2026-04-10 00:00:00.000");
			expect(result.incomingWatermark).toBe("2026-04-01 00:00:00.000");
			expect(result.nodesAdded).toBe(1);
			expect(result.nodesPreserved).toBe(1);
			expect(result.nodesDeleted).toBe(0);

			const activeIds = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((n) => n.id)
				.toSorted();
			expect(activeIds).toStrictEqual(["node-1", "node-2"]);
		});

		it("proceeds when the backup snapshot is newer than the local cache", async () => {
			const seedPath = writeBackupFile([{id: "node-1", nm: "Seed", ct: T_EARLIER, lm: T_EARLIER}]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, DATE_EARLIER);

			const freshPath = writeBackupFile([
				{id: "node-1", nm: "Seed", ct: T_EARLIER, lm: T_EARLIER},
				{id: "node-2", nm: "New", ct: T_LATER, lm: T_LATER},
			]);
			const result = await importBackup(testDatabase.db, freshPath, "backup.json", false, DATE_LATER);

			expect(result).toStrictEqual({
				totalNodes: 2,
				nodesAdded: 1,
				nodesUpdated: 0,
				nodesUnchanged: 1,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
				importTimestamp: DATE_LATER,
				nodesPreserved: 0,
				nodesKeptDeleted: 0,
				skipped: false,
				localWatermark: "2026-04-01 00:00:00.000",
				incomingWatermark: "2026-04-10 00:00:00.000",
			});
		});

		// Regression (daily review 2026-11-02): a backup snapshot taken before
		// `cache import-api` saw a deletion re-added the deleted nodes, and the
		// next import-api had to delete them again.
		it("does not re-add a node the cache deleted after the snapshot was taken", async () => {
			const seedPath = writeBackupFile([
				{id: "node-1", nm: "Kept", ct: T_EARLIER, lm: T_EARLIER},
				{id: "node-2", nm: "Deleted", ct: T_EARLIER, lm: T_EARLIER},
			]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, DATE_EARLIER);
			const deletePath = writeBackupFile([{id: "node-1", nm: "Kept", ct: T_EARLIER, lm: T_EARLIER}]);
			await importBackup(testDatabase.db, deletePath, "backup.json", false, DATE_LATER);

			const stalePath = writeBackupFile([
				{id: "node-1", nm: "Kept", ct: T_EARLIER, lm: T_EARLIER},
				{id: "node-2", nm: "Deleted", ct: T_EARLIER, lm: T_MIDDLE},
			]);
			const result = await importBackup(testDatabase.db, stalePath, "backup.json", false, WRITE_1);

			expect(result).toStrictEqual({
				totalNodes: 1,
				nodesAdded: 0,
				nodesUpdated: 0,
				nodesUnchanged: 1,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
				importTimestamp: WRITE_1,
				nodesPreserved: 0,
				nodesKeptDeleted: 1,
				skipped: false,
				localWatermark: "2026-04-01 00:00:00.000",
				incomingWatermark: "2026-04-05 00:00:00.000",
			});
			const activeIds = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((n) => n.id);
			expect(activeIds).toStrictEqual(["node-1"]);
		});

		// Regression (2026-11-03): a backup older than the cache undid newer moves
		// and text edits until the next `cache import-api`. A move leaves the
		// node's last-modified time alone, so only the cache write time shows it.
		it("keeps a move and a text edit the cache wrote after the snapshot was taken", async () => {
			const seedPath = writeBackupFile([
				{
					id: "parent-a",
					nm: "A",
					ct: T_EARLIER,
					lm: T_EARLIER,
					ch: [{id: "moved", nm: "Moved", ct: T_EARLIER, lm: T_EARLIER}],
				},
				{id: "parent-b", nm: "B", ct: T_EARLIER, lm: T_EARLIER},
				{id: "edited", nm: "Original", ct: T_EARLIER, lm: T_EARLIER},
			]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, DATE_EARLIER);

			const apiNode = (id: string, name: string, parentId: string | null, modified: number) =>
				createApiNode({id, name, parent_id: parentId, createdAt: T_EARLIER, modifiedAt: modified});
			importFromApi(
				testDatabase.db,
				[
					apiNode("parent-a", "A", null, T_EARLIER),
					apiNode("parent-b", "B", null, T_EARLIER),
					apiNode("moved", "Moved", "parent-b", T_EARLIER),
					apiNode("edited", "Edited", null, T_LATER),
				],
				false,
				WRITE_1,
			);

			const stalePath = writeBackupFile([
				{
					id: "parent-a",
					nm: "A",
					ct: T_EARLIER,
					lm: T_MIDDLE,
					ch: [{id: "moved", nm: "Moved", ct: T_EARLIER, lm: T_EARLIER}],
				},
				{id: "parent-b", nm: "B", ct: T_EARLIER, lm: T_EARLIER},
				{id: "edited", nm: "Original", ct: T_EARLIER, lm: T_EARLIER},
			]);
			const result = await importBackup(testDatabase.db, stalePath, "backup.json", false, WRITE_2);

			const live = testDatabase.db
				.select({id: nodeContent.id, name: nodeContent.name, parentId: nodeContent.parentId})
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.toSorted((a, b) => a.id.localeCompare(b.id));
			expect({live, nodesDeleted: result.nodesDeleted}).toStrictEqual({
				live: [
					{id: "edited", name: "Edited", parentId: null},
					{id: "moved", name: "Moved", parentId: "parent-b"},
					{id: "parent-a", name: "A", parentId: null},
					{id: "parent-b", name: "B", parentId: null},
				],
				nodesDeleted: 0,
			});
		});

		it("re-adds a deleted node a snapshot newer than the deletion still holds", async () => {
			const seedPath = writeBackupFile([
				{id: "node-1", nm: "Kept", ct: T_EARLIER, lm: T_EARLIER},
				{id: "node-2", nm: "Restored", ct: T_EARLIER, lm: T_EARLIER},
			]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, DATE_EARLIER);
			const deletePath = writeBackupFile([{id: "node-1", nm: "Kept", ct: T_EARLIER, lm: T_EARLIER}]);
			await importBackup(testDatabase.db, deletePath, "backup.json", false, DATE_MIDDLE);

			const freshPath = writeBackupFile([
				{id: "node-1", nm: "Kept", ct: T_EARLIER, lm: T_EARLIER},
				{id: "node-2", nm: "Restored", ct: T_EARLIER, lm: T_LATER},
			]);
			const result = await importBackup(testDatabase.db, freshPath, "backup.json", false, WRITE_1);

			expect(result.nodesAdded).toBe(1);
			expect(result.nodesKeptDeleted).toBe(0);
			const activeIds = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.all()
				.map((n) => n.id)
				.toSorted();
			expect(activeIds).toStrictEqual(["node-1", "node-2"]);
		});

		it("proceeds when the incoming watermark equals the local watermark", async () => {
			const seedPath = writeBackupFile([{id: "node-1", nm: "Seed", ct: T_LATER, lm: T_LATER}]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, DATE_LATER);

			const samePath = writeBackupFile([{id: "node-1", nm: "Seed", ct: T_LATER, lm: T_LATER}]);
			const result = await importBackup(testDatabase.db, samePath, "backup.json", false, DATE_LATER);

			expect(result).toStrictEqual({
				totalNodes: 1,
				nodesAdded: 0,
				nodesUpdated: 0,
				nodesUnchanged: 1,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
				importTimestamp: DATE_LATER,
				nodesPreserved: 0,
				nodesKeptDeleted: 0,
				skipped: false,
				localWatermark: "2026-04-10 00:00:00.000",
				incomingWatermark: "2026-04-10 00:00:00.000",
			});
		});

		it("proceeds when the local cache is empty", async () => {
			const freshPath = writeBackupFile([{id: "node-1", nm: "Only", ct: T_EARLIER, lm: T_EARLIER}]);
			const result = await importBackup(testDatabase.db, freshPath, "backup.json", false, DATE_EARLIER);

			expect(result).toStrictEqual({
				totalNodes: 1,
				nodesAdded: 1,
				nodesUpdated: 0,
				nodesUnchanged: 0,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
				importTimestamp: DATE_EARLIER,
				nodesPreserved: 0,
				nodesKeptDeleted: 0,
				skipped: false,
				localWatermark: null,
				incomingWatermark: "2026-04-01 00:00:00.000",
			});
		});

		it("takes the stale snapshot verbatim when force is passed", async () => {
			const seedPath = writeBackupFile([{id: "node-1", nm: "Seed", ct: T_LATER, lm: T_LATER}]);
			await importBackup(testDatabase.db, seedPath, "backup.json", false, DATE_LATER);

			const stalePath = writeBackupFile([{id: "node-2", nm: "Stale", ct: T_EARLIER, lm: T_EARLIER}]);
			const reimportDate = new Date("2026-04-11T00:00:00Z");
			const result = await importBackup(testDatabase.db, stalePath, "backup.json", false, reimportDate, true);

			expect(result).toStrictEqual({
				totalNodes: 1,
				nodesAdded: 1,
				nodesUpdated: 0,
				nodesUnchanged: 0,
				nodesDeleted: 1,
				nodesPhasedOut: 1,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
				importTimestamp: reimportDate,
				nodesPreserved: 0,
				nodesKeptDeleted: 0,
				skipped: false,
				localWatermark: "2026-04-10 00:00:00.000",
				incomingWatermark: "2026-04-01 00:00:00.000",
			});
			const node2 = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-2")).get()!;
			expectActiveRecord(node2);

			// node-1 is absent from the forced snapshot, so it is tombstoned.
			const node1 = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.id, "node-1"))
				.all()
				.find((n) => n.systemTo === FAR_FUTURE_DATE);
			expect(node1).toBeUndefined();
		});
	});

	describe("transaction timeout", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("commits a backup whose merge outlasts the transaction timeout as one unit per chunk", async () => {
			vi.useFakeTimers({toFake: ["Date"], now: T0});
			// Every node_content insert costs a chunk's share of the timeout, so one chunk fits and one more node does not.
			const tick = Math.floor(TRANSACTION_TIMEOUT_MS / BACKUP_IMPORT_CHUNK_SIZE);
			testDatabase.sqlite.function("advance_clock", () => {
				vi.setSystemTime(Date.now() + tick);
				return 0;
			});
			testDatabase.sqlite.exec(
				"CREATE TEMP TRIGGER advance_clock_on_insert AFTER INSERT ON node_content BEGIN SELECT advance_clock(); END",
			);
			const nodeCount = BACKUP_IMPORT_CHUNK_SIZE + 1;
			const filePath = writeBackupFile(
				Array.from({length: nodeCount}, (_, index) => ({id: `node-${index}`, nm: `Node ${index}`})),
			);

			const result = await importBackup(testDatabase.db, filePath, "backup.json");

			expectImportStats(result, {
				totalNodes: nodeCount,
				nodesAdded: nodeCount,
				nodesUpdated: 0,
				nodesUnchanged: 0,
				nodesDeleted: 0,
				nodesPhasedOut: 0,
				contentUpdated: 0,
				metadataUpdated: 0,
				priorityUpdated: 0,
			});
			const stamps = testDatabase.sqlite
				.prepare(
					"SELECT system_from AS systemFrom, count(*) AS rows FROM node_content WHERE system_to = ? GROUP BY system_from ORDER BY system_from",
				)
				.all(FAR_FUTURE_DATE);
			expect(stamps).toStrictEqual([
				{systemFrom: "2024-01-01 00:00:00.000", rows: BACKUP_IMPORT_CHUNK_SIZE},
				{
					systemFrom: formatTemporalTimestamp(new Date(T0.getTime() + BACKUP_IMPORT_CHUNK_SIZE * tick)),
					rows: 1,
				},
			]);
			expect(result.importTimestamp).toStrictEqual(new Date(T0.getTime() + nodeCount * tick));
		});
	});
});
