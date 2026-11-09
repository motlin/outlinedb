import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {mirrors, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq} from "drizzle-orm";
import {randomUUID} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {afterEach, assert, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {MockInstance} from "vite-plus/test";
import {CacheService} from "../../src/services/cache.js";
import {cleanupTestDatabase, createTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {withoutSystemFrom} from "../helpers/assertion-helpers.js";
import {createTestNode, splitNodeIntoContentAndMetadata} from "../helpers/node-fixtures.js";

function insertTestNodes(
	db: ReturnType<typeof createTestDatabase>["db"],
	testNodes: ReturnType<typeof createTestNode>[],
) {
	const contents = testNodes.map((n) => splitNodeIntoContentAndMetadata(n).content);
	const metadatas = testNodes.map((n) => splitNodeIntoContentAndMetadata(n).metadata);
	db.insert(nodeContent).values(contents).run();
	db.insert(nodeMetadata).values(metadatas).run();
}

describe("API Sync with Cache", () => {
	let testDatabase: TestDatabase;
	let cacheService: CacheService;
	let apiClient: WorkflowyApiClient;
	let fetchStub: MockInstance;

	beforeEach(() => {
		const tempDbPath = path.join(os.tmpdir(), `test-workflowy-${randomUUID()}.sqlite`);
		testDatabase = createTestDatabase(tempDbPath);

		cacheService = new CacheService(testDatabase.db);
		apiClient = new WorkflowyApiClient("test-api-key");

		fetchStub = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);
	});

	describe("Fetching nodes from API and storing in cache", () => {
		it("fetches root nodes from API and stores them correctly", async () => {
			const apiResponse = {
				nodes: [
					{
						id: "api-root-1",
						name: "Root Node 1",
						note: "Root note 1",
						priority: 100,
						completed: false,
						createdAt: 1_700_000_000,
						modifiedAt: 1_700_001_000,
						completedAt: null,
						data: {layoutMode: "bullets"},
					},
					{
						id: "api-root-2",
						name: "Root Node 2",
						note: null,
						priority: 200,
						completed: true,
						createdAt: 1_700_002_000,
						modifiedAt: 1_700_003_000,
						completedAt: 1_700_004_000,
						data: {layoutMode: "todo"},
					},
				],
			};

			fetchStub.mockResolvedValue({
				ok: true,
				json: async () => Promise.resolve(apiResponse),
			});

			const nodes = await apiClient.getRootNodes();
			cacheService.storeApiResponse(nodes, null);

			const storedContent = testDatabase.db.select().from(nodeContent).all();
			expect(storedContent.map(({systemFrom: _systemFrom, ...content}) => content)).toStrictEqual([
				{
					id: "api-root-1",
					name: "Root Node 1",
					note: "Root note 1",
					parentId: null,
					systemTo: FAR_FUTURE_DATE,
				},
				{
					id: "api-root-2",
					name: "Root Node 2",
					note: null,
					parentId: null,
					systemTo: FAR_FUTURE_DATE,
				},
			]);

			const content1 = storedContent.find((n) => n.id === "api-root-1");
			const content2 = storedContent.find((n) => n.id === "api-root-2");

			const content1SystemFrom = content1!.systemFrom;

			expect(withoutSystemFrom(content1)).toStrictEqual({
				id: "api-root-1",
				name: "Root Node 1",
				note: "Root note 1",
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});
			expect(withoutSystemFrom(content2)).toStrictEqual({
				id: "api-root-2",
				name: "Root Node 2",
				note: null,
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});
			expect(content1SystemFrom).toBeTypeOf("string");

			const storedMetadata = testDatabase.db.select().from(nodeMetadata).all();
			const metadata1 = storedMetadata.find((m) => m.nodeId === "api-root-1");
			const metadata2 = storedMetadata.find((m) => m.nodeId === "api-root-2");

			expect(withoutSystemFrom(metadata1)).toStrictEqual({
				nodeId: "api-root-1",
				shortId: "apiroot1", // getShortId removes dashes and takes last 12 chars
				priority: 100,
				createdAt: new Date(1_700_000_000 * 1000),
				modifiedAt: new Date(1_700_001_000 * 1000),
				completedAt: null,
				layoutMode: null,
				systemTo: FAR_FUTURE_DATE,
			});
			expect(withoutSystemFrom(metadata2)).toStrictEqual({
				nodeId: "api-root-2",
				shortId: "apiroot2",
				priority: 200,
				createdAt: new Date(1_700_002_000 * 1000),
				modifiedAt: new Date(1_700_003_000 * 1000),
				completedAt: new Date(1_700_004_000 * 1000),
				layoutMode: "todo",
				systemTo: FAR_FUTURE_DATE,
			});
		});

		it("fetches child nodes from API and stores with correct parent relationship", async () => {
			const parentId = "parent-node-id";

			insertTestNodes(testDatabase.db, [
				createTestNode({
					id: parentId,
					name: "Parent Node",
					parentId: null,
					createdAt: new Date(1_700_000_000 * 1000),
					modifiedAt: new Date(1_700_001_000 * 1000),
					layoutMode: "bullets",
				}),
			]);

			const apiResponse = {
				nodes: [
					{
						id: "child-1",
						name: "Child Node 1",
						note: "Child note",
						priority: 150,
						completed: false,
						createdAt: 1_700_010_000,
						modifiedAt: 1_700_011_000,
						completedAt: null,
						data: {},
					},
					{
						id: "child-2",
						name: "Child Node 2",
						note: null,
						priority: 250,
						completed: false,
						createdAt: 1_700_020_000,
						modifiedAt: 1_700_021_000,
						completedAt: null,
						data: {layoutMode: "headings"},
					},
				],
			};

			fetchStub.mockResolvedValue({
				ok: true,
				json: async () => Promise.resolve(apiResponse),
			});

			const nodes = await apiClient.getChildNodes(parentId);
			cacheService.storeApiResponse(nodes, parentId);

			const children = testDatabase.db.select().from(nodeContent).where(eq(nodeContent.parentId, parentId)).all();

			expect(children.map(({systemFrom: _systemFrom, ...content}) => content)).toStrictEqual([
				{
					id: "child-1",
					name: "Child Node 1",
					note: "Child note",
					parentId,
					systemTo: FAR_FUTURE_DATE,
				},
				{
					id: "child-2",
					name: "Child Node 2",
					note: null,
					parentId,
					systemTo: FAR_FUTURE_DATE,
				},
			]);

			const child1 = children.find((c) => c.id === "child-1");
			const child2 = children.find((c) => c.id === "child-2");

			expect(withoutSystemFrom(child1)).toStrictEqual({
				id: "child-1",
				name: "Child Node 1",
				note: "Child note",
				parentId,
				systemTo: FAR_FUTURE_DATE,
			});
			expect(withoutSystemFrom(child2)).toStrictEqual({
				id: "child-2",
				name: "Child Node 2",
				note: null,
				parentId,
				systemTo: FAR_FUTURE_DATE,
			});

			const childMeta1 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "child-1"))
				.get();
			const childMeta2 = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(eq(nodeMetadata.nodeId, "child-2"))
				.get();

			expect(withoutSystemFrom(childMeta1)).toStrictEqual({
				nodeId: "child-1",
				shortId: "child1",
				priority: 150,
				createdAt: new Date(1_700_010_000 * 1000),
				modifiedAt: new Date(1_700_011_000 * 1000),
				completedAt: null,
				layoutMode: null, // default empty data = null
				systemTo: FAR_FUTURE_DATE,
			});
			expect(withoutSystemFrom(childMeta2)).toStrictEqual({
				nodeId: "child-2",
				shortId: "child2",
				priority: 250,
				createdAt: new Date(1_700_020_000 * 1000),
				modifiedAt: new Date(1_700_021_000 * 1000),
				completedAt: null,
				layoutMode: "headings",
				systemTo: FAR_FUTURE_DATE,
			});
		});

		it("updates existing nodes when fetching from API", async () => {
			insertTestNodes(testDatabase.db, [
				createTestNode({
					id: "existing-node",
					name: "Old Name",
					note: "Old Note",
					parentId: null,
					priority: 50,
					createdAt: new Date(1_600_000_000 * 1000),
					modifiedAt: new Date(1_600_001_000 * 1000),
					completedAt: null,
					layoutMode: "bullets",
					systemFrom: "2020-01-01 00:00:00.000",
				}),
			]);

			const apiResponse = {
				nodes: [
					{
						id: "existing-node",
						name: "Updated Name",
						note: "Updated Note",
						priority: 150,
						completed: true,
						createdAt: 1_700_000_000,
						modifiedAt: 1_700_005_000,
						completedAt: 1_700_006_000,
						data: {layoutMode: "todo"},
					},
				],
			};

			fetchStub.mockResolvedValue({
				ok: true,
				json: async () => Promise.resolve(apiResponse),
			});

			const nodes = await apiClient.getRootNodes();
			cacheService.storeApiResponse(nodes, null);

			const updatedContent = testDatabase.db
				.select()
				.from(nodeContent)
				.where(and(eq(nodeContent.id, "existing-node"), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
				.get();

			expect(withoutSystemFrom(updatedContent)).toStrictEqual({
				id: "existing-node",
				name: "Updated Name",
				note: "Updated Note",
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});

			const updatedMeta = testDatabase.db
				.select()
				.from(nodeMetadata)
				.where(and(eq(nodeMetadata.nodeId, "existing-node"), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)))
				.get();

			expect(withoutSystemFrom(updatedMeta)).toStrictEqual({
				nodeId: "existing-node",
				shortId: "existingnode",
				priority: 150,
				createdAt: new Date(1_700_000_000 * 1000),
				modifiedAt: new Date(1_700_005_000 * 1000),
				completedAt: new Date(1_700_006_000 * 1000),
				layoutMode: "todo",
				systemTo: FAR_FUTURE_DATE,
			});
		});

		// Mirror rows (backlink items included) are sourced ONLY from backup imports;
		// the API (import-api / sync-node) never supplies them. An API sync must therefore
		// leave them untouched — expiring them on every sync is permanent data loss, not a
		// refresh, and is what silently blanks mirror nodes after a daily `cache sync-node`.
		it("preserves live mirror rows when syncing a node from the API", async () => {
			const mirrorNodeId = "mirror-node";
			const originalNodeId = "original-node";
			const liveSystemFrom = "2026-01-01 00:00:00.000";

			insertTestNodes(testDatabase.db, [
				createTestNode({id: mirrorNodeId, name: null, systemFrom: liveSystemFrom}),
				createTestNode({id: originalNodeId, name: "Original text", systemFrom: liveSystemFrom}),
			]);

			testDatabase.db
				.insert(mirrors)
				.values({
					originalId: originalNodeId,
					mirrorId: mirrorNodeId,
					systemFrom: liveSystemFrom,
					systemTo: FAR_FUTURE_DATE,
				})
				.run();

			const apiResponse = {
				nodes: [
					{
						id: mirrorNodeId,
						name: "mirror node content from API",
						note: null,
						priority: 100,
						completed: false,
						createdAt: 1_700_000_000,
						modifiedAt: 1_700_001_000,
						completedAt: null,
						data: {layoutMode: "bullets"},
					},
				],
			};
			fetchStub.mockResolvedValue({ok: true, json: async () => Promise.resolve(apiResponse)});

			const nodes = await apiClient.getRootNodes();
			cacheService.storeApiResponse(nodes, null);

			const liveMirrors = testDatabase.db
				.select()
				.from(mirrors)
				.where(and(eq(mirrors.mirrorId, mirrorNodeId), eq(mirrors.systemTo, FAR_FUTURE_DATE)))
				.all();
			expect(liveMirrors.map(({mirrorId, originalId}) => ({mirrorId, originalId}))).toStrictEqual([
				{mirrorId: mirrorNodeId, originalId: "original-node"},
			]);
		});
	});

	describe("Cache retrieval", () => {
		it("retrieves cached nodes without API call", () => {
			insertTestNodes(testDatabase.db, [
				createTestNode({
					id: "cached-node",
					name: "Cached Name",
					note: "Cached Note",
					parentId: null,
					priority: 100,
					createdAt: new Date(1_700_000_000 * 1000),
					modifiedAt: new Date(1_700_001_000 * 1000),
					layoutMode: "bullets",
				}),
			]);

			const cachedNode = cacheService.getNode("cached-node");

			const actualSystemFrom = cachedNode!.systemFrom;

			expect(withoutSystemFrom(cachedNode)).toStrictEqual({
				id: "cached-node",
				shortId: "cachednode",
				name: "Cached Name",
				note: "Cached Note",
				parentId: null,
				priority: 100,
				createdAt: new Date(1_700_000_000 * 1000),
				modifiedAt: new Date(1_700_001_000 * 1000),
				completedAt: null,
				layoutMode: "bullets",
				collapsed: false,
				mirror: {isMirror: false, originalNodeId: null},
				systemTo: FAR_FUTURE_DATE,
			});
			expect(actualSystemFrom).toBeTypeOf("string");

			expect(fetchStub.mock.calls).toStrictEqual([]);
		});

		it("returns undefined for non-existent nodes", () => {
			const node = cacheService.getNode("non-existent");
			expect(node).toBeUndefined();
		});
	});

	describe("Batch operations and performance", () => {
		it("stores multiple nodes from API in one batch", async () => {
			const apiResponse = {
				nodes: Array.from({length: 100}, (_, i) => ({
					id: `node-${i}`,
					name: `Node ${i}`,
					note: i % 2 === 0 ? `Note ${i}` : null,
					priority: i * 10,
					completed: i % 3 === 0,
					createdAt: 1_700_000_000 + i,
					modifiedAt: 1_700_001_000 + i,
					completedAt: i % 3 === 0 ? 1_700_002_000 + i : null,
					data: {layoutMode: i % 2 === 0 ? "bullets" : "todo"},
				})),
			};

			fetchStub.mockResolvedValue({
				ok: true,
				json: async () => Promise.resolve(apiResponse),
			});

			const nodes = await apiClient.getRootNodes();
			cacheService.storeApiResponse(nodes, null);

			const storedContent = testDatabase.db.select().from(nodeContent).all();
			expect(storedContent.map((content) => content.id).toSorted()).toStrictEqual(
				Array.from({length: 100}, (_, index) => `node-${index}`).toSorted(),
			);

			// Spot-check node-0 (index 0: even, divisible by 3)
			const content0 = storedContent.find((n) => n.id === "node-0");

			expect(withoutSystemFrom(content0)).toStrictEqual({
				id: "node-0",
				name: "Node 0",
				note: "Note 0",
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});

			const meta0 = testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, "node-0")).get();

			expect(withoutSystemFrom(meta0)).toStrictEqual({
				nodeId: "node-0",
				shortId: "node0",
				priority: 0,
				createdAt: new Date(1_700_000_000 * 1000),
				modifiedAt: new Date(1_700_001_000 * 1000),
				completedAt: new Date(1_700_002_000 * 1000), // i % 3 === 0, so completedAt is set
				layoutMode: null,
				systemTo: FAR_FUTURE_DATE,
			});

			// Spot-check node-50 (index 50: even, not divisible by 3)
			const content50 = storedContent.find((n) => n.id === "node-50");

			expect(withoutSystemFrom(content50)).toStrictEqual({
				id: "node-50",
				name: "Node 50",
				note: "Note 50",
				parentId: null,
				systemTo: FAR_FUTURE_DATE,
			});

			const meta50 = testDatabase.db.select().from(nodeMetadata).where(eq(nodeMetadata.nodeId, "node-50")).get();

			expect(withoutSystemFrom(meta50)).toStrictEqual({
				nodeId: "node-50",
				shortId: "node50",
				priority: 500,
				createdAt: new Date(1_700_000_050 * 1000),
				modifiedAt: new Date(1_700_001_050 * 1000),
				completedAt: null, // 50 % 3 !== 0, so completedAt is null
				layoutMode: null,
				systemTo: FAR_FUTURE_DATE,
			});
		});
	});

	describe("Error handling", () => {
		it("handles API errors gracefully", async () => {
			fetchStub.mockResolvedValue({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			});

			await expect(apiClient.getRootNodes()).rejects.toThrow("API request failed: 500 Internal Server Error");

			const storedContent = testDatabase.db.select().from(nodeContent).all();
			expect(storedContent).toStrictEqual([]);
		});

		it("handles malformed API responses", async () => {
			fetchStub.mockResolvedValue({
				ok: true,
				json: async () =>
					Promise.resolve({
						invalid: "response",
					}),
			});

			const expectedMessage = JSON.stringify(
				[
					{
						code: "unrecognized_keys",
						keys: ["invalid"],
						path: [],
						message: 'Unrecognized key: "invalid"',
					},
				],
				null,
				2,
			);
			const error = await apiClient.getRootNodes().catch((caught: unknown) => caught);
			assert(error instanceof Error);
			expect({name: error.name, message: error.message}).toStrictEqual({
				name: "ZodError",
				message: expectedMessage,
			});
		});
	});

	describe("Rate limit handling (429)", () => {
		function successResponse(): Response {
			return Response.json({
				nodes: [
					{
						id: "n1",
						name: "N1",
						note: null,
						priority: 0,
						completed: false,
						createdAt: 1_700_000_000,
						modifiedAt: 1_700_001_000,
						completedAt: null,
						data: {},
					},
				],
			});
		}

		function tooManyRequests(retryAfter?: string, body: string | null = null): Response {
			return new Response(body, {
				status: 429,
				statusText: "Too Many Requests",
				headers: new Headers(retryAfter === undefined ? {} : {"retry-after": retryAfter}),
			});
		}

		it("retries on 429 and succeeds once a later attempt returns 200", async () => {
			const client = new WorkflowyApiClient("test-api-key", undefined, undefined, {
				maxRetries: 3,
				baseDelayMs: 0,
			});

			fetchStub.mockResolvedValueOnce(tooManyRequests());
			fetchStub.mockResolvedValueOnce(tooManyRequests());
			fetchStub.mockResolvedValueOnce(successResponse());

			const nodes = await client.getChildNodes("parent-id");

			expect(nodes).toStrictEqual([
				{
					id: "n1",
					name: "N1",
					note: null,
					priority: 0,
					completed: false,
					createdAt: 1_700_000_000,
					modifiedAt: 1_700_001_000,
					completedAt: null,
					data: {},
				},
			]);
			expect(fetchStub).toHaveBeenCalledTimes(3);
		});

		it("throws after exhausting retries when every attempt returns 429", async () => {
			const client = new WorkflowyApiClient("test-api-key", undefined, undefined, {
				maxRetries: 2,
				baseDelayMs: 0,
			});

			fetchStub.mockResolvedValue(tooManyRequests());

			await expect(client.getChildNodes("parent-id")).rejects.toThrow(
				"API request failed: 429 Too Many Requests",
			);
			expect(fetchStub).toHaveBeenCalledTimes(3);
		});

		it("caps exponential backoff at maxDelayMs", async () => {
			// A huge baseDelayMs would stall the test for minutes if the cap were
			// not applied; maxDelayMs of 0 forces the retry to happen immediately.
			const client = new WorkflowyApiClient("test-api-key", undefined, undefined, {
				maxRetries: 3,
				baseDelayMs: 10 * 60 * 1000,
				maxDelayMs: 0,
			});

			fetchStub.mockResolvedValueOnce(tooManyRequests());
			fetchStub.mockResolvedValueOnce(successResponse());

			const nodes = await client.getChildNodes("parent-id");

			expect(nodes).toStrictEqual([
				{
					id: "n1",
					name: "N1",
					note: null,
					priority: 0,
					completed: false,
					createdAt: 1_700_000_000,
					modifiedAt: 1_700_001_000,
					completedAt: null,
					data: {},
				},
			]);
			expect(fetchStub).toHaveBeenCalledTimes(2);
		});

		it("honors the retry_after seconds in the 429 body when there is no Retry-After header", async () => {
			const client = new WorkflowyApiClient("test-api-key", undefined, undefined, {
				maxRetries: 3,
				baseDelayMs: 999_999,
				maxDelayMs: 999_999,
			});

			fetchStub.mockResolvedValueOnce(tooManyRequests(undefined, JSON.stringify({retry_after: 0})));
			fetchStub.mockResolvedValueOnce(successResponse());

			const nodes = await client.getChildNodes("parent-id");

			expect(nodes).toStrictEqual([
				{
					id: "n1",
					name: "N1",
					note: null,
					priority: 0,
					completed: false,
					createdAt: 1_700_000_000,
					modifiedAt: 1_700_001_000,
					completedAt: null,
					data: {},
				},
			]);
			expect(fetchStub).toHaveBeenCalledTimes(2);
		}, 5000);

		it("honors the Retry-After header when present", async () => {
			const client = new WorkflowyApiClient("test-api-key", undefined, undefined, {
				maxRetries: 3,
				baseDelayMs: 999_999,
			});

			fetchStub.mockResolvedValueOnce(tooManyRequests("0"));
			fetchStub.mockResolvedValueOnce(successResponse());

			const nodes = await client.getChildNodes("parent-id");

			expect(nodes).toStrictEqual([
				{
					id: "n1",
					name: "N1",
					note: null,
					priority: 0,
					completed: false,
					createdAt: 1_700_000_000,
					modifiedAt: 1_700_001_000,
					completedAt: null,
					data: {},
				},
			]);
			expect(fetchStub).toHaveBeenCalledTimes(2);
		});
	});
});
