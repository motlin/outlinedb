import {beforeEach, afterEach, describe, expect, it} from "vite-plus/test";
import {
	aiMetadata,
	calendarLevels,
	calendarMetadata,
	changesMetadata,
	mirrors,
	nodeContent,
	nodeEmbeddings,
	nodeDisplayMetadata,
	nodeMetadata,
	referencesRoots,
	s3Files,
} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import {eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {CacheService} from "@outlinedb/shared/cache";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {
	createApiNode,
	createNodeFromContent,
	createTestNode,
	splitNodeIntoContentAndMetadata,
} from "../helpers/node-fixtures.js";
import {expectPhasedOut} from "../helpers/assertion-helpers.js";

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
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "parent", name: "Parent", parentId: null})]));

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
			cacheService.storeApiResponse([createApiNode({id: "child", name: "Child", parent_id: "parent"})], "parent");

			// These records come only from backup imports; the sync must leave them open.
			expect(testDatabase.db.select().from(mirrors).where(eq(mirrors.mirrorId, "child")).get()!.systemTo).toBe(
				FAR_FUTURE_DATE,
			);
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

			const initialRecord = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.id, "node-1")).get()!;

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
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "node-1", name: "Same", parentId: null})]));
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

			const meta = testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, "new-node")).get()!;
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
			const contentSystemTo = db.select().from(nodeContent).where(eq(nodeContent.id, "parent")).get()!.systemTo;
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
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "parent", name: "Parent", parentId: null})]));

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
