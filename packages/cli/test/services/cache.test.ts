import {assert, beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import {
	aiMetadata,
	mirrors,
	nodeContent,
	nodeEmbeddings,
	nodeMetadata,
	referencesRoots,
	calendarLevels,
	calendarMetadata,
	changesMetadata,
	nodeDisplayMetadata,
	s3Files,
} from "@outlinedb/shared/db";
import type {InternalTreeItem} from "@outlinedb/shared/api";
import {
	countStrandedRows,
	currentBacklinkItems,
	SameMillisecondOverwriteError,
	BULK_IMPORT_LEASE_NAME,
	BULK_IMPORT_TIMEOUT_MS,
	TRANSACTION_TIMEOUT_MS,
	TransactionTimeoutError,
	CacheService,
} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {eq, and} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {importFromApi} from "../../src/services/cache-import-api.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {
	createApiNode,
	createNodeFromContent,
	createTestNode,
	splitNodeIntoContentAndMetadata,
} from "../helpers/node-fixtures.js";
import {expectActiveRecord, expectPhasedOut} from "../helpers/assertion-helpers.js";
import {importBackup} from "../../src/services/cache-import.js";

describe("cache import api", () => {
	function expectImportStats(
		result: Awaited<ReturnType<typeof importFromApi>>,
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

	describe("cache-import-api service", () => {
		let tempDir: string;
		let testDatabase: TestDatabase;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-api-import-test-"));
			const testDbPath = path.join(tempDir, "test.sqlite");
			testDatabase = createTestDatabase(testDbPath);
		});

		afterEach(() => {
			cleanupTestDatabase(testDatabase);
			if (fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, {recursive: true, force: true});
			}
		});

		describe("import into empty database", () => {
			it("imports a single API node", () => {
				const apiNodes: WorkflowyNode[] = [createApiNode({id: "node-1", name: "Test Node"})];

				const result = importFromApi(testDatabase.db, apiNodes);

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
				const {id, name, note, parentId, systemTo} = node;
				expect({id, name, note, parentId, systemTo}).toStrictEqual({
					id: "node-1",
					name: "Test Node",
					note: null,
					parentId: null,
					systemTo: FAR_FUTURE_DATE,
				});
				expectActiveRecord(createNodeFromContent(node));
			});

			it("imports multiple API nodes", () => {
				const apiNodes: WorkflowyNode[] = [
					createApiNode({id: "node-1", name: "First Node", priority: 0}),
					createApiNode({id: "node-2", name: "Second Node", priority: 1}),
					createApiNode({id: "node-3", name: "Third Node", priority: 2}),
				];

				const result = importFromApi(testDatabase.db, apiNodes);

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

				const allNodes = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
					.all();
				expect(allNodes.map((n) => n.id).toSorted()).toStrictEqual(["node-1", "node-2", "node-3"]);
			});

			it("imports nodes with parent relationships", () => {
				const apiNodes: WorkflowyNode[] = [
					createApiNode({id: "parent-1", name: "Parent", parent_id: null, priority: 0}),
					createApiNode({id: "child-1", name: "First Child", parent_id: "parent-1", priority: 0}),
					createApiNode({id: "child-2", name: "Second Child", parent_id: "parent-1", priority: 1}),
				];

				const result = importFromApi(testDatabase.db, apiNodes);

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

				const records = ["parent-1", "child-1", "child-2"].map((id) =>
					testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, id)).get()!,
				);
				expect(records.map((r) => ({id: r.id, parentId: r.parentId}))).toStrictEqual([
					{id: "parent-1", parentId: null},
					{id: "child-1", parentId: "parent-1"},
					{id: "child-2", parentId: "parent-1"},
				]);
			});

			it("imports node with all metadata fields", () => {
				const createdAt = 1_700_000_000;
				const modifiedAt = 1_700_086_400;
				const completedAt = 1_700_082_800;
				const apiNodes: WorkflowyNode[] = [
					createApiNode({
						id: "full-node",
						name: "Full Node",
						note: "This is a note",
						completed: true,
						completedAt,
						createdAt,
						modifiedAt,
						data: {layoutMode: "board"},
					}),
				];

				const result = importFromApi(testDatabase.db, apiNodes);

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

				const content = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "full-node"))
					.get()!;
				const {id, name, note, parentId, systemTo} = content;
				expect({id, name, note, parentId, systemTo}).toStrictEqual({
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
					completedAt: new Date(completedAt * 1000),
					layoutMode: "board",
				});
			});
		});

		describe("re-import identical data", () => {
			it("leaves unchanged nodes untouched", () => {
				const apiNodes: WorkflowyNode[] = [createApiNode({id: "node-1", name: "Test Node", priority: 0})];

				const t0 = new Date("2024-01-01T00:00:00Z");
				const t1 = new Date("2024-01-01T00:01:00Z");

				importFromApi(testDatabase.db, apiNodes, false, t0);

				const firstImportNode = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "node-1"))
					.get()!;
				const firstSystemFrom = firstImportNode.systemFrom;

				const result = importFromApi(testDatabase.db, apiNodes, false, t1);

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
		});

		describe("temporal timestamps", () => {
			it("sets systemTo to FAR_FUTURE_DATE for active records", () => {
				const apiNodes: WorkflowyNode[] = [createApiNode({id: "node-1", name: "Test Node"})];

				importFromApi(testDatabase.db, apiNodes);

				const node = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
				expect(node.systemTo).toBe(FAR_FUTURE_DATE);
			});
		});

		describe("node_content and node_metadata tables", () => {
			it("creates content records", () => {
				const apiNodes: WorkflowyNode[] = [
					createApiNode({
						id: "node-1",
						name: "Test Name",
						note: "Test Note",
						parent_id: null,
					}),
				];

				importFromApi(testDatabase.db, apiNodes);

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
			});

			it("creates metadata records", () => {
				const createdAtTimestamp = 1_700_000_000;
				const modifiedAtTimestamp = 1_700_086_400;
				const apiNodes: WorkflowyNode[] = [
					createApiNode({
						id: "node-1",
						name: "Test",
						priority: 5,
						createdAt: createdAtTimestamp,
						modifiedAt: modifiedAtTimestamp,
						data: {layoutMode: "document"},
					}),
				];

				importFromApi(testDatabase.db, apiNodes);

				const metadata = testDatabase.db
					.select()
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "node-1"))
					.get()!;
				// oxlint-disable-next-line @typescript-eslint/no-unused-vars
				const {systemFrom, ...metaRest} = metadata;
				expect(metaRest).toStrictEqual({
					nodeId: "node-1",
					shortId: "node1",
					priority: 5,
					createdAt: new Date(createdAtTimestamp * 1000),
					modifiedAt: new Date(modifiedAtTimestamp * 1000),
					completedAt: null,
					layoutMode: "document",
					systemTo: FAR_FUTURE_DATE,
				});
			});
		});

		describe("empty API response", () => {
			it("handles empty node list", () => {
				const apiNodes: WorkflowyNode[] = [];

				const result = importFromApi(testDatabase.db, apiNodes);

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
		});

		describe("batch processing", () => {
			const NODE_COUNT = 200;

			it("handles large number of nodes", () => {
				const apiNodes: WorkflowyNode[] = [];
				// Spans several of the importer's 90-id lookup and statement chunks.
				for (let i = 0; i < NODE_COUNT; i++) {
					apiNodes.push(createApiNode({id: `node-${i}`, name: `Node ${i}`, priority: i}));
				}

				const result = importFromApi(testDatabase.db, apiNodes);

				expectImportStats(result, {
					totalNodes: NODE_COUNT,
					nodesAdded: NODE_COUNT,
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
				expect(count).toBe(NODE_COUNT);
			});
		});

		describe("special characters", () => {
			it("handles special characters in node names", () => {
				const apiNodes: WorkflowyNode[] = [
					createApiNode({id: "node-1", name: 'Hello <b>World</b> & "Quotes"'}),
					createApiNode({id: "node-2", name: "Unicode: 日本語 🎉 émojis"}),
				];

				const result = importFromApi(testDatabase.db, apiNodes);

				expectImportStats(result, {
					totalNodes: 2,
					nodesAdded: 2,
					nodesUpdated: 0,
					nodesUnchanged: 0,
					nodesDeleted: 0,
					nodesPhasedOut: 0,
					contentUpdated: 0,
					metadataUpdated: 0,
					priorityUpdated: 0,
				});

				const node1 = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;
				expect(node1.name).toBe('Hello <b>World</b> & "Quotes"');

				const node2 = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-2")).get()!;
				expect(node2.name).toBe("Unicode: 日本語 🎉 émojis");
			});
		});

		describe("node deletion detection", () => {
			it("phases out nodes that no longer exist in incoming data", () => {
				const node1 = createApiNode({id: "node-1", name: "Node 1", priority: 0});
				const node2 = createApiNode({id: "node-2", name: "Node 2", priority: 1});
				const node3 = createApiNode({id: "node-3", name: "Node 3", priority: 2});

				const result1 = importFromApi(testDatabase.db, [node1, node2, node3]);
				expect(result1.nodesAdded).toBe(3);

				const result2 = importFromApi(testDatabase.db, [node1, node3]);
				expectImportStats(result2, {
					totalNodes: 2,
					nodesAdded: 0,
					nodesUpdated: 0,
					nodesUnchanged: 2,
					nodesDeleted: 1,
					nodesPhasedOut: 1,
					contentUpdated: 0,
					metadataUpdated: 0,
					priorityUpdated: 0,
				});

				const activeNodes = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
					.all();
				expect(activeNodes.map((n) => n.id).toSorted()).toStrictEqual(["node-1", "node-3"]);

				const node2Active = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "node-2"))
					.all()
					.filter((n) => n.systemTo === FAR_FUTURE_DATE);
				expect(node2Active).toStrictEqual([]);
			});
		});

		describe("mirror rows of deleted nodes", () => {
			// The REST API carries no mirror metadata, so this adapter never writes
			// mirror rows, but a node it phases out takes its mirror relationships
			// with it.
			const T0 = new Date("2024-01-01T00:00:00Z");
			const T1 = new Date("2024-01-01T00:01:00Z");

			function mirrorRows() {
				return testDatabase.db
					.select()
					.from(mirrors)
					.all()
					.map((m) => ({
						originalId: m.originalId,
						mirrorId: m.mirrorId,
						systemFrom: m.systemFrom,
						systemTo: m.systemTo,
					}));
			}

			function seed(): void {
				importFromApi(
					testDatabase.db,
					[
						createApiNode({id: "original", name: "Original"}),
						createApiNode({id: "mirror-a", name: ""}),
						createApiNode({id: "mirror-b", name: ""}),
					],
					false,
					T0,
				);
				testDatabase.db
					.insert(mirrors)
					.values([
						{
							originalId: "original",
							mirrorId: "mirror-a",
							systemFrom: "2024-01-01 00:00:00.000",
							systemTo: FAR_FUTURE_DATE,
						},
						{
							originalId: "original",
							mirrorId: "mirror-b",
							systemFrom: "2024-01-01 00:00:00.000",
							systemTo: FAR_FUTURE_DATE,
						},
					])
					.run();
			}

			it("closes the mirror rows of a deleted original", () => {
				seed();

				importFromApi(
					testDatabase.db,
					[createApiNode({id: "mirror-a", name: ""}), createApiNode({id: "mirror-b", name: ""})],
					false,
					T1,
				);

				expect(mirrorRows()).toStrictEqual([
					{
						originalId: "original",
						mirrorId: "mirror-a",
						systemFrom: "2024-01-01 00:00:00.000",
						systemTo: "2024-01-01 00:01:00.000",
					},
					{
						originalId: "original",
						mirrorId: "mirror-b",
						systemFrom: "2024-01-01 00:00:00.000",
						systemTo: "2024-01-01 00:01:00.000",
					},
				]);
			});

			it("closes only the mirror row of a deleted mirror", () => {
				seed();

				importFromApi(
					testDatabase.db,
					[createApiNode({id: "original", name: "Original"}), createApiNode({id: "mirror-b", name: ""})],
					false,
					T1,
				);

				expect(mirrorRows()).toStrictEqual([
					{
						originalId: "original",
						mirrorId: "mirror-a",
						systemFrom: "2024-01-01 00:00:00.000",
						systemTo: "2024-01-01 00:01:00.000",
					},
					{
						originalId: "original",
						mirrorId: "mirror-b",
						systemFrom: "2024-01-01 00:00:00.000",
						systemTo: FAR_FUTURE_DATE,
					},
				]);
			});
		});

		describe("composites of deleted nodes", () => {
			const T0 = new Date("2024-01-01T00:00:00Z");
			const T1 = new Date("2024-01-01T00:01:00Z");
			const SEEDED = "2024-01-01 00:00:00.000";

			function seed(): void {
				importFromApi(
					testDatabase.db,
					[createApiNode({id: "doomed", name: "Doomed"}), createApiNode({id: "survivor", name: "Survivor"})],
					false,
					T0,
				);
				const temporal = {systemFrom: SEEDED, systemTo: FAR_FUTURE_DATE};
				testDatabase.db
					.insert(mirrors)
					.values({mirrorId: "doomed", originalId: "survivor", ...temporal})
					.run();
				testDatabase.db
					.insert(referencesRoots)
					.values({nodeId: "doomed", ...temporal})
					.run();
				testDatabase.db
					.insert(nodeEmbeddings)
					.values({nodeId: "doomed", model: "minilm", embedding: Buffer.from([1]), ...temporal})
					.run();
			}

			function ownedRows() {
				const {db} = testDatabase;
				return {
					mirrors: db.select({mirrorId: mirrors.mirrorId, systemTo: mirrors.systemTo}).from(mirrors).all(),
					referencesRoots: db
						.select({nodeId: referencesRoots.nodeId, systemTo: referencesRoots.systemTo})
						.from(referencesRoots)
						.all(),
					embeddings: db
						.select({nodeId: nodeEmbeddings.nodeId, systemTo: nodeEmbeddings.systemTo})
						.from(nodeEmbeddings)
						.all(),
					content: db
						.select({id: nodeContent.id, systemTo: nodeContent.systemTo})
						.from(nodeContent)
						.orderBy(nodeContent.id)
						.all(),
				};
			}

			it("ends the owned rows of a node absent from the export at the import time", () => {
				seed();

				importFromApi(testDatabase.db, [createApiNode({id: "survivor", name: "Survivor"})], false, T1);

				const ended = "2024-01-01 00:01:00.000";
				expect(ownedRows()).toStrictEqual({
					mirrors: [{mirrorId: "doomed", systemTo: ended}],
					referencesRoots: [{nodeId: "doomed", systemTo: ended}],
					embeddings: [{nodeId: "doomed", systemTo: ended}],
					content: [
						{id: "doomed", systemTo: ended},
						{id: "survivor", systemTo: FAR_FUTURE_DATE},
					],
				});
			});

			it("rolls back the node rows too when ending an owned row fails", () => {
				seed();
				const before = ownedRows();
				testDatabase.sqlite.exec(
					"CREATE TRIGGER fail_part BEFORE UPDATE ON references_roots BEGIN SELECT RAISE(ABORT, 'part failed'); END",
				);

				expect(() =>
					importFromApi(testDatabase.db, [createApiNode({id: "survivor", name: "Survivor"})], false, T1),
				).toThrow('Failed to run the query \'UPDATE "references_roots"');

				expect(ownedRows()).toStrictEqual(before);
			});
		});

		describe("relationships from /get_tree_data/", () => {
			const T0 = new Date("2024-01-01T00:00:00Z");
			const T1 = new Date("2024-01-01T00:01:00Z");
			const AT_T0 = "2024-01-01 00:00:00.000";
			const AT_T1 = "2024-01-01 00:01:00.000";

			const apiNodes: WorkflowyNode[] = [
				createApiNode({id: "target", name: "Target"}),
				createApiNode({id: "refs", name: "", parent_id: "target"}),
				createApiNode({id: "item", name: "", parent_id: "refs"}),
				createApiNode({id: "source", name: "Links to Target"}),
				createApiNode({id: "original", name: "Original"}),
				createApiNode({id: "mirror", name: ""}),
				// Upstream's "AI Messages" mailbox: the public API omits `data.ai`, so only the tree data marks it.
				createApiNode({id: "mailbox", name: "AI Messages"}),
				createApiNode({id: "not-chat", name: "Not chat"}),
			];

			const treeItems: InternalTreeItem[] = [
				{id: "source", metadata: {mirror: {backlinkMirrorRootIds: {item: true}}}},
				{id: "refs", metadata: {isReferencesRoot: true}},
				{
					id: "item",
					metadata: {
						mirror: {originalId: "source", isMirrorRoot: true},
						backlink: {sourceID: "source", targetID: "target"},
					},
				},
				{id: "original", metadata: {mirror: {mirrorRootIds: {mirror: true}}}},
				{id: "mirror", metadata: {mirror: {originalId: "original", isMirrorRoot: true}}},
				{id: "mailbox", metadata: {ai: {inChat: true}}},
				{id: "not-chat", metadata: {ai: {inChat: false}}},
				// Items the export does not carry get no rows.
				{
					id: "ghost",
					metadata: {
						isReferencesRoot: true,
						ai: {inChat: true},
						backlink: {sourceID: "source", targetID: "target"},
					},
				},
			];

			function relationshipRows() {
				const {db} = testDatabase;
				return {
					mirrors: db
						.select({
							mirrorId: mirrors.mirrorId,
							originalId: mirrors.originalId,
							systemFrom: mirrors.systemFrom,
							systemTo: mirrors.systemTo,
						})
						.from(mirrors)
						.orderBy(mirrors.mirrorId)
						.all(),
					backlinks: currentBacklinkItems(db, undefined),
					referencesRoots: db
						.select({
							nodeId: referencesRoots.nodeId,
							systemFrom: referencesRoots.systemFrom,
							systemTo: referencesRoots.systemTo,
						})
						.from(referencesRoots)
						.all(),
					aiMetadata: db
						.select({
							nodeId: aiMetadata.nodeId,
							inChat: aiMetadata.inChat,
							systemFrom: aiMetadata.systemFrom,
							systemTo: aiMetadata.systemTo,
						})
						.from(aiMetadata)
						.orderBy(aiMetadata.nodeId)
						.all(),
				};
			}

			it("inserts mirrors, references roots and AI chat flags from the tree data, from which backlinks derive", () => {
				importFromApi(testDatabase.db, apiNodes, false, T0, treeItems);

				expect(relationshipRows()).toStrictEqual({
					mirrors: [
						{mirrorId: "item", originalId: "source", systemFrom: AT_T0, systemTo: FAR_FUTURE_DATE},
						{mirrorId: "mirror", originalId: "original", systemFrom: AT_T0, systemTo: FAR_FUTURE_DATE},
					],
					backlinks: [{nodeId: "item", sourceId: "source", targetId: "target"}],
					referencesRoots: [{nodeId: "refs", systemFrom: AT_T0, systemTo: FAR_FUTURE_DATE}],
					aiMetadata: [
						{nodeId: "mailbox", inChat: 1, systemFrom: AT_T0, systemTo: FAR_FUTURE_DATE},
						{nodeId: "not-chat", inChat: 0, systemFrom: AT_T0, systemTo: FAR_FUTURE_DATE},
					],
				});
			});

			it("closes the relationships a later tree data no longer carries", () => {
				importFromApi(testDatabase.db, apiNodes, false, T0, treeItems);

				const laterItems: InternalTreeItem[] = [
					{id: "item", metadata: {mirror: {originalId: "source", isMirrorRoot: true}}},
					{id: "mirror", metadata: {mirror: {originalId: "original", isMirrorRoot: true}}},
				];
				importFromApi(testDatabase.db, apiNodes, false, T1, laterItems);

				expect(relationshipRows()).toStrictEqual({
					mirrors: [
						{mirrorId: "item", originalId: "source", systemFrom: AT_T0, systemTo: FAR_FUTURE_DATE},
						{mirrorId: "mirror", originalId: "original", systemFrom: AT_T0, systemTo: FAR_FUTURE_DATE},
					],
					backlinks: [],
					referencesRoots: [{nodeId: "refs", systemFrom: AT_T0, systemTo: AT_T1}],
					aiMetadata: [
						{nodeId: "mailbox", inChat: 1, systemFrom: AT_T0, systemTo: AT_T1},
						{nodeId: "not-chat", inChat: 0, systemFrom: AT_T0, systemTo: AT_T1},
					],
				});
			});

			it("ends a backlink item whose source is gone, leaving no stranded rows", () => {
				importFromApi(testDatabase.db, apiNodes, false, T0, treeItems);

				const withoutSource = apiNodes.filter((node) => node.id !== "source");
				const strandedItems = treeItems.filter((item) => item.id !== "source");
				importFromApi(testDatabase.db, withoutSource, false, T1, strandedItems);

				expect({
					item: testDatabase.db
						.select({id: nodeContent.id, systemTo: nodeContent.systemTo})
						.from(nodeContent)
						.where(eq(nodeContent.id, "item"))
						.all(),
					stranded: countStrandedRows(testDatabase.db),
				}).toStrictEqual({
					item: [{id: "item", systemTo: AT_T1}],
					stranded: {backlinkItems: 0, mirrors: 0, referencesRoots: 0},
				});
			});

			it("leaves the relationship rows untouched without tree data", () => {
				importFromApi(testDatabase.db, apiNodes, false, T0, treeItems);
				const before = relationshipRows();

				importFromApi(testDatabase.db, apiNodes, false, T1);

				expect(relationshipRows()).toStrictEqual(before);
			});
		});

		describe("node update detection", () => {
			it("creates new version when node content changes", () => {
				const firstImport: WorkflowyNode[] = [
					createApiNode({id: "node-1", name: "Original Name", priority: 0}),
				];

				importFromApi(testDatabase.db, firstImport);

				const secondImport: WorkflowyNode[] = [
					createApiNode({id: "node-1", name: "Updated Name", priority: 0}),
				];

				const result = importFromApi(testDatabase.db, secondImport);
				expect(result.nodesUpdated).toBe(1);
				expect(result.nodesUnchanged).toBe(0);

				const allNode1Records = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "node-1"))
					.all();
				expect(
					allNode1Records.map((n) => ({name: n.name, active: n.systemTo === FAR_FUTURE_DATE})),
				).toStrictEqual([
					{name: "Original Name", active: false},
					{name: "Updated Name", active: true},
				]);
			});
		});

		describe("system time", () => {
			afterEach(() => {
				vi.useRealTimers();
			});

			it("fails the later of two imports within one millisecond and keeps the earlier's version", () => {
				vi.useFakeTimers({toFake: ["Date"], now: new Date("2026-02-01T00:00:00.000Z")});

				importFromApi(testDatabase.db, [createApiNode({id: "node-1", name: "Original Name", priority: 0})]);

				expect(() =>
					importFromApi(testDatabase.db, [createApiNode({id: "node-1", name: "Updated Name", priority: 0})]),
				).toThrow(
					new SameMillisecondOverwriteError(
						"api_import_timestamp",
						"name=bulk_import",
						"2026-02-01 00:00:00.000",
					),
				);
				expect(
					testDatabase.db
						.select({
							name: nodeContent.name,
							systemFrom: nodeContent.systemFrom,
							systemTo: nodeContent.systemTo,
						})
						.from(nodeContent)
						.all(),
				).toStrictEqual([
					{name: "Original Name", systemFrom: "2026-02-01 00:00:00.000", systemTo: FAR_FUTURE_DATE},
				]);
			});
		});

		describe("per-node REST adapter writes unconditionally", () => {
			const DATE_EARLIER = new Date("2026-04-01T00:00:00Z");
			const DATE_LATER = new Date("2026-04-10T00:00:00Z");
			const T_EARLIER = Math.floor(DATE_EARLIER.getTime() / 1000);
			const T_LATER = Math.floor(DATE_LATER.getTime() / 1000);
			const DATE_REIMPORT = new Date("2026-04-11T00:00:00Z");

			it("imports even when incoming timestamps predate the local cache", () => {
				// Seed the cache with a write timestamped at T_LATER.
				const seedNodes: WorkflowyNode[] = [
					createApiNode({id: "node-1", name: "Seed", createdAt: T_LATER, modifiedAt: T_LATER}),
				];
				importFromApi(testDatabase.db, seedNodes, false, DATE_LATER);

				// A per-node REST response is authoritative regardless of relative
				// timestamps: the watermark guard belongs to the bulk-export path only.
				const staleNodes: WorkflowyNode[] = [
					createApiNode({id: "node-2", name: "Stale", createdAt: T_EARLIER, modifiedAt: T_EARLIER}),
				];
				const result = importFromApi(testDatabase.db, staleNodes, false, DATE_REIMPORT);

				expect(result.nodesAdded).toBe(1);
				const node2 = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-2")).get()!;
				expectActiveRecord(node2);
			});

			it("leaves a node the cache wrote after the snapshot was taken live", () => {
				importFromApi(testDatabase.db, [createApiNode({id: "node-1", name: "Seed"})], false, DATE_LATER);

				const result = importFromApi(
					testDatabase.db,
					[createApiNode({id: "node-2", name: "From the snapshot"})],
					false,
					DATE_REIMPORT,
					undefined,
					DATE_EARLIER,
				);

				const live = testDatabase.db
					.select({id: nodeContent.id})
					.from(nodeContent)
					.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
					.all()
					.map((row) => row.id)
					.toSorted();
				expect({live, nodesDeleted: result.nodesDeleted}).toStrictEqual({
					live: ["node-1", "node-2"],
					nodesDeleted: 0,
				});
			});
		});
	});
});

