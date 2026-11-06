import {describe, expect, it} from "vite-plus/test";
import {CF_EMBEDDING_MODEL, vectorizeIndex, workersAiEmbedder} from "../src/embeddings";
import type {VectorizeBinding} from "../src/embeddings";

function fakeVectorize(): VectorizeBinding & {calls: unknown[]} {
	const calls: unknown[] = [];
	return {
		calls,
		getByIds(ids) {
			calls.push({getByIds: ids});
			return ids.includes("known") ? [{id: "known", values: [0.5, 0.25]}] : [];
		},
		query(vector, options) {
			calls.push({query: vector, options});
			return {
				count: 2,
				matches: [
					{id: "a", score: 0.9},
					{id: "b", score: 0.25},
				],
			};
		},
		upsert(vectors) {
			calls.push({upsert: vectors});
			return {mutationId: "m"};
		},
		deleteByIds(ids) {
			calls.push({deleteByIds: ids});
			return {mutationId: "m"};
		},
	};
}

describe("vectorizeIndex", () => {
	it("reads a stored vector by id and undefined for an unknown one", async () => {
		const binding = fakeVectorize();
		const index = vectorizeIndex(binding, "ns");
		await expect(index.vectorFor("known")).resolves.toStrictEqual([0.5, 0.25]);
		await expect(index.vectorFor("missing")).resolves.toBeUndefined();
	});

	it("queries the account's namespace and turns cosine scores into distances", async () => {
		const binding = fakeVectorize();
		const neighbours = await vectorizeIndex(binding, "ns").query([1, 0], 31);
		expect(neighbours).toStrictEqual([
			{id: "a", distance: 1 - 0.9},
			{id: "b", distance: 0.75},
		]);
		expect(binding.calls).toStrictEqual([{query: [1, 0], options: {topK: 31, namespace: "ns"}}]);
	});

	it("upserts into the namespace and deletes in batches of 1,000", async () => {
		const binding = fakeVectorize();
		const index = vectorizeIndex(binding, "ns");
		const ids = Array.from({length: 1001}, (_, i) => `n${i}`);
		await index.upsert([{id: "a", vector: [1, 2]}]);
		await index.delete(ids);
		await index.delete([]);
		expect(binding.calls).toStrictEqual([
			{upsert: [{id: "a", values: [1, 2], namespace: "ns"}]},
			{deleteByIds: ids.slice(0, 1000)},
			{deleteByIds: ["n1000"]},
		]);
	});
});

describe("workersAiEmbedder", () => {
	it("embeds a batch of texts with bge-m3 in one call", async () => {
		const runs: unknown[] = [];
		const embedder = workersAiEmbedder({
			run(model: string, input: unknown) {
				runs.push({model, input});
				return {
					shape: [2, 2],
					data: [
						[1, 0],
						[0, 1],
					],
				};
			},
		});
		await expect(embedder.embed(["one", "two"])).resolves.toStrictEqual([
			[1, 0],
			[0, 1],
		]);
		expect(runs).toStrictEqual([{model: CF_EMBEDDING_MODEL, input: {text: ["one", "two"]}}]);
	});

	it("rejects a response without one vector per text", async () => {
		const embedder = workersAiEmbedder({run: () => ({data: [[1, 0]]})});
		await expect(embedder.embed(["one", "two"])).rejects.toThrow("Workers AI returned 1 vectors for 2 texts");
	});
});
