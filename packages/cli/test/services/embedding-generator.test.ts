import {beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import {nodeEmbeddings} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {loadEmbeddableNodes} from "@outlinedb/shared/cache";
import {EmbeddingGeneratorService} from "../../src/services/embedding-generator.js";
import {embeddingService} from "../../src/services/embeddings.js";
import {cleanupTestDatabase, createInMemoryTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";

const EARLIER = "2025-12-01 00:00:00.000";
const SYSTEM_FROM = "2026-01-01 00:00:00.000";
const EMBEDDING = Buffer.from(new Float32Array([1, 2]).buffer);

function embedding(nodeId: string, model: string, systemFrom: string, systemTo: string) {
	return {nodeId, model, embedding: EMBEDDING, systemFrom, systemTo};
}

/**
 * A mirror has no text of its own, so it is never embedded: its original is.
 * Embeddings left on mirror ids by earlier runs are pruned.
 */
describe("EmbeddingGeneratorService on mirrors", () => {
	let testDatabase: TestDatabase;

	beforeEach(() => {
		testDatabase = createInMemoryTestDatabase();
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "orig", name: "Original", parentId: null, priority: 0}),
				createTestNode({id: "orig-child", name: "Original child", parentId: "orig", priority: 0}),
				createTestNode({id: "mir", name: "Stale mirror name", parentId: null, priority: 1}),
				createTestNode({id: "mir-child", name: "Mirror child", parentId: "mir", priority: 0}),
			]),
			mirrors: [{originalId: "orig", mirrorId: "mir", systemFrom: SYSTEM_FROM, systemTo: FAR_FUTURE_DATE}],
		});
		testDatabase.db
			.insert(nodeEmbeddings)
			.values([
				embedding("orig", "minilm", SYSTEM_FROM, FAR_FUTURE_DATE),
				embedding("mir", "minilm", EARLIER, SYSTEM_FROM),
				embedding("mir", "minilm", SYSTEM_FROM, FAR_FUTURE_DATE),
				embedding("mir", "mpnet", SYSTEM_FROM, FAR_FUTURE_DATE),
			])
			.run();
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);
	});

	it("selects only non-leaf nodes that are not mirrors", () => {
		const nodes = loadEmbeddableNodes(testDatabase.db);

		expect(nodes.map((node) => node.id)).toStrictEqual(["orig"]);
	});

	it("prunes every mirror embedding and embeds nothing for mirrors", async () => {
		const generateEmbedding = vi.spyOn(embeddingService, "generateEmbedding");

		const result = await new EmbeddingGeneratorService(testDatabase.db).generateEmbeddings({
			batchSize: 10,
			force: false,
			model: "minilm",
		});

		expect(generateEmbedding).not.toHaveBeenCalled();
		expect(result).toStrictEqual({
			totalProcessed: 0,
			totalTime: 0,
			alreadyComplete: true,
			modelStats: new Map([["minilm", {needed: 0, processed: 0}]]),
		});
		expect(testDatabase.db.select().from(nodeEmbeddings).all()).toStrictEqual([
			embedding("orig", "minilm", SYSTEM_FROM, FAR_FUTURE_DATE),
		]);
	});
});
