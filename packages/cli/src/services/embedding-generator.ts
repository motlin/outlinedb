import {mirrors, nodeEmbeddings} from "@outlinedb/shared/db";
import type * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq, inArray, sql} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {DEFAULT_MODELS, embeddingService} from "./embeddings.js";
import type {EmbeddingModelKey} from "./embeddings.js";
import {buildEmbedTexts, loadEmbeddableNodes, newSystemTimestamp, PathBuilder} from "@outlinedb/shared/cache";

/** Delete every embedding, of any model or version, keyed to a current mirror. Returns the count. */
function pruneMirrorEmbeddings(database: BetterSQLite3Database<typeof schema>): number
{
	return database
		.delete(nodeEmbeddings)
		.where(
			inArray(
				nodeEmbeddings.nodeId,
				database
					.select(
						{
							id: mirrors.mirrorId,
						},
					)
					.from(mirrors)
					.where(eq(mirrors.systemTo, FAR_FUTURE_DATE)),
			),
		)
		.run().changes;
}

export interface EmbeddingGeneratorOptions
{
	batchSize: number;
	force: boolean;
	model?: EmbeddingModelKey;
}

export interface EmbeddingGeneratorProgress
{
	processed: number;
	total: number;
	elapsed: number;
	estimatedRemaining: number;
	currentModel: EmbeddingModelKey;
	message?: string;
}

export interface EmbeddingGeneratorResult
{
	totalProcessed: number;
	totalTime: number;
	alreadyComplete: boolean;
	modelStats: Map<
		EmbeddingModelKey,
		{
			needed: number;
			processed: number;
		}
	>;
}

export class EmbeddingGeneratorService
{
	private readonly database: BetterSQLite3Database<typeof schema>;
	private readonly pathBuilder: PathBuilder;

	constructor(database: BetterSQLite3Database<typeof schema>)
	{
		this.database = database;
		this.pathBuilder = new PathBuilder(database);
	}

	async generateEmbeddings(
		options: EmbeddingGeneratorOptions,
		onProgress?: (progress: EmbeddingGeneratorProgress) => void,
	): Promise<EmbeddingGeneratorResult>
	{
		const modelsToProcess: EmbeddingModelKey[] = options.model ? [options.model] : DEFAULT_MODELS;
		const [firstModel] = modelsToProcess;
		if (firstModel === undefined)
		{
			throw new Error("No embedding models to process");
		}

		const pruned = pruneMirrorEmbeddings(this.database);
		if (pruned > 0)
		{
			onProgress?.(
				{
					processed: 0,
					total: 0,
					elapsed: 0,
					estimatedRemaining: 0,
					currentModel: firstModel,
					message: `🧹 Pruned ${pruned} embeddings of mirror nodes`,
				},
			);
		}

		if (options.force)
		{
			for (const model of modelsToProcess)
			{
				this.database
					.delete(nodeEmbeddings)
					.where(and(eq(nodeEmbeddings.model, model), eq(nodeEmbeddings.systemTo, FAR_FUTURE_DATE)))
					.run();
			}
		}

		const nonLeafNodes = loadEmbeddableNodes(this.database, this.pathBuilder);

		// Populate FTS5 index with all non-leaf nodes (independent of model selection)
		this.populateFts(nonLeafNodes, onProgress);

		const nodesToProcessByModel = this.calculateNodesToProcess(modelsToProcess, nonLeafNodes);
		const totalToProcess = [...nodesToProcessByModel.values()].reduce((sum, nodeList) => sum + nodeList.length, 0);

		const modelStats = new Map<
			EmbeddingModelKey,
			{
				needed: number;
				processed: number;
			}
		>();
		for (const model of modelsToProcess)
		{
			const nodes = nodesToProcessByModel.get(model) ?? [];
			modelStats.set(
				model,
				{
					needed: nodes.length,
					processed: 0,
				},
			);
		}

		onProgress?.(
			{
				processed: 0,
				total: totalToProcess,
				elapsed: 0,
				estimatedRemaining: 0,
				currentModel: firstModel,
				message: `📊 ${nonLeafNodes.length} nodes (leaf nodes and mirrors skipped), ${modelsToProcess.length} models. Need embeddings: ${[...modelStats.entries()].map(([m, s]) => `${m}=${s.needed}`).join(", ")}`,
			},
		);

		if (totalToProcess === 0)
		{
			return {
				totalProcessed: 0,
				totalTime: 0,
				alreadyComplete: true,
				modelStats,
			};
		}

		onProgress?.(
			{
				processed: 0,
				total: totalToProcess,
				elapsed: 0,
				estimatedRemaining: 0,
				currentModel: firstModel,
				message: `🤖 Initializing ${modelsToProcess.length === 1 ? `model "${firstModel}"` : "default models"}...`,
			},
		);

		const startTime = Date.now();
		let totalProcessed = 0;

		for (const model of modelsToProcess)
		{
			const nodesToProcess = nodesToProcessByModel.get(model) ?? [];
			const stats = modelStats.get(model);

			if (!stats || nodesToProcess.length === 0)
			{
				continue;
			}

			onProgress?.(
				{
					processed: totalProcessed,
					total: totalToProcess,
					elapsed: (Date.now() - startTime) / 1000,
					estimatedRemaining: 0,
					currentModel: model,
					message: `🔄 Starting ${model}: ${nodesToProcess.length} nodes to process`,
				},
			);

			// Build every document in batch (O(depth) queries instead of O(nodes × depth))
			const texts = buildEmbedTexts(
				this.database,
				nodesToProcess.map((n) => n.id),
				this.pathBuilder,
			);

			for (let index = 0; index < nodesToProcess.length; index += options.batchSize)
			{
				const batch = nodesToProcess.slice(index, index + options.batchSize);
				const embeddingRows:
				{
					nodeId: string;
					model: EmbeddingModelKey;
					embedding: Buffer;
				}[] = [];

				for (const node of batch)
				{
					const combinedText = texts.get(node.id) ?? "";
					const embedding = await embeddingService.generateEmbedding(
						combinedText,
						model,
						{
							isQuery: false,
						},
					);

					embeddingRows.push(
						{
							nodeId: node.id,
							model,
							embedding: Buffer.from(embedding.buffer),
						},
					);

					totalProcessed++;
					stats.processed++;

					if (onProgress && totalProcessed % 10 === 0)
					{
						const elapsed = (Date.now() - startTime) / 1000;
						const rate = totalProcessed / elapsed;
						const remaining = Math.ceil((totalToProcess - totalProcessed) / rate);

						onProgress(
							{
								processed: totalProcessed,
								total: totalToProcess,
								elapsed,
								estimatedRemaining: remaining,
								currentModel: model,
							},
						);
					}
				}

				if (embeddingRows.length > 0)
				{
					const systemFrom = newSystemTimestamp();
					this.database
						.insert(nodeEmbeddings)
						.values(
							embeddingRows.map((row) => (
							{
								...row,
								systemFrom,
								systemTo: FAR_FUTURE_DATE,
							})),
						)
						.run();
				}
			}

			onProgress?.(
				{
					processed: totalProcessed,
					total: totalToProcess,
					elapsed: (Date.now() - startTime) / 1000,
					estimatedRemaining: 0,
					currentModel: model,
					message: `✅ Finished ${model}: ${stats.processed} embeddings generated`,
				},
			);
		}

		const totalTime = (Date.now() - startTime) / 1000;

		return {
			totalProcessed,
			totalTime,
			alreadyComplete: false,
			modelStats,
		};
	}