describe("cache import", () => {
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

			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-import-test-"));
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

				const content = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "full-node"))
					.get()!;
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
				const secondNode = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "node-1"))
					.get()!;

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

				const childContent = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "child-1"))
					.get()!;
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

				const allMirrors = testDatabase.db
					.select()
					.from(mirrors)
					.where(eq(mirrors.mirrorId, "mirror-node"))
					.all();
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
				const inverted = testDatabase.db
					.select()
					.from(mirrors)
					.where(eq(mirrors.mirrorId, "original-node"))
					.all();
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
					.map((m) => ({
						originalId: m.originalId,
						mirrorId: m.mirrorId,
						active: m.systemTo === FAR_FUTURE_DATE,
					}));
			}

			it("skips a mirror whose original is absent from the backup", async () => {
				const filePath = writeBackupFile([
					{
						id: "mirror-node",
						nm: "",
						metadata: {mirror: {originalId: "deleted-original", isMirrorRoot: true}},
					},
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
						.select({
							id: nodeContent.id,
							systemFrom: nodeContent.systemFrom,
							systemTo: nodeContent.systemTo,
						})
						.from(nodeContent)
						.where(eq(nodeContent.id, "bn"))
						.all(),
				).toStrictEqual([]);
			});
		});

		describe("units of work", () => {
			it("rolls back the whole import when merging a relationship table fails", async () => {
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

				// The rename and the deletion of "gone" rolled back with the mirror.
				expect(currentContent()).toStrictEqual([
					{id: "doomed", name: "Doomed"},
					{id: "gone", name: "Gone"},
					{id: "kept", name: "Kept"},
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
				expect({name: error.name, activeIds}).toStrictEqual({
					name: "ZodError",
					activeIds: ["node-1", "node-2"],
				});
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
			const NODE_COUNT = 200;

			it("handles large number of nodes", async () => {
				// Spans several of the importer's 90-parameter statements; the transaction timeout test below crosses a unit chunk.
				const backupContent: {id: string; nm: string}[] = [];
				for (let i = 0; i < NODE_COUNT; i++) {
					backupContent.push({id: `node-${i}`, nm: `Node ${i}`});
				}
				const filePath = writeBackupFile(backupContent);

				const result = await importBackup(testDatabase.db, filePath, "backup.json");

				expectImportStats(result, {
					totalNodes: NODE_COUNT,
					nodesAdded: NODE_COUNT,
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
				expect(count).toBe(NODE_COUNT);
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

				const meta1 = testDatabase.db
					.select()
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "child-1"))
					.get()!;
				const meta2 = testDatabase.db
					.select()
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "child-2"))
					.get()!;
				const meta3 = testDatabase.db
					.select()
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "child-3"))
					.get()!;

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

			/** Every node_content insert moves the clock `tick` ms, so a merge's length grows with its node count. */
			function advanceClockOnInsert(tick: number): void {
				testDatabase.sqlite.function("advance_clock", () => {
					vi.setSystemTime(Date.now() + tick);
					return 0;
				});
				testDatabase.sqlite.exec(
					"CREATE TEMP TRIGGER advance_clock_on_insert AFTER INSERT ON node_content BEGIN SELECT advance_clock(); END",
				);
			}

			function stampsAndLeases() {
				return {
					stamps: testDatabase.sqlite
						.prepare(
							"SELECT system_from AS systemFrom, count(*) AS rows FROM node_content WHERE system_to = ? GROUP BY system_from ORDER BY system_from",
						)
						.all(FAR_FUTURE_DATE),
					openLeases: testDatabase.sqlite
						.prepare("SELECT count(*) AS open FROM api_import_timestamp WHERE name = ? AND system_to = ?")
						.get(BULK_IMPORT_LEASE_NAME, FAR_FUTURE_DATE),
				};
			}

			it("commits a backup whose merge outlasts the transaction timeout under one system time", async () => {
				vi.useFakeTimers({toFake: ["Date"], now: T0});
				const nodeCount = 200;
				advanceClockOnInsert(Math.ceil(TRANSACTION_TIMEOUT_MS / 100));
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
				expect(stampsAndLeases()).toStrictEqual({
					stamps: [{systemFrom: "2024-01-01 00:00:00.000", rows: nodeCount}],
					openLeases: {open: 0},
				});
				expect(result.importTimestamp).toStrictEqual(T0);
			});

			it("commits nothing when a backup's merge outlasts the bulk import timeout", async () => {
				vi.useFakeTimers({toFake: ["Date"], now: T0});
				const nodeCount = 101;
				advanceClockOnInsert(BULK_IMPORT_TIMEOUT_MS / 100);
				const filePath = writeBackupFile(
					Array.from({length: nodeCount}, (_, index) => ({id: `node-${index}`, nm: `Node ${index}`})),
				);

				await expect(importBackup(testDatabase.db, filePath, "backup.json")).rejects.toThrow(
					new TransactionTimeoutError(
						"2024-01-01 00:00:00.000",
						nodeCount * (BULK_IMPORT_TIMEOUT_MS / 100),
						BULK_IMPORT_TIMEOUT_MS,
					),
				);

				expect(stampsAndLeases()).toStrictEqual({stamps: [], openLeases: {open: 0}});
			});
		});
	});
});

