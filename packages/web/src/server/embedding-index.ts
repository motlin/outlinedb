import {newSystemTimestamp} from "@outlinedb/shared/cache";
import {nodeEmbeddings} from "@outlinedb/shared/db";
import type {AppDatabase} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq, inArray, sql} from "drizzle-orm";

/** A stored vector's neighbour: cosine distance, so 0 is identical and the related panel's threshold reads the same everywhere. */
export interface EmbeddingNeighbour {
	id: string;
	distance: number;
}

/** A value a sync implementation returns directly and a remote one as a promise. */
export type Awaitable<T> = T | Promise<T>;

export interface EmbeddingRow {
	id: string;
	vector: number[];
}

/**
 * Where node vectors live and how their nearest neighbours are found: sqlite-vec on the Node server, Vectorize on
 * the Worker. `relatedFind` asks the index for neighbours and filters them against the node tables itself.
 */
export interface EmbeddingIndex {
	/** The node's stored vector, or undefined when it has none. */
	vectorFor(nodeId: string): Awaitable<number[] | undefined>;
	/** Up to `topK` stored vectors nearest to `vector`, nearest first. */
	query(vector: number[], topK: number): Awaitable<EmbeddingNeighbour[]>;
	upsert(rows: EmbeddingRow[]): Awaitable<void>;
	delete(ids: string[]): Awaitable<void>;
}

function toBlob(vector: number[]): Buffer {
	return Buffer.from(new Float32Array(vector).buffer);
}

function fromBlob(blob: Buffer): number[] {
	return [...new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT)];
}

/** The Node server's index: one model's current `node_embeddings` rows, ranked by sqlite-vec. */
export class SqliteVecIndex implements EmbeddingIndex {
	constructor(
		private readonly database: AppDatabase,
		private readonly model: string,
	) {}

	private current() {
		return and(eq(nodeEmbeddings.model, this.model), eq(nodeEmbeddings.systemTo, FAR_FUTURE_DATE));
	}

	vectorFor(nodeId: string): number[] | undefined {
		const row = this.database
			.select({embedding: nodeEmbeddings.embedding})
			.from(nodeEmbeddings)
			.where(and(eq(nodeEmbeddings.nodeId, nodeId), this.current()))
			.get();
		return row === undefined ? undefined : fromBlob(row.embedding);
	}

	query(vector: number[], topK: number): EmbeddingNeighbour[] {
		const distance = sql<number>`vec_distance_cosine(${nodeEmbeddings.embedding}, vec_f32(${toBlob(vector)}))`;
		return this.database
			.select({id: nodeEmbeddings.nodeId, distance})
			.from(nodeEmbeddings)
			.where(this.current())
			.orderBy(distance)
			.limit(topK)
			.all();
	}

	upsert(rows: EmbeddingRow[]): void {
		if (rows.length === 0) {
			return;
		}
		const systemFrom = newSystemTimestamp();
		this.database.transaction((tx) => {
			this.closeCurrent(
				tx,
				rows.map((row) => row.id),
				systemFrom,
			);
			tx.insert(nodeEmbeddings)
				.values(
					rows.map((row) => ({
						nodeId: row.id,
						model: this.model,
						embedding: toBlob(row.vector),
						systemFrom,
						systemTo: FAR_FUTURE_DATE,
					})),
				)
				.run();
		});
	}

	delete(ids: string[]): void {
		if (ids.length > 0) {
			this.closeCurrent(this.database, ids, newSystemTimestamp());
		}
	}

	/** Close the current versions of `ids` at `systemTime`; a version opened at that same instant goes instead. */
	private closeCurrent(database: Pick<AppDatabase, "delete" | "update">, ids: string[], systemTime: string): void {
		const live = and(this.current(), inArray(nodeEmbeddings.nodeId, ids));
		database
			.delete(nodeEmbeddings)
			.where(and(live, sql`${nodeEmbeddings.systemFrom} >= ${systemTime}`))
			.run();
		database.update(nodeEmbeddings).set({systemTo: systemTime}).where(live).run();
	}
}

function cosineDistance(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const [index, value] of a.entries()) {
		const other = b[index] ?? 0;
		dot += value * other;
		normA += value * value;
		normB += other * other;
	}
	return normA === 0 || normB === 0 ? 1 : 1 - dot / Math.sqrt(normA * normB);
}

/** An index held in memory, ranked by brute-force cosine distance: tests and hosts without a vector store. */
export class MemoryEmbeddingIndex implements EmbeddingIndex {
	readonly vectors = new Map<string, number[]>();

	vectorFor(nodeId: string): number[] | undefined {
		return this.vectors.get(nodeId);
	}

	query(vector: number[], topK: number): EmbeddingNeighbour[] {
		return [...this.vectors]
			.map(([id, stored]) => ({id, distance: cosineDistance(vector, stored)}))
			.toSorted((a, b) => a.distance - b.distance)
			.slice(0, topK);
	}

	upsert(rows: EmbeddingRow[]): void {
		for (const row of rows) {
			this.vectors.set(row.id, row.vector);
		}
	}

	delete(ids: string[]): void {
		for (const id of ids) {
			this.vectors.delete(id);
		}
	}
}
