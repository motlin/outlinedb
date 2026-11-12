import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {embeddingService} from "../../src/services/embeddings.js";

describe("EmbeddingService OpenAI embeddings", () =>
{
	beforeEach(() =>
	{
		vi.stubEnv("OPENAI_API_KEY", "test-key");
	});

	afterEach(() =>
	{
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("returns the embedding from a well-formed response", async () =>
	{
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				Response.json(
					{
						data: [
							{
								embedding: [0.5, 0.25],
							},
						],
					},
				),
			),
		);

		const result = await embeddingService.generateEmbedding("hello", "openai-small");

		expect(result).toStrictEqual(new Float32Array([0.5, 0.25]));
	});

	it("rejects a response without embedding data", async () =>
	{
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				Response.json(
					{
						data: [],
					},
				),
			),
		);

		await expect(embeddingService.generateEmbedding("hello", "openai-small")).rejects.toThrow(
			"Unexpected OpenAI embeddings response",
		);
	});
});