	private populateFts(
		nonLeafNodes:
		{
			id: string;
			name: string | null;
		}[],
		onProgress?: (progress: EmbeddingGeneratorProgress) => void,
	): void
	{
		const nodeIds = nonLeafNodes.map((n) => n.id);

		// Check if FTS5 table exists
		const tableExists = this.database.all(
			sql`SELECT name FROM sqlite_master WHERE type='table' AND name='node_fts'`,
		);
		if (tableExists.length === 0)
		{
			return;
		}

		const texts = buildEmbedTexts(this.database, nodeIds, this.pathBuilder);

		// Clear and repopulate FTS index
		this.database.run(sql`DELETE FROM node_fts`);

		let populated = 0;
		for (const node of nonLeafNodes)
		{
			const combinedText = texts.get(node.id) ?? "";
			this.database.run(sql`INSERT INTO node_fts(node_id, content) VALUES(${node.id}, ${combinedText})`);
			populated++;
		}

		onProgress?.(
			{
				processed: 0,
				total: 0,
				elapsed: 0,
				estimatedRemaining: 0,
				currentModel: "minilm",
				message: `FTS5 index populated with ${populated} nodes`,
			},
		);
	}

	private calculateNodesToProcess(
		models: EmbeddingModelKey[],
		currentNodes:
		{
			id: string;
		}[],
	): Map<
		EmbeddingModelKey,
		{
			id: string;
		}[]
	>
	{
		const result = new Map<
			EmbeddingModelKey,
			{
				id: string;
			}[]
		>();

		for (const model of models)
		{
			const existingEmbeddings = this.database
				.select(
					{
						nodeId: nodeEmbeddings.nodeId,
					},
				)
				.from(nodeEmbeddings)
				.where(and(eq(nodeEmbeddings.model, model), eq(nodeEmbeddings.systemTo, FAR_FUTURE_DATE)))
				.all();

			const existingIds = new Set(existingEmbeddings.map((embedding) => embedding.nodeId));
			const nodesToProcess = currentNodes.filter((node) => !existingIds.has(node.id));
			result.set(model, nodesToProcess);
		}

		return result;
	}
}
