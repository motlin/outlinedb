import {nodeEmbeddings} from "@outlinedb/shared/db";
import * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {and, eq, sql} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {embeddingService, getEmbeddingModel} from "./embeddings.js";
import type {EmbeddingModelKey} from "./embeddings.js";
import {logger} from "./logger.js";
import {nullable} from "../utils/nullable.js";
import {notAMirror, PathBuilder} from "@outlinedb/shared/cache";

export type SearchMode = "vector" | "keyword" | "hybrid";

export interface SearchOptions {
	query: string;
	limit?: number;
	threshold?: number;
	model?: EmbeddingModelKey;
	mode?: SearchMode;
}

export type SearchResult = WorkflowyNode & {
	completed: boolean;
	completedAt: number | null;
	nodeId: string;
	fullPath: string;
	textContent: string;
	distance: number;
};

export class SearchService {
	private readonly database: BetterSQLite3Database<typeof schema>;
	private readonly pathBuilder: PathBuilder;

	constructor(database: BetterSQLite3Database<typeof schema>) {
		this.database = database;
		this.pathBuilder = new PathBuilder(database);
	}

	async search(options: SearchOptions): Promise<SearchResult[]> {
		const {query, limit = 5, mode = "vector"} = options;

		switch (mode) {
			case "vector": {
				return this.searchVector(options);
			}
			case "keyword": {
				return this.searchKeyword(query, limit);
			}
			case "hybrid": {
				return this.searchHybrid(options);
			}
			default: {
				const unknownMode: never = mode;
				throw new Error(`Unknown search mode: ${String(unknownMode)}`);
			}
		}
	}

	private async searchVector(options: SearchOptions): Promise<SearchResult[]> {
		const {query, limit = 5, model = "minilm"} = options;
		const modelConfig = getEmbeddingModel(model);
		const threshold = options.threshold ?? modelConfig.defaultThreshold;

		const queryEmbedding = await embeddingService.generateEmbedding(query, model, {isQuery: true});
		const queryBuffer = Buffer.from(queryEmbedding.buffer);

		const searchResults = this.database
			.select({
				nodeId: nodeEmbeddings.nodeId,
				distance: sql<number>`vec_distance_cosine(${nodeEmbeddings.embedding}, vec_f32(${queryBuffer}))`,
				id: schema.nodeContent.id,
				name: schema.nodeContent.name,
				note: schema.nodeContent.note,
			})
			.from(nodeEmbeddings)
			.innerJoin(
				schema.nodeContent,
				and(eq(nodeEmbeddings.nodeId, schema.nodeContent.id), eq(schema.nodeContent.systemTo, FAR_FUTURE_DATE)),
			)
			.where(
				and(
					eq(nodeEmbeddings.model, model),
					eq(nodeEmbeddings.systemTo, FAR_FUTURE_DATE),
					notAMirror(schema.nodeContent.id),
					sql`vec_distance_cosine(${nodeEmbeddings.embedding}, vec_f32(${queryBuffer})) < ${threshold}`,
				),
			)
			.orderBy(sql`vec_distance_cosine(${nodeEmbeddings.embedding}, vec_f32(${queryBuffer}))`)
			.limit(limit)
			.all();
		logger.logSqlResult("vectorSearch", searchResults);

		return this.enrichResults(searchResults.map((r) => ({nodeId: r.nodeId, distance: r.distance})));
	}

	private searchKeyword(query: string, limit: number): SearchResult[] {
		const ftsResults = this.database.all<{node_id: string; score: number}>(
			sql`SELECT node_id, rank as score FROM node_fts WHERE node_fts MATCH ${query} ORDER BY rank LIMIT ${limit}`,
		);
		logger.logSqlResult("ftsSearch", ftsResults);

		// FTS5 rank is negative (lower = better), convert to distance-like metric
		return this.enrichResults(
			ftsResults.map((r) => ({
				nodeId: r.node_id,
				distance: Math.abs(r.score) / (1 + Math.abs(r.score)),
			})),
		);
	}

	private async searchHybrid(options: SearchOptions): Promise<SearchResult[]> {
		const {query, limit = 5} = options;
		const k = 60; // RRF constant

		// Run vector and FTS5 in parallel
		const vectorResults = await this.searchVector({...options, limit: limit * 3});
		const ftsResults = this.searchKeyword(query, limit * 3);

		// Build RRF scores
		const rrfScores = new Map<string, {score: number; result: SearchResult}>();

		for (const [rank, result] of vectorResults.entries()) {
			const existing = rrfScores.get(result.nodeId);
			const contribution = 1 / (k + rank + 1);
			if (existing) {
				existing.score += contribution;
			} else {
				rrfScores.set(result.nodeId, {score: contribution, result});
			}
		}

		for (const [rank, result] of ftsResults.entries()) {
			const existing = rrfScores.get(result.nodeId);
			const contribution = 1 / (k + rank + 1);
			if (existing) {
				existing.score += contribution;
			} else {
				rrfScores.set(result.nodeId, {score: contribution, result});
			}
		}

		// Sort by RRF score descending, convert to distance (lower = better)
		const sorted = [...rrfScores.values()].toSorted((a, b) => b.score - a.score).slice(0, limit);

		return sorted.map(({result, score}) => ({
			...result,
			distance: 1 - score, // Convert RRF score to distance-like metric
		}));
	}

	private enrichResults(rawResults: {nodeId: string; distance: number}[]): SearchResult[] {
		return rawResults.map((result) => {
			const fullPath = this.pathBuilder.buildFullPath(result.nodeId);
			const textContent = this.pathBuilder.buildTextContent(result.nodeId);

			const nodeWithRelations = this.database.query.nodeContent
				.findFirst({
					where: and(
						eq(schema.nodeContent.id, result.nodeId),
						eq(schema.nodeContent.systemTo, FAR_FUTURE_DATE),
					),
					with: {
						metadata: true,
						aiMetadata: true,
						referencesRoot: true,
					},
				})
				.sync();
			logger.logSqlResult("nodeWithRelations", nodeWithRelations);

			// Drizzle types these one() relations as always present, but a node can lack any of these rows.
			const metadata = nodeWithRelations ? nullable(nodeWithRelations.metadata) : null;
			const priority = metadata?.priority ?? 0;
			const data: Record<string, unknown> = {};

			if (metadata?.layoutMode) {
				data.layoutMode = metadata.layoutMode;
			}

			if (nodeWithRelations?.referencesRoot) {
				data.isReferencesRoot = true;
			}

			if (nodeWithRelations?.aiMetadata) {
				data.ai = {
					inChat: Boolean(nodeWithRelations.aiMetadata.inChat),
				};
			}

			return {
				id: nodeWithRelations?.id ?? result.nodeId,
				name: nodeWithRelations?.name ?? "",
				note: nodeWithRelations?.note,
				priority,
				completed: metadata?.completedAt !== null,
				createdAt: metadata?.createdAt ? Math.floor(metadata.createdAt.getTime() / 1000) : 0,
				modifiedAt: metadata?.modifiedAt ? Math.floor(metadata.modifiedAt.getTime() / 1000) : 0,
				completedAt: metadata?.completedAt ? Math.floor(metadata.completedAt.getTime() / 1000) : null,
				data,
				nodeId: result.nodeId,
				fullPath,
				textContent,
				distance: result.distance,
			};
		});
	}
}
