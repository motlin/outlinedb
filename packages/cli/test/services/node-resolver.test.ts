import {beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {WorkflowyApiClient} from "@outlinedb/shared/api";
import type {MockInstance} from "vite-plus/test";
import {CacheService} from "../../src/services/cache.js";
import {
	resolveNodeId,
	resolveOptionalNodeId,
	resolveOptionalParent,
	resolveOrCreateNodePath,
	resolveParent,
} from "@outlinedb/shared/utils";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createApiNode, createTestNode} from "../helpers/node-fixtures.js";

describe("node-resolver service", () => {
	let tempDir: string;
	let testDatabase: TestDatabase;
	let cacheService: CacheService;
	let apiClient: WorkflowyApiClient;
	let mockApiClient: {
		findNodeByPath: MockInstance<WorkflowyApiClient["findNodeByPath"]>;
		createNode: MockInstance<WorkflowyApiClient["createNode"]>;
		getNode: MockInstance<WorkflowyApiClient["getNode"]>;
		getChildNodes: MockInstance<WorkflowyApiClient["getChildNodes"]>;
		getRootNodes: MockInstance<WorkflowyApiClient["getRootNodes"]>;
	};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-resolver-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		cacheService = new CacheService(testDatabase.db);

		apiClient = new WorkflowyApiClient("test-api-key");
		const createNode = vi
			.spyOn(apiClient, "createNode")
			.mockRejectedValue(new Error("createNode was not stubbed for this test"));
		mockApiClient = {
			findNodeByPath: vi.spyOn(apiClient, "findNodeByPath").mockResolvedValue(null),
			createNode,
			// A created node is read back for the priority Workflowy gave it
			getNode: vi
				.spyOn(apiClient, "getNode")
				.mockImplementation(async (id) => Promise.resolve(createApiNode({id, priority: 100}))),
			// After a create, the parent's children are re-read: the nodes created under it so far
			getChildNodes: vi.spyOn(apiClient, "getChildNodes").mockImplementation(async (parentId) =>
				Promise.resolve(
					createNode.mock.settledResults
						.flatMap((result) => (result.type === "fulfilled" ? [result.value] : []))
						.filter((node) => node.parent_id === parentId)
						.map((node) => ({...node, priority: 100})),
				),
			),
			// A create at Home re-reads the top-level nodes instead
			getRootNodes: vi.spyOn(apiClient, "getRootNodes").mockImplementation(async () =>
				Promise.resolve(
					createNode.mock.settledResults
						.flatMap((result) => (result.type === "fulfilled" ? [result.value] : []))
						.filter((node) => node.parent_id === null)
						.map((node) => ({...node, priority: 100})),
				),
			),
		};
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	describe("resolveNodeId", () => {
		it("returns id directly when provided", async () => {
			const result = await resolveNodeId({id: "direct-id"}, cacheService, apiClient);

			expect(result).toBe("direct-id");
			expect(mockApiClient.findNodeByPath.mock.calls).toStrictEqual([]);
		});

		it("resolves a short ID from the cache", async () => {
			const fullId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: fullId, shortId: "eeeeeeeeeeee", name: "Test node", parentId: null}),
				]),
			);

			const result = await resolveNodeId({id: "eeeeeeeeeeee"}, cacheService, apiClient);

			expect(result).toBe(fullId);
			expect(mockApiClient.findNodeByPath.mock.calls).toStrictEqual([]);
		});

		it("throws an error when a short ID is not in the cache", async () => {
			await expect(resolveNodeId({id: "aaaaaaaaaaaa"}, cacheService, apiClient)).rejects.toThrow(
				"No node found for short ID: aaaaaaaaaaaa",
			);
		});

		it("resolves path from cache", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "child-id", name: "Child", parentId: "root-id"}),
				]),
			);

			const result = await resolveNodeId({path: "Root,Child"}, cacheService, apiClient);

			expect(result).toBe("child-id");
			expect(mockApiClient.findNodeByPath.mock.calls).toStrictEqual([]);
		});

		it("falls back to API when not in cache", async () => {
			mockApiClient.findNodeByPath.mockResolvedValue(createApiNode({id: "api-resolved-id"}));

			const result = await resolveNodeId({path: "Missing,Path"}, cacheService, apiClient);

			expect(result).toBe("api-resolved-id");
			expect(mockApiClient.findNodeByPath).toHaveBeenCalledOnce();
			expect(mockApiClient.findNodeByPath.mock.calls[0]?.[0]).toStrictEqual(["Missing", "Path"]);
		});

		it("throws error when node not found", async () => {
			mockApiClient.findNodeByPath.mockResolvedValue(null);

			await expect(resolveNodeId({path: "Missing,Path"}, cacheService, apiClient)).rejects.toThrow(
				"Node not found at path: Missing > Path",
			);
		});

		it("trims whitespace from path segments", async () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "target", name: "Target", parentId: null})]));

			const result = await resolveNodeId({path: "  Target  "}, cacheService, apiClient);

			expect(result).toBe("target");
		});
	});

	describe("resolveOptionalNodeId", () => {
		it("returns undefined when no id or path provided", async () => {
			const result = await resolveOptionalNodeId({}, cacheService, apiClient);
			expect(result).toBeUndefined();
		});

		it("resolves id when provided", async () => {
			const result = await resolveOptionalNodeId({id: "my-id"}, cacheService, apiClient);
			expect(result).toBe("my-id");
		});

		it("resolves path when provided", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "resolved-id", name: "Target", parentId: null})]),
			);

			const result = await resolveOptionalNodeId({path: "Target"}, cacheService, apiClient);
			expect(result).toBe("resolved-id");
		});
	});

	describe("resolveParent", () => {
		it("returns id directly when provided", async () => {
			const result = await resolveParent({id: "parent-id"}, cacheService, apiClient);
			expect(result).toBe("parent-id");
		});

		it("returns system target key directly when passed via id", async () => {
			const result = await resolveParent({id: "inbox"}, cacheService, apiClient);
			expect(result).toBe("inbox");
		});

		it("resolves home to null, the top level", async () => {
			const result = await resolveParent({id: "home"}, cacheService, apiClient);
			expect(result).toBeNull();
		});

		it("resolves a short ID from the cache", async () => {
			const fullId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: fullId, shortId: "eeeeeeeeeeee", name: "Parent", parentId: null})]),
			);

			const result = await resolveParent({id: "eeeeeeeeeeee"}, cacheService, apiClient);

			expect(result).toBe(fullId);
			expect(mockApiClient.findNodeByPath.mock.calls).toStrictEqual([]);
		});

		it("throws an error when a short ID is not in the cache", async () => {
			await expect(resolveParent({id: "aaaaaaaaaaaa"}, cacheService, apiClient)).rejects.toThrow(
				"No node found for short ID: aaaaaaaaaaaa",
			);
		});

		it("resolves path from cache", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "parent-id", name: "Parent", parentId: "root-id"}),
				]),
			);

			const result = await resolveParent({path: "Root,Parent"}, cacheService, apiClient);
			expect(result).toBe("parent-id");
		});

		it("falls back to API for path resolution", async () => {
			mockApiClient.findNodeByPath.mockResolvedValue(createApiNode({id: "api-parent-id"}));

			const result = await resolveParent({path: "Missing,Parent"}, cacheService, apiClient);

			expect(result).toBe("api-parent-id");
			expect(mockApiClient.findNodeByPath).toHaveBeenCalledOnce();
		});

		it("throws error when no flags provided", async () => {
			await expect(resolveParent({}, cacheService, apiClient)).rejects.toThrow(
				"One of --parent-id or --parent-path is required",
			);
		});

		it("throws error when multiple flags provided", async () => {
			await expect(resolveParent({id: "id", path: "path"}, cacheService, apiClient)).rejects.toThrow(
				"Only one of --parent-id or --parent-path can be specified",
			);
		});

		it("throws error when path not found", async () => {
			mockApiClient.findNodeByPath.mockResolvedValue(null);

			await expect(resolveParent({path: "Missing,Node"}, cacheService, apiClient)).rejects.toThrow(
				"Node not found at path: Missing > Node",
			);
		});
	});

	describe("resolveOptionalParent", () => {
		it("returns undefined when no flags provided", async () => {
			const result = await resolveOptionalParent({}, cacheService, apiClient);
			expect(result).toBeUndefined();
		});

		it("resolves id when provided", async () => {
			const result = await resolveOptionalParent({id: "parent-id"}, cacheService, apiClient);
			expect(result).toBe("parent-id");
		});

		it("resolves system target when passed via id", async () => {
			const result = await resolveOptionalParent({id: "inbox"}, cacheService, apiClient);
			expect(result).toBe("inbox");
		});

		it("resolves path when provided", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([createTestNode({id: "target-id", name: "Target", parentId: null})]),
			);

			const result = await resolveOptionalParent({path: "Target"}, cacheService, apiClient);
			expect(result).toBe("target-id");
		});
	});

	describe("resolveOrCreateNodePath", () => {
		it("resolves existing path without creating", async () => {
			seedTestData(
				testDatabase,
				nodeFixtures([
					createTestNode({id: "root-id", name: "Root", parentId: null}),
					createTestNode({id: "leaf-id", name: "Leaf", parentId: "root-id"}),
				]),
			);

			const result = await resolveOrCreateNodePath("Root,Leaf", cacheService, apiClient);

			expect(result).toBe("leaf-id");
			expect(mockApiClient.createNode.mock.calls).toStrictEqual([]);
		});

		it("creates missing path segments", async () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "root-id", name: "Root", parentId: null})]));

			const now = Date.now();
			mockApiClient.createNode.mockResolvedValue(
				createApiNode({id: "new-child-id", name: "NewChild", parent_id: "root-id", createdAt: now}),
			);

			const result = await resolveOrCreateNodePath("Root,NewChild", cacheService, apiClient);

			expect(result).toBe("new-child-id");
			expect(mockApiClient.createNode).toHaveBeenCalledOnce();
			expect(mockApiClient.createNode.mock.calls[0]?.[0]).toStrictEqual({
				parent_id: "root-id",
				name: "NewChild",
			});
		});

		it("creates multiple missing segments", async () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "root-id", name: "Root", parentId: null})]));

			const now = Date.now();
			mockApiClient.createNode.mockResolvedValueOnce(
				createApiNode({id: "level2-id", name: "Level2", parent_id: "root-id", createdAt: now}),
			);
			mockApiClient.createNode.mockResolvedValueOnce(
				createApiNode({id: "level3-id", name: "Level3", parent_id: "level2-id", createdAt: now}),
			);

			const result = await resolveOrCreateNodePath("Root,Level2,Level3", cacheService, apiClient);

			expect(result).toBe("level3-id");
			expect(mockApiClient.createNode).toHaveBeenCalledTimes(2);
		});

		it("creates a missing first segment at Home", async () => {
			mockApiClient.findNodeByPath.mockResolvedValue(null);

			const now = Date.now();
			mockApiClient.createNode.mockResolvedValueOnce(
				createApiNode({id: "new-root-id", name: "NewRoot", parent_id: null, createdAt: now}),
			);
			mockApiClient.createNode.mockResolvedValueOnce(
				createApiNode({id: "child-id", name: "Child", parent_id: "new-root-id", createdAt: now}),
			);

			const result = await resolveOrCreateNodePath("NewRoot,Child", cacheService, apiClient);

			expect(result).toBe("child-id");
			expect(mockApiClient.createNode.mock.calls).toStrictEqual([
				[{parent_id: null, name: "NewRoot"}],
				[{parent_id: "new-root-id", name: "Child"}],
			]);
		});

		it("deduplicates created nodes within same call", async () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "root-id", name: "Root", parentId: null})]));

			const now = Date.now();
			mockApiClient.createNode.mockResolvedValue(
				createApiNode({id: "new-id", name: "New", parent_id: "root-id", createdAt: now}),
			);

			// This shouldn't happen in real usage, but tests the dedup logic
			const result = await resolveOrCreateNodePath("Root,New", cacheService, apiClient);

			expect(result).toBe("new-id");
			expect(mockApiClient.createNode).toHaveBeenCalledOnce();
		});

		it("caches created nodes in database", async () => {
			seedTestData(testDatabase, nodeFixtures([createTestNode({id: "root-id", name: "Root", parentId: null})]));

			const now = Date.now();
			mockApiClient.createNode.mockResolvedValue(
				createApiNode({id: "cached-id", name: "Cached", parent_id: "root-id", createdAt: now}),
			);

			await resolveOrCreateNodePath("Root,Cached", cacheService, apiClient);

			// Verify node was cached
			const cached = cacheService.getNode("cached-id");
			expect(cached?.name).toBe("Cached");
		});
	});
});
