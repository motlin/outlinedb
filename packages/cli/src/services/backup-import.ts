import {BackupFileSchema} from "@outlinedb/shared/schemas";
import type {createDatabase} from "../db/index.js";
import {CacheService} from "./cache.js";
import type {BackupSystemTime} from "./cache-import.js";
import {EmbeddingGeneratorService} from "./embedding-generator.js";
import {readBackupFile} from "../utils/backup-archive.js";
import path from "node:path";

export interface BackupImportStats
{
	totalNodes: number;
	nodesAdded: number;
	nodesUpdated: number;
	nodesUnchanged: number;
	nodesDeleted: number;
	nodesPhasedOut: number;
	contentUpdated: number;
	metadataUpdated: number;
	priorityUpdated: number;
	importTimestamp: Date;
	nodesPreserved: number;
	nodesKeptDeleted: number;
	skipped?: boolean;
	skipReason?: string;
	localWatermark?: string | null;
	incomingWatermark?: string | null;
}

export interface BackupFileNode
{
	ch?: BackupFileNode[];
}

export interface BackupImportProgress
{
	phase: "parsing" | "importing" | "embeddings";
	current: number;
	total: number;
	message?: string;
}

export interface BackupImportOptions
{
	filePath: string;
	generateEmbeddings?: boolean;
	embeddingBatchSize?: number;
	force?: boolean;
	/** Stamp the import from the backup instead of the clock (historical replay). */
	systemTime?: BackupSystemTime;
	onProgress?: (progress: BackupImportProgress) => void;
}

export class BackupImportService
{
	private readonly database: ReturnType<typeof createDatabase>;
	private readonly cacheService: CacheService;

	constructor(database: ReturnType<typeof createDatabase>)
	{
		this.database = database;
		this.cacheService = new CacheService(database);
	}

	async importBackup(options: BackupImportOptions): Promise<BackupImportStats>
	{
		const
		{
			filePath,
			generateEmbeddings = false,
			embeddingBatchSize = 20,
			force = false,
			systemTime,
			onProgress,
		} = options;

		const fileContent = readBackupFile(filePath);
		const rootNodes = BackupFileSchema.parse(JSON.parse(fileContent));

		const nodeCount = this.countNodes(rootNodes);
		onProgress?.(
			{
				phase: "parsing",
				current: nodeCount,
				total: nodeCount,
			},
		);

		onProgress?.(
			{
				phase: "importing",
				current: 0,
				total: nodeCount,
				message: "Processing nodes...",
			},
		);

		const filename = path.basename(filePath);
		const stats = await this.cacheService.importBackup(filePath, filename, false, force, systemTime);

		if (generateEmbeddings && !stats.skipped)
		{
			await this.generateEmbeddingsForImport(embeddingBatchSize, onProgress);
		}

		return stats;
	}

	countNodes(rootNodes: BackupFileNode[]): number
	{
		let count = rootNodes.length;
		for (const node of rootNodes)
		{
			if (node.ch)
			{
				count += this.countNodes(node.ch);
			}
		}
		return count;
	}

	private async generateEmbeddingsForImport(
		batchSize: number,
		onProgress?: (progress: BackupImportProgress) => void,
	): Promise<void>
	{
		const embeddingGenerator = new EmbeddingGeneratorService(this.database);
		const result = await embeddingGenerator.generateEmbeddings(
			{
				batchSize,
				force: false,
			},
			(progress) =>
			{
				onProgress?.(
					{
						phase: "embeddings",
						current: progress.processed,
						total: progress.total,
						message:
							progress.message ?? `[${progress.currentModel}] ${progress.processed}/${progress.total}`,
					},
				);
			},
		);

		onProgress?.(
			{
				phase: "embeddings",
				current: result.totalProcessed,
				total: result.totalProcessed,
				message: `Generated embeddings for ${result.totalProcessed} nodes across all models`,
			},
		);
	}
}
