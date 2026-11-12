import type {Awaitable, EmbeddingIndex} from "@outlinedb/web/server-app";

/**
 * The Workers AI model: Qwen3-Embedding-0.6B, the strongest embedding model Workers AI hosts. It returns 1024
 * dimensions, already unit length, from an 8,192-token context. Texts go in as `text`, which the model embeds like
 * `documents`, with no instruction; related notes compares stored note vectors with each other, so both sides of every
 * similarity are embedded the same way. (`queries` would prepend a web-search instruction and skew note-to-note scores.)
 */
const CF_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

/** The most ids one Vectorize mutation takes. */
const MUTATION_BATCH = 1000;

/** The Vectorize calls the index makes, so tests can pass a plain object; mutation results are not read. */
export interface VectorizeBinding
{
	getByIds(ids: string[]): Awaitable<VectorizeVector[]>;
	query(vector: number[], options: VectorizeQueryOptions): Awaitable<VectorizeMatches>;
	upsert(vectors: VectorizeVector[]): Awaitable<unknown>;
	deleteByIds(ids: string[]): Awaitable<unknown>;
}

/** The Workers AI call the embedder makes. */
export interface AiBinding
{
	run(
		model: typeof CF_EMBEDDING_MODEL,
		input:
		{
			text: string[];
		},
	): Awaitable<unknown>;
}

/** Turns documents into vectors, one per text, in order. */
export interface Embedder
{
	embed(texts: string[]): Awaitable<number[][]>;
}

/**
 * Vectorize as the related-notes index. Every vector of this account lives in `namespace`, so queries never return
 * another account's nodes. Vectorize scores cosine similarity; `1 - score` is the distance `relatedFind` thresholds.
 */
export function vectorizeIndex(binding: VectorizeBinding, namespace: string): EmbeddingIndex
{
	return {
		async vectorFor(nodeId)
		{
			const [stored] = await binding.getByIds([nodeId]);
			return stored === undefined ? undefined : [...stored.values];
		},
		async query(vector, topK)
		{
			const {matches} = await binding.query(
				vector,
				{
					topK,
					namespace,
				},
			);
			return matches.map((match) => (
			{
				id: match.id,
				distance: 1 - match.score,
			}));
		},
		async upsert(rows)
		{
			for (let start = 0; start < rows.length; start += MUTATION_BATCH)
			{
				await binding.upsert(
					rows.slice(start, start + MUTATION_BATCH).map((row) => (
					{
						id: row.id,
						values: row.vector,
						namespace,
					})),
				);
			}
		},
		async delete(ids)
		{
			for (let start = 0; start < ids.length; start += MUTATION_BATCH)
			{
				await binding.deleteByIds(ids.slice(start, start + MUTATION_BATCH));
			}
		},
	};
}

function vectorsOf(response: unknown): unknown[] | undefined
{
	if (typeof response !== "object" || response === null || !("data" in response))
	{
		return undefined;
	}
	return Array.isArray(response.data) ? response.data : undefined;
}

function isVector(value: unknown): value is number[]
{
	return Array.isArray(value) && value.every((n) => typeof n === "number");
}

/** Workers AI Qwen3-Embedding as the embedder: one model call per batch of texts. */
export function workersAiEmbedder(ai: AiBinding): Embedder
{
	return {
		async embed(texts)
		{
			const data =
				vectorsOf(
					await ai.run(
						CF_EMBEDDING_MODEL,
						{
							text: texts,
						},
					),
				) ?? [];
			if (data.length !== texts.length || !data.every(isVector))
			{
				throw new Error(`Workers AI returned ${data.length} vectors for ${texts.length} texts`);
			}
			return data;
		},
	};
}
