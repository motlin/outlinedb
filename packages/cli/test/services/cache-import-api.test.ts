import {assert, beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import {aiMetadata, mirrors, nodeContent, nodeEmbeddings, nodeMetadata, referencesRoots} from "@outlinedb/shared/db";
import type {InternalTreeItem} from "@outlinedb/shared/api";
import {countStrandedRows, currentBacklinkItems, SameMillisecondOverwriteError} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {importFromApi} from "../../src/services/cache-import-api.js";
import {cleanupTestDatabase, createTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createApiNode, createNodeFromContent} from "../helpers/node-fixtures.js";
import {expectActiveRecord} from "../helpers/assertion-helpers.js";

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

			const content = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "full-node")).get()!;
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
			const firstImport: WorkflowyNode[] = [createApiNode({id: "node-1", name: "Original Name", priority: 0})];

			importFromApi(testDatabase.db, firstImport);

			const secondImport: WorkflowyNode[] = [createApiNode({id: "node-1", name: "Updated Name", priority: 0})];

			const result = importFromApi(testDatabase.db, secondImport);
			expect(result.nodesUpdated).toBe(1);
			expect(result.nodesUnchanged).toBe(0);

			const allNode1Records = testDatabase.db
				.select()
				.from(nodeContent)
				.where(eq(nodeContent.id, "node-1"))
				.all();
			expect(allNode1Records.map((n) => ({name: n.name, active: n.systemTo === FAR_FUTURE_DATE}))).toStrictEqual([
				{name: "Original Name", active: false},
				{name: "Updated Name", active: true},
			]);
		});
	});

	describe("system time", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("fails the later of two imports changing a node within one millisecond and keeps the earlier's version", () => {
			vi.useFakeTimers({toFake: ["Date"], now: new Date("2026-02-01T00:00:00.000Z")});

			importFromApi(testDatabase.db, [createApiNode({id: "node-1", name: "Original Name", priority: 0})]);

			expect(() =>
				importFromApi(testDatabase.db, [createApiNode({id: "node-1", name: "Updated Name", priority: 0})]),
			).toThrow(new SameMillisecondOverwriteError("node_content", "id=node-1", "2026-02-01 00:00:00.000"));
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