describe("cache service", () => {
	const FIXED_DATE = new Date("2026-01-01T12:00:00.000Z");
	const FIXED_SYSTEM_FROM = formatTemporalTimestamp(FIXED_DATE);
	const FIXED_EPOCH_SECONDS = Math.floor(FIXED_DATE.getTime() / 1000);

	describe("CacheService (shared)", () => {
		let tempDir: string;
		let testDatabase: TestDatabase;
		let cacheService: CacheService;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-cache-test-"));
			const testDbPath = path.join(tempDir, "test.sqlite");
			testDatabase = createTestDatabase(testDbPath);
			cacheService = new CacheService(testDatabase.db);
		});

		afterEach(() => {
			cleanupTestDatabase(testDatabase);
			if (fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, {recursive: true, force: true});
			}
		});

		describe("getNode", () => {
			it("returns node by ID", () => {
				seedTestData(testDatabase, nodeFixtures([createTestNode({id: "node-1", name: "Test Node"})]));

				const node = cacheService.getNode("node-1");

				expect({id: node?.id, name: node?.name}).toStrictEqual({id: "node-1", name: "Test Node"});
			});

			it("returns undefined for non-existent node", () => {
				const node = cacheService.getNode("non-existent");
				expect(node).toBeUndefined();
			});

			it("only returns active records (systemTo = FAR_FUTURE_DATE)", () => {
				const now = formatTemporalTimestamp(new Date());
				const earlier = formatTemporalTimestamp(new Date(Date.now() - 1000));
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "node-1", name: "Historical", systemFrom: earlier, systemTo: now}),
						createTestNode({id: "node-1", name: "Current", systemFrom: now, systemTo: FAR_FUTURE_DATE}),
					]),
				);

				const node = cacheService.getNode("node-1");

				expect(node?.name).toBe("Current");
			});
		});

		describe("getChildren", () => {
			it("returns children of a parent node", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "child-1", name: "Child 1", parentId: "parent", priority: 0}),
						createTestNode({id: "child-2", name: "Child 2", parentId: "parent", priority: 1}),
					]),
				);

				const children = cacheService.getChildren("parent");

				expect(children.map((c) => c.name)).toStrictEqual(["Child 1", "Child 2"]);
			});

			it("returns root nodes when parentId is null", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "root-1", name: "Root 1", parentId: null, priority: 0}),
						createTestNode({id: "root-2", name: "Root 2", parentId: null, priority: 1}),
						createTestNode({id: "child", name: "Child", parentId: "root-1"}),
					]),
				);

				const roots = cacheService.getChildren(null);

				expect(roots.map((r) => r.name)).toStrictEqual(["Root 1", "Root 2"]);
			});

			it("orders children by priority then createdAt", () => {
				const now = new Date();
				const nowPlusOne = new Date(now.getTime() + 1000);
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "c", name: "C", parentId: "parent", priority: 1, createdAt: now}),
						createTestNode({id: "a", name: "A", parentId: "parent", priority: 0, createdAt: nowPlusOne}),
						createTestNode({id: "b", name: "B", parentId: "parent", priority: 0, createdAt: now}),
					]),
				);

				const children = cacheService.getChildren("parent");

				expect(children.map((c) => c.name)).toStrictEqual(["B", "A", "C"]);
			});

			it("returns empty array for node with no children", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([createTestNode({id: "parent", name: "Parent", parentId: null})]),
				);

				const children = cacheService.getChildren("parent");

				expect(children).toStrictEqual([]);
			});

			it("excludes historical records", () => {
				const now = formatTemporalTimestamp(new Date());
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "child-1", name: "Active", parentId: "parent", systemTo: FAR_FUTURE_DATE}),
						createTestNode({id: "child-2", name: "Historical", parentId: "parent", systemTo: now}),
					]),
				);

				const children = cacheService.getChildren("parent");

				expect(children.map((child) => child.name)).toStrictEqual(["Active"]);
			});
		});

		describe("getChildByName", () => {
			it("finds child by exact name", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({
							id: "child",
							name: "Target",
							parentId: "parent",
							createdAt: FIXED_DATE,
							modifiedAt: FIXED_DATE,
							systemFrom: FIXED_SYSTEM_FROM,
						}),
					]),
				);

				const child = cacheService.getChildByName("parent", "Target");

				expect(child).toStrictEqual({
					id: "child",
					shortId: "child",
					parentId: "parent",
					name: "Target",
					note: null,
					priority: 0,
					layoutMode: "bullets",
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemFrom: FIXED_SYSTEM_FROM,
					systemTo: FAR_FUTURE_DATE,
				});
			});

			it("returns null when name not found", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "child", name: "Other", parentId: "parent"}),
					]),
				);

				const child = cacheService.getChildByName("parent", "Target");

				expect(child).toBeNull();
			});

			it("finds root node by name when parentId is null", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({
							id: "root",
							name: "Root Node",
							parentId: null,
							createdAt: FIXED_DATE,
							modifiedAt: FIXED_DATE,
							systemFrom: FIXED_SYSTEM_FROM,
						}),
					]),
				);

				const root = cacheService.getChildByName(null, "Root Node");

				expect(root).toStrictEqual({
					id: "root",
					shortId: "root",
					parentId: null,
					name: "Root Node",
					note: null,
					priority: 0,
					layoutMode: "bullets",
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemFrom: FIXED_SYSTEM_FROM,
					systemTo: FAR_FUTURE_DATE,
				});
			});

			it("matches a plain segment against an HTML-formatted (colored) name", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({
							id: "personal",
							name: '<span class="colored c-blue">Personal</span>',
							parentId: null,
							createdAt: FIXED_DATE,
							modifiedAt: FIXED_DATE,
							systemFrom: FIXED_SYSTEM_FROM,
						}),
					]),
				);

				const child = cacheService.getChildByName(null, "Personal");

				expect(child).toStrictEqual({
					id: "personal",
					shortId: "personal",
					parentId: null,
					name: '<span class="colored c-blue">Personal</span>',
					note: null,
					priority: 0,
					layoutMode: "bullets",
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemFrom: FIXED_SYSTEM_FROM,
					systemTo: FAR_FUTURE_DATE,
				});
			});
		});

		describe("getNodeWithMergedData", () => {
			it("returns node with cache source", () => {
				seedTestData(testDatabase, nodeFixtures([createTestNode({id: "node-1", name: "Test"})]));

				const result = cacheService.getNodeWithMergedData("node-1");

				expect({nodeName: result.node?.name, source: result.source}).toStrictEqual({
					nodeName: "Test",
					source: "cache",
				});
				expect(result.fetchedAt).toBeInstanceOf(Date);
			});

			it("returns none source for missing node", () => {
				const result = cacheService.getNodeWithMergedData("missing");

				expect(result).toStrictEqual({node: undefined, source: "none"});
			});
		});

		describe("findNodeByPath", () => {
			it("finds node at simple path", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({
							id: "root",
							name: "Root",
							parentId: null,
							createdAt: FIXED_DATE,
							modifiedAt: FIXED_DATE,
							systemFrom: FIXED_SYSTEM_FROM,
						}),
					]),
				);

				const node = cacheService.findNodeByPath(["Root"]);

				expect(node).toStrictEqual({
					id: "root",
					shortId: "root",
					parentId: null,
					name: "Root",
					note: null,
					priority: 0,
					layoutMode: "bullets",
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemFrom: FIXED_SYSTEM_FROM,
					systemTo: FAR_FUTURE_DATE,
				});
			});

			it("finds node at nested path", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "l1", name: "Level1", parentId: null}),
						createTestNode({id: "l2", name: "Level2", parentId: "l1"}),
						createTestNode({
							id: "l3",
							name: "Level3",
							parentId: "l2",
							createdAt: FIXED_DATE,
							modifiedAt: FIXED_DATE,
							systemFrom: FIXED_SYSTEM_FROM,
						}),
					]),
				);

				const node = cacheService.findNodeByPath(["Level1", "Level2", "Level3"]);

				expect(node).toStrictEqual({
					id: "l3",
					shortId: "l3",
					parentId: "l2",
					name: "Level3",
					note: null,
					priority: 0,
					layoutMode: "bullets",
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemFrom: FIXED_SYSTEM_FROM,
					systemTo: FAR_FUTURE_DATE,
				});
			});

			it("returns null for non-existent path", () => {
				seedTestData(testDatabase, nodeFixtures([createTestNode({id: "root", name: "Root", parentId: null})]));

				const node = cacheService.findNodeByPath(["Root", "Missing"]);

				expect(node).toBeNull();
			});

			it("returns null for empty path", () => {
				const node = cacheService.findNodeByPath([]);
				expect(node).toBeNull();
			});

			it("returns root node for empty path with rootId", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({
							id: "root",
							name: "Root",
							parentId: null,
							createdAt: FIXED_DATE,
							modifiedAt: FIXED_DATE,
							systemFrom: FIXED_SYSTEM_FROM,
						}),
					]),
				);

				const node = cacheService.findNodeByPath([], "root");

				expect(node).toStrictEqual({
					id: "root",
					shortId: "root",
					parentId: null,
					name: "Root",
					note: null,
					priority: 0,
					layoutMode: "bullets",
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemFrom: FIXED_SYSTEM_FROM,
					systemTo: FAR_FUTURE_DATE,
				});
			});

			it("resolves a path through an HTML-formatted (colored) ancestor", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({
							id: "personal",
							name: '<span class="colored c-blue">Personal</span>',
							parentId: null,
						}),
						createTestNode({
							id: "review",
							name: "🔄 Review",
							parentId: "personal",
							createdAt: FIXED_DATE,
							modifiedAt: FIXED_DATE,
							systemFrom: FIXED_SYSTEM_FROM,
						}),
					]),
				);

				const node = cacheService.findNodeByPath(["Personal", "🔄 Review"]);

				expect(node).toStrictEqual({
					id: "review",
					shortId: "review",
					parentId: "personal",
					name: "🔄 Review",
					note: null,
					priority: 0,
					layoutMode: "bullets",
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					collapsed: false,
					mirror: {isMirror: false, originalNodeId: null},
					systemFrom: FIXED_SYSTEM_FROM,
					systemTo: FAR_FUTURE_DATE,
				});
			});

			it("matches exactly, never on a substring", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([createTestNode({id: "archive", name: "Review Archive", parentId: null})]),
				);

				// 'Review' is a substring of 'Review Archive' but must not match: this API is exact-only.
				const node = cacheService.findNodeByPath(["Review"]);

				expect(node).toBeNull();
			});
		});

		describe("storeApiResponse", () => {
			it("refuses a system target as the parent, instead of inventing a blank Home node for it", () => {
				expect({
					thrown: (() => {
						try {
							cacheService.storeApiResponse([], "inbox");
							return null;
						} catch (error) {
							return String(error);
						}
					})(),
					rows: testDatabase.db.select({id: nodeContent.id}).from(nodeContent).all(),
				}).toStrictEqual({
					thrown: 'Error: Cannot cache children under system target "inbox"; resolve it to a node id first',
					rows: [],
				});
			});

			it("preserves mirror rows on sync (#1712)", () => {
				const from = formatTemporalTimestamp(new Date(Date.now() - 1000));
				seedTestData(testDatabase, {
					...nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "child", name: "Child", parentId: "parent"}),
						createTestNode({id: "orig", name: "Original", parentId: "elsewhere"}),
					]),
					mirrors: [{originalId: "orig", mirrorId: "child", systemFrom: from, systemTo: FAR_FUTURE_DATE}],
				});

				// Sync the child back under its parent (a routine cache refresh).
				cacheService.storeApiResponse(
					[createApiNode({id: "child", name: "Child", parent_id: "parent"})],
					"parent",
				);

				// These records come only from backup imports; the sync must leave them open.
				expect(
					testDatabase.db.select().from(mirrors).where(eq(mirrors.mirrorId, "child")).get()!.systemTo,
				).toBe(FAR_FUTURE_DATE);
			});

			it("leaves the attribute rows the public API does not carry current", () => {
				const from = formatTemporalTimestamp(new Date(Date.now() - 1000));
				const temporal = {systemFrom: from, systemTo: FAR_FUTURE_DATE};
				seedTestData(testDatabase, {
					...nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "refs", name: "", parentId: "parent"}),
					]),
					aiMetadata: [{nodeId: "refs", inChat: 1, ...temporal}],
					s3Files: [{nodeId: "refs", fileName: "f", fileType: "image/png", ...temporal}],
					changesMetadata: [{nodeId: "refs", ctBy: 1, ...temporal}],
					referencesRoots: [{nodeId: "refs", ...temporal}],
				});

				cacheService.storeApiResponse([createApiNode({id: "refs", name: "", parent_id: "parent"})], "parent");

				const {db} = testDatabase;
				expect({
					aiMetadata: db
						.select({nodeId: aiMetadata.nodeId, systemTo: aiMetadata.systemTo})
						.from(aiMetadata)
						.all(),
					s3Files: db.select({nodeId: s3Files.nodeId, systemTo: s3Files.systemTo}).from(s3Files).all(),
					changesMetadata: db
						.select({nodeId: changesMetadata.nodeId, systemTo: changesMetadata.systemTo})
						.from(changesMetadata)
						.all(),
					referencesRoots: db
						.select({nodeId: referencesRoots.nodeId, systemTo: referencesRoots.systemTo})
						.from(referencesRoots)
						.all(),
				}).toStrictEqual({
					aiMetadata: [{nodeId: "refs", systemTo: FAR_FUTURE_DATE}],
					s3Files: [{nodeId: "refs", systemTo: FAR_FUTURE_DATE}],
					changesMetadata: [{nodeId: "refs", systemTo: FAR_FUTURE_DATE}],
					referencesRoots: [{nodeId: "refs", systemTo: FAR_FUTURE_DATE}],
				});
			});

			it("scopes the sibling metadata phase-out to the synced parent", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parentA", name: "A", parentId: null}),
						createTestNode({id: "childA", name: "Child A", parentId: "parentA"}),
						createTestNode({id: "parentB", name: "B", parentId: null}),
						createTestNode({id: "childB", name: "Child B", parentId: "parentB"}),
					]),
				);

				// Sync parentA's children (only childA). Nodes under parentB must be untouched.
				cacheService.storeApiResponse(
					[createApiNode({id: "childA", name: "Child A", parent_id: "parentA"})],
					"parentA",
				);

				const childBMeta = testDatabase.db
					.select()
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "childB"))
					.get()!;
				expect(childBMeta.systemTo).toBe(FAR_FUTURE_DATE);
			});

			it("inserts new nodes", () => {
				const apiNodes = [
					createApiNode({id: "node-1", name: "Node 1", parent_id: null, priority: 0}),
					createApiNode({id: "node-2", name: "Node 2", parent_id: null, priority: 1}),
				];

				cacheService.storeApiResponse(apiNodes, null);

				const stored = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
					.all();
				expect(stored.map((s) => s.id).toSorted()).toStrictEqual(["node-1", "node-2"]);
			});

			it("updates changed nodes with temporal versioning", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([createTestNode({id: "node-1", name: "Old Name", parentId: null})]),
				);

				const apiNodes = [createApiNode({id: "node-1", name: "New Name", parent_id: null})];

				cacheService.storeApiResponse(apiNodes, null);

				const allRecords = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).all();
				expect({
					activeNames: allRecords
						.filter((record) => record.systemTo === FAR_FUTURE_DATE)
						.map((record) => record.name),
					historicalNames: allRecords
						.filter((record) => record.systemTo !== FAR_FUTURE_DATE)
						.map((record) => record.name),
				}).toStrictEqual({activeNames: ["New Name"], historicalNames: ["Old Name"]});
			});

			it("phases out cached children not in API response", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "child-1", name: "Keep", parentId: "parent"}),
						createTestNode({id: "child-2", name: "Delete", parentId: "parent"}),
					]),
				);

				const apiNodes = [createApiNode({id: "child-1", name: "Keep", parent_id: "parent"})];

				cacheService.storeApiResponse(apiNodes, "parent");

				const child2Content = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "child-2"))
					.get()!;
				const child2 = createNodeFromContent(child2Content);
				expectPhasedOut(child2);
			});

			it("creates placeholder parent if not exists", () => {
				const apiNodes = [createApiNode({id: "child", name: "Child", parent_id: "parent"})];

				cacheService.storeApiResponse(apiNodes, "parent");

				const parent = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "parent")).get()!;
				expect(createNodeFromContent(parent)).toStrictEqual(
					createNodeFromContent({
						id: "parent",
						name: null,
						note: null,
						parentId: null,
						systemFrom: parent.systemFrom,
						systemTo: FAR_FUTURE_DATE,
					}),
				);
			});

			it("does not affect unchanged nodes", () => {
				const now = new Date();
				const nowSeconds = Math.floor(now.getTime() / 1000);
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({
							id: "node-1",
							name: "Same",
							note: null,
							parentId: null,
							priority: 0,
							createdAt: now,
							modifiedAt: now,
							completedAt: null,
							layoutMode: null,
						}),
					]),
				);

				const initialRecord = testDatabase.db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "node-1"))
					.get()!;

				const apiNodes = [
					createApiNode({
						id: "node-1",
						name: "Same",
						note: null,
						parent_id: null,
						priority: 0,
						createdAt: nowSeconds,
						modifiedAt: nowSeconds,
						completedAt: null,
						data: {layoutMode: "bullets"},
					}),
				];

				cacheService.storeApiResponse(apiNodes, null);

				const allRecords = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).all();
				expect(allRecords.map((record) => record.systemFrom)).toStrictEqual([initialRecord.systemFrom]);
			});
		});

		describe("insertNode", () => {
			it("inserts new node", () => {
				const apiNode = createApiNode({id: "new-node", name: "New Node", parent_id: null});

				cacheService.insertNode(apiNode, null);

				const stored = cacheService.getNode("new-node");
				expect(stored?.name).toBe("New Node");
			});

			it("does not phase out siblings", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "sibling", name: "Sibling", parentId: "parent"}),
					]),
				);

				const apiNode = createApiNode({id: "new-node", name: "New Node", parent_id: "parent"});

				cacheService.insertNode(apiNode, "parent");

				const sibling = cacheService.getNode("sibling");
				expect(sibling?.systemTo).toBe(FAR_FUTURE_DATE);
			});

			it("updates existing node with temporal versioning", () => {
				seedTestData(testDatabase, nodeFixtures([createTestNode({id: "node-1", name: "Old", parentId: null})]));

				const apiNode = createApiNode({id: "node-1", name: "Updated", parent_id: null});

				cacheService.insertNode(apiNode, null);

				const allRecords = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).all();
				expect({
					activeNames: allRecords
						.filter((record) => record.systemTo === FAR_FUTURE_DATE)
						.map((record) => record.name),
					historicalNames: allRecords
						.filter((record) => record.systemTo !== FAR_FUTURE_DATE)
						.map((record) => record.name),
				}).toStrictEqual({activeNames: ["Updated"], historicalNames: ["Old"]});
			});

			it("inserts a missing metadata row for a node whose content is cached", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([createTestNode({id: "node-1", name: "Same", parentId: null})]),
				);
				testDatabase.db.delete(nodeMetadata).where(eq(nodeMetadata.nodeId, "node-1")).run();

				const apiNode = createApiNode({
					id: "node-1",
					name: "Same",
					parent_id: null,
					priority: 5,
					createdAt: FIXED_EPOCH_SECONDS,
					modifiedAt: FIXED_EPOCH_SECONDS,
				});

				cacheService.insertNode(apiNode, null);

				const metadataRows = testDatabase.db
					.select()
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "node-1"))
					.all();
				expect(metadataRows).toStrictEqual([
					{
						nodeId: "node-1",
						shortId: "node1",
						priority: 5,
						createdAt: FIXED_DATE,
						modifiedAt: FIXED_DATE,
						completedAt: null,
						layoutMode: null,
						systemFrom: metadataRows[0]?.systemFrom,
						systemTo: FAR_FUTURE_DATE,
					},
				]);
			});

			it("normalizes layoutMode on a brand-new insert", () => {
				// 'bullets' is the default layout and normalizes to null (see normalizeLayoutMode).
				const apiNode = createApiNode({
					id: "new-node",
					name: "New Node",
					parent_id: null,
					createdAt: FIXED_EPOCH_SECONDS,
					modifiedAt: FIXED_EPOCH_SECONDS,
				});

				cacheService.insertNode(apiNode, null);

				const meta = testDatabase.db
					.select()
					.from(nodeMetadata)
					.where(eq(nodeMetadata.nodeId, "new-node"))
					.get()!;
				expect(meta).toStrictEqual({
					nodeId: "new-node",
					shortId: "newnode",
					priority: 0,
					createdAt: FIXED_DATE,
					modifiedAt: FIXED_DATE,
					completedAt: null,
					layoutMode: null,
					systemFrom: meta.systemFrom,
					systemTo: FAR_FUTURE_DATE,
				});
			});
		});

		describe("deleteNode", () => {
			it("phases out node and descendants", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "child", name: "Child", parentId: "parent"}),
						createTestNode({id: "grandchild", name: "Grandchild", parentId: "child"}),
					]),
				);

				cacheService.deleteNode("parent");

				for (const id of ["parent", "child", "grandchild"]) {
					const content = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, id)).get()!;
					expectPhasedOut(createNodeFromContent(content));
				}
			});

			it("does not affect siblings", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "root", name: "Root", parentId: null}),
						createTestNode({id: "node-1", name: "Node 1", parentId: "root"}),
						createTestNode({id: "node-2", name: "Node 2", parentId: "root"}),
					]),
				);

				cacheService.deleteNode("node-1");

				const node2 = cacheService.getNode("node-2");
				expect(node2?.systemTo).toBe(FAR_FUTURE_DATE);
			});

			it("closes mirror rows on both sides of a genuine deletion", () => {
				const from = formatTemporalTimestamp(new Date(Date.now() - 1000));
				seedTestData(testDatabase, {
					...nodeFixtures([
						createTestNode({id: "copy", name: "", parentId: null}),
						createTestNode({id: "orig", name: "Original", parentId: "elsewhere"}),
						createTestNode({id: "copy2", name: "", parentId: null}),
						createTestNode({id: "orig2", name: "Original 2", parentId: "elsewhere"}),
					]),
					mirrors: [
						// Deleting the copy must close the row via mirrorId.
						{originalId: "orig", mirrorId: "copy", systemFrom: from, systemTo: FAR_FUTURE_DATE},
						// Deleting the original must close the row via originalId.
						{originalId: "orig2", mirrorId: "copy2", systemFrom: from, systemTo: FAR_FUTURE_DATE},
					],
				});

				cacheService.deleteNode("copy");
				cacheService.deleteNode("orig2");

				const byCopy = testDatabase.db.select().from(mirrors).where(eq(mirrors.mirrorId, "copy")).get()!;
				expect(byCopy.systemTo).not.toBe(FAR_FUTURE_DATE);
				const byOriginal = testDatabase.db.select().from(mirrors).where(eq(mirrors.originalId, "orig2")).get()!;
				expect(byOriginal.systemTo).not.toBe(FAR_FUTURE_DATE);
			});

			it("ends every owned part of the deleted subtree at the content's system time", () => {
				const from = formatTemporalTimestamp(new Date(Date.now() - 1000));
				const temporal = {systemFrom: from, systemTo: FAR_FUTURE_DATE};
				seedTestData(testDatabase, {
					...nodeFixtures([
						createTestNode({id: "parent", name: "Parent", parentId: null}),
						createTestNode({id: "child", name: "Child", parentId: "parent"}),
					]),
					aiMetadata: [{nodeId: "child", inChat: 1, ...temporal}],
					s3Files: [{nodeId: "child", fileName: "f", fileType: "image/png", ...temporal}],
					changesMetadata: [{nodeId: "child", ctBy: 1, ...temporal}],
					referencesRoots: [{nodeId: "parent", ...temporal}],
				});
				const {db} = testDatabase;
				db.insert(nodeEmbeddings)
					.values({nodeId: "child", model: "minilm", embedding: Buffer.from([1]), ...temporal})
					.run();
				db.insert(calendarMetadata)
					.values({
						nodeId: "child",
						root: null,
						level: null,
						value: null,
						dateId: null,
						timestamp: null,
						foundDates: null,
						...temporal,
					})
					.run();
				db.insert(calendarLevels)
					.values({nodeId: "child", day: 1, week: null, month: null, year: null, ...temporal})
					.run();
				db.insert(nodeDisplayMetadata)
					.values({nodeId: "child", numberedStart: 3, ...temporal})
					.run();

				cacheService.deleteNode("parent");

				const systemTos = [
					nodeContent,
					nodeMetadata,
					nodeEmbeddings,
					calendarMetadata,
					calendarLevels,
					nodeDisplayMetadata,
					aiMetadata,
					s3Files,
					changesMetadata,
					referencesRoots,
				].flatMap((table) => db.selectDistinct({systemTo: table.systemTo}).from(table).all());
				const contentSystemTo = db
					.select()
					.from(nodeContent)
					.where(eq(nodeContent.id, "parent"))
					.get()!.systemTo;
				expect({
					systemTos: [...new Set(systemTos.map((row) => row.systemTo))],
				}).toStrictEqual({systemTos: [contentSystemTo]});
				expect(contentSystemTo).not.toBe(FAR_FUTURE_DATE);
			});
		});

		describe("getChildrenWithMergedData", () => {
			it("returns cache nodes with relations", () => {
				const now = new Date();
				const parentNode = createTestNode({id: "parent", name: "Parent", parentId: null});
				const childNode = createTestNode({
					id: "child",
					name: "Child",
					note: "A note",
					parentId: "parent",
					priority: 0,
					createdAt: now,
					modifiedAt: now,
					layoutMode: "document",
				});

				const {content: parentContent, metadata: parentMetadata} = splitNodeIntoContentAndMetadata(parentNode);
				const {content: childContent, metadata: childMetadata} = splitNodeIntoContentAndMetadata(childNode);

				seedTestData(testDatabase, {
					nodeContent: [parentContent, childContent],
					nodeMetadata: [parentMetadata, childMetadata],
				});

				const result = cacheService.getChildrenWithMergedData("parent");

				expect(result.map(({id, name, note, layoutMode}) => ({id, name, note, layoutMode}))).toStrictEqual([
					{id: "child", name: "Child", note: "A note", layoutMode: "document"},
				]);
			});

			it("returns empty array for no children", () => {
				const parentNode = createTestNode({id: "parent", name: "Parent", parentId: null});
				const {content: parentContent, metadata: parentMetadata} = splitNodeIntoContentAndMetadata(parentNode);

				seedTestData(testDatabase, {
					nodeContent: [parentContent],
					nodeMetadata: [parentMetadata],
				});

				const result = cacheService.getChildrenWithMergedData("parent");

				expect(result).toStrictEqual([]);
			});
		});

		describe("getChildrenForMultipleParents", () => {
			it("returns children grouped by parent", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: "parent-1", name: "Parent 1", parentId: null}),
						createTestNode({id: "parent-2", name: "Parent 2", parentId: null}),
						createTestNode({id: "child-1a", name: "Child 1A", parentId: "parent-1"}),
						createTestNode({id: "child-1b", name: "Child 1B", parentId: "parent-1"}),
						createTestNode({id: "child-2a", name: "Child 2A", parentId: "parent-2"}),
					]),
				);

				const result = cacheService.getChildrenForMultipleParents(["parent-1", "parent-2"]);

				expect(result.get("parent-1")!).toHaveLength(2);
				expect(result.get("parent-2")!).toHaveLength(1);
			});

			it("returns empty arrays for parents with no children", () => {
				seedTestData(
					testDatabase,
					nodeFixtures([createTestNode({id: "parent", name: "Parent", parentId: null})]),
				);

				const result = cacheService.getChildrenForMultipleParents(["parent", "missing"]);

				expect(result.get("parent")).toStrictEqual([]);
				expect(result.get("missing")).toStrictEqual([]);
			});

			it("returns empty map for empty input", () => {
				const result = cacheService.getChildrenForMultipleParents([]);
				expect(result.size).toBe(0);
			});
		});

		describe("resolveShortIdToUuid", () => {
			it("resolves short ID to full UUID", () => {
				const fullId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
				const shortId = "eeeeeeeeeeee";
				seedTestData(
					testDatabase,
					nodeFixtures([createTestNode({id: fullId, shortId, name: "Test", parentId: null})]),
				);

				const result = cacheService.resolveShortIdToUuid(shortId);

				expect(result).toBe(fullId);
			});

			it("returns null for non-existent short ID", () => {
				const result = cacheService.resolveShortIdToUuid("nonexistent12");
				expect(result).toBeNull();
			});
		});

		describe("resolveMultipleShortIds", () => {
			it("resolves multiple short IDs", () => {
				const id1 = "aaaaaaaa-1111-2222-3333-444444444444";
				const id2 = "bbbbbbbb-1111-2222-3333-555555555555";
				seedTestData(
					testDatabase,
					nodeFixtures([
						createTestNode({id: id1, shortId: "444444444444", name: "Node 1", parentId: null}),
						createTestNode({id: id2, shortId: "555555555555", name: "Node 2", parentId: null}),
					]),
				);

				const result = cacheService.resolveMultipleShortIds(["444444444444", "555555555555"]);

				expect(result.get("444444444444")).toBe(id1);
				expect(result.get("555555555555")).toBe(id2);
			});

			it("returns empty map for empty input", () => {
				const result = cacheService.resolveMultipleShortIds([]);
				expect(result.size).toBe(0);
			});
		});
	});
});
