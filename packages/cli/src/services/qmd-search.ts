import * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {existsSync, mkdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {createHash} from "node:crypto";
import {createStore} from "@tobilu/qmd";
import type
{
	EmbedProgress,
	EmbedResult,
	HybridQueryResult,
	SearchResult as QmdSearchResult,
	QMDStore,
} from "@tobilu/qmd";
import {buildEmbedTexts, loadEmbeddableNodes, PathBuilder} from "@outlinedb/shared/cache";
import {logger} from "./logger.js";
import {nullable} from "../utils/nullable.js";

function hashContent(content: string): string
{
	return createHash("sha256").update(content).digest("hex");
}

const COLLECTION_NAME = "outlinedb";
const QMD_DB_DIR = ".cache/qmd";
const QMD_DB_FILE = "outlinedb.sqlite";

export type QmdSearchMode = "hybrid" | "vector" | "keyword";

export interface QmdSearchOptions
{
	query: string;
	limit?: number;
	minScore?: number;
	mode?: QmdSearchMode;
}

export interface QmdSyncResult
{
	inserted: number;
	updated: number;
	unchanged: number;
	deactivated: number;
	totalTime: number;
}

export interface QmdSearchResultItem
{
	id: string;
	name: string;
	note: string | null | undefined;
	priority: number;
	completed: boolean;
	createdAt: number;
	modifiedAt: number;
	completedAt: number | null;
	data: Record<string, unknown>;
	nodeId: string;
	fullPath: string;
	textContent: string;
	score: number;
}

function extractNodeId(virtualPath: string): string
{
	// qmd virtual paths are like: qmd://outlinedb/node-uuid
	const prefix = `qmd://${COLLECTION_NAME}/`;
	if (virtualPath.startsWith(prefix))
	{
		return virtualPath.slice(prefix.length);
	}
	return virtualPath;
}

export class QmdSearchService
{
	private readonly database: BetterSQLite3Database<typeof schema>;
	private readonly pathBuilder: PathBuilder;
	private store: QMDStore | null = null;

	constructor(database: BetterSQLite3Database<typeof schema>)
	{
		this.database = database;
		this.pathBuilder = new PathBuilder(database);
	}

	private getDbPath(): string
	{
		return join(QMD_DB_DIR, QMD_DB_FILE);
	}

	private async getStore(): Promise<QMDStore>
	{
		if (this.store)
		{
			return this.store;
		}

		const dbPath = this.getDbPath();
		const dir = dirname(dbPath);
		if (!existsSync(dir))
		{
			mkdirSync(
				dir,
				{
					recursive: true,
				},
			);
		}

		this.store = await createStore(
			{
				dbPath,
				config:
				{
					collections:
					{
						[COLLECTION_NAME]:
						{
							path: "/virtual/outlinedb",
							pattern: "**/*",
						},
					},
				},
			},
		);

		return this.store;
	}

	async syncNodes(onProgress?: (message: string) => void): Promise<QmdSyncResult>
	{
		const startTime = Date.now();
		const store = await this.getStore();
		const {internal} = store;

		// Mirror documents left by earlier syncs are no longer processed, so they
		// are deactivated below.
		const nonLeafNodes = loadEmbeddableNodes(this.database, this.pathBuilder);

		onProgress?.(`Found ${nonLeafNodes.length} non-leaf nodes (leaf nodes and mirrors skipped)`);

		const nodeIds = nonLeafNodes.map((n) => n.id);
		const texts = buildEmbedTexts(this.database, nodeIds, this.pathBuilder);

		let inserted = 0;
		let updated = 0;
		let unchanged = 0;
		const now = new Date().toISOString();
		const processedPaths = new Set<string>();

		for (const [i, node] of nonLeafNodes.entries())
		{
			const combinedText = texts.get(node.id) ?? "";

			const nodePath = node.id;
			processedPaths.add(nodePath);
			const nodeName = node.name ?? "";

			const hash = hashContent(combinedText);

			const existing = internal.findActiveDocument(COLLECTION_NAME, nodePath);

			if (existing)
			{
				if (existing.hash === hash)
				{
					unchanged++;
					continue;
				}

				internal.insertContent(hash, combinedText, now);
				internal.updateDocument(existing.id, nodeName, hash, now);
				updated++;
			}
			else
			{
				internal.insertContent(hash, combinedText, now);
				internal.insertDocument(COLLECTION_NAME, nodePath, nodeName, hash, now, now);
				inserted++;
			}

			if ((i + 1) % 100 === 0)
			{
				onProgress?.(`Synced ${i + 1}/${nonLeafNodes.length} nodes...`);
			}
		}

		const activePaths = internal.getActiveDocumentPaths(COLLECTION_NAME);
		let deactivated = 0;
		for (const path of activePaths)
		{
			if (!processedPaths.has(path))
			{
				internal.deactivateDocument(COLLECTION_NAME, path);
				deactivated++;
			}
		}

		const totalTime = (Date.now() - startTime) / 1000;

		logger.debug(
			`qmd sync: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged, ${deactivated} deactivated in ${totalTime.toFixed(1)}s`,
		);

		return {
			inserted,
			updated,
			unchanged,
			deactivated,
			totalTime,
		};
	}

	async embed(
		options?:
		{
			force?: boolean;
		},
		onProgress?: (info: EmbedProgress) => void,
	): Promise<EmbedResult>
	{
		const store = await this.getStore();
		return store.embed(
			{
				force: options?.force,
				onProgress,
			},
		);
	}

	async search(options: QmdSearchOptions): Promise<QmdSearchResultItem[]>
	{
		const {query, limit = 5, minScore, mode = "hybrid"} = options;
		const store = await this.getStore();

		let rawResults:
		{
			nodeId: string;
			score: number;
		}[];

		switch (mode)
		{
			case "hybrid":
			{
				const results: HybridQueryResult[] = await store.search(
					{
						query,
						limit,
						minScore,
						collection: COLLECTION_NAME,
					},
				);
				rawResults = results.map((r) => (
				{
					nodeId: extractNodeId(r.file),
					score: r.score,
				}));
				break;
			}

			case "keyword":
			{
				const results: QmdSearchResult[] = await store.searchLex(
					query,
					{
						limit,
						collection: COLLECTION_NAME,
					},
				);
				rawResults = results.map((r) => (
				{
					nodeId: extractNodeId(r.filepath),
					score: r.score,
				}));
				break;
			}

			case "vector":
			{
				const results: QmdSearchResult[] = await store.searchVector(
					query,
					{
						limit,
						collection: COLLECTION_NAME,
					},
				);
				rawResults = results.map((r) => (
				{
					nodeId: extractNodeId(r.filepath),
					score: r.score,
				}));
				break;
			}
		}

		return this.enrichResults(rawResults);
	}

	async close(): Promise<void>
	{
		if (this.store)
		{
			await this.store.close();
			this.store = null;
		}
	}

	private enrichResults(
		rawResults:
		{
			nodeId: string;
			score: number;
		}[],
	): QmdSearchResultItem[]
	{
		const enriched: QmdSearchResultItem[] = [];

		for (const raw of rawResults)
		{
			const {nodeId} = raw;

			const fullPath = this.pathBuilder.buildFullPath(nodeId);
			const textContent = this.pathBuilder.buildTextContent(nodeId);

			const nodeWithRelations = this.database.query.nodeContent
				.findFirst(
					{
						where: and(eq(schema.nodeContent.id, nodeId), eq(schema.nodeContent.systemTo, FAR_FUTURE_DATE)),
						with:
						{
							metadata: true,
							aiMetadata: true,
							referencesRoot: true,
						},
					},
				)
				.sync();

			if (!nodeWithRelations)
			{
				continue;
			}

			// Drizzle types these one() relations as always present, but a node can lack any of these rows.
			const metadata = nullable(nodeWithRelations.metadata);
			const referencesRoot = nullable(nodeWithRelations.referencesRoot);
			const aiMetadata = nullable(nodeWithRelations.aiMetadata);

			const priority = metadata?.priority ?? 0;
			const data: Record<string, unknown> = {};

			if (metadata?.layoutMode)
			{
				data.layoutMode = metadata.layoutMode;
			}

			if (referencesRoot != null)
			{
				data.isReferencesRoot = true;
			}

			if (aiMetadata != null)
			{
				data.ai =
				{
					inChat: Boolean(aiMetadata.inChat),
				};
			}

			enriched.push(
				{
					id: nodeWithRelations.id,
					name: nodeWithRelations.name ?? "",
					note: nodeWithRelations.note,
					priority,
					completed: metadata?.completedAt !== null,
					createdAt: metadata?.createdAt ? Math.floor(metadata.createdAt.getTime() / 1000) : 0,
					modifiedAt: metadata?.modifiedAt ? Math.floor(metadata.modifiedAt.getTime() / 1000) : 0,
					completedAt: metadata?.completedAt ? Math.floor(metadata.completedAt.getTime() / 1000) : null,
					data,
					nodeId,
					fullPath,
					textContent,
					score: raw.score,
				},
			);
		}

		return enriched;
	}
}
