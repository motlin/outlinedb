import {CacheService} from "@outlinedb/shared/cache";
import * as dbSchema from "@outlinedb/shared/db";
import {MemoryEmbeddingIndex} from "@outlinedb/web/server-app";
import {drizzle} from "drizzle-orm/durable-sqlite";
import type {Embedder} from "../src/embeddings";
import {UserStore} from "../src/user-store";
import worker from "../src/worker";

const LIVE = "9999-12-31 23:59:59";

/** A deterministic vector per text: letter counts, plus one so no vector is all zeros. */
function letterVector(text: string): number[] {
	const counts: number[] = Array.from({length: 27}, (_, index) => (index === 26 ? 1 : 0));
	for (const char of text.toLowerCase()) {
		const code = (char.codePointAt(0) ?? 0) - 97;
		if (code >= 0 && code < 26) {
			counts[code] = (counts[code] ?? 0) + 1;
		}
	}
	return counts;
}

/** A UserStore with an in-memory index and embedder in place of Vectorize and Workers AI, which Miniflare lacks. */
export class EmbeddingProbeStore extends UserStore {
	private readonly memoryIndex = new MemoryEmbeddingIndex();
	private readonly embedded: string[][] = [];

	protected override embeddingBindings(): {index: MemoryEmbeddingIndex; embedder: Embedder} {
		return {
			index: this.memoryIndex,
			embedder: {
				embed: (texts) => {
					this.embedded.push(texts);
					return texts.map((text) => letterVector(text));
				},
			},
		};
	}

	/** Miniflare has no internal API to write root metadata through, so the status is written to the cache only. */
	protected override markEmbeddingsFinished(): void {
		this.ctx.storage.sql.exec(
			"UPDATE root_preferences SET ai_embedding_status = 'finished' WHERE system_to = ?",
			LIVE,
		);
	}

	override fetch(request: Request): Response {
		const url = new URL(request.url);
		const sql = this.ctx.storage.sql;
		if (url.pathname === "/__node") {
			const parent = url.searchParams.get("parent");
			new CacheService(drizzle(this.ctx.storage, {schema: dbSchema})).insertNode(
				{
					id: url.searchParams.get("id") ?? "",
					name: url.searchParams.get("name") ?? "",
					note: null,
					parent_id: parent,
					priority: 0,
					createdAt: 1,
					modifiedAt: 1,
				},
				parent,
			);
			return Response.json({ok: true});
		}
		if (url.pathname === "/__ai-status") {
			sql.exec(
				"INSERT INTO root_preferences (user_id, ai_embedding_status, system_from, system_to) VALUES (1, ?, ?, ?)",
				url.searchParams.get("value"),
				"2026-01-01 00:00:00.000",
				LIVE,
			);
			return Response.json({ok: true});
		}
		if (url.pathname === "/__embeddings") {
			return Response.json({
				status:
					sql
						.exec("SELECT ai_embedding_status AS s FROM root_preferences WHERE system_to = ?", LIVE)
						.toArray()[0]?.s ?? null,
				indexed: [...this.memoryIndex.vectors.keys()].toSorted(),
				batches: this.embedded.map((texts) => texts.length),
			});
		}
		return super.fetch(request);
	}
}

export default worker;
