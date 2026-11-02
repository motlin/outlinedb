import {countStrandedRows} from "@outlinedb/shared/cache";
import type {StrandedRowCounts} from "@outlinedb/shared/cache";
import {backupImports, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import type * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, count, desc, eq, isNotNull, isNull} from "drizzle-orm";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {formatBytes} from "./cache-vacuum.js";
import {logger} from "./logger.js";
import {nonEmpty} from "../utils/non-empty.js";
import {DEFAULT_DB_FILE} from "../db/default-db-file.js";

export interface CacheStatus
{
	nodes:
	{
		total: number;
		root: number;
		completed: number;
	};
	lastSync: Date | null;
	lastBackupImport: string | null;
	/** Relationship rows a delete or import left behind; all zero when the cache matches upstream. */
	stranded: StrandedRowCounts;
	database:
	{
		path: string;
		size: string;
	};
}

export class CacheStatusService
{
	private readonly database: BetterSQLite3Database<typeof schema>;

	constructor(database: BetterSQLite3Database<typeof schema>)
	{
		this.database = database;
	}

	getStatus(): CacheStatus
	{
		const nodeStats = this.getNodeStats();
		const lastSync = this.getLastSync();
		const lastBackupImport = this.getLastImportDate();

		const dbPath = path.resolve(nonEmpty(process.env.OUTLINEDB_DB_PATH) ?? DEFAULT_DB_FILE);
		const dbSize = this.getDatabaseSize(dbPath);

		return {
			nodes: nodeStats,
			lastSync,
			lastBackupImport,
			stranded: countStrandedRows(this.database),
			database:
			{
				path: dbPath,
				size: dbSize,
			},
		};
	}

	private getNodeStats():
	{
		total: number;
		root: number;
		completed: number;
	}
	{
		const totalNodesResult = this.database
			.select(
				{
					count: count(),
				},
			)
			.from(nodeContent)
			.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
			.get();
		logger.logSqlResult("getNodeStats.total", totalNodesResult);
		const totalNodes = totalNodesResult?.count ?? 0;

		const completedNodesResult = this.database
			.select(
				{
					count: count(),
				},
			)
			.from(nodeMetadata)
			.where(and(isNotNull(nodeMetadata.completedAt), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)))
			.get();
		logger.logSqlResult("getNodeStats.completed", completedNodesResult);
		const completedNodes = completedNodesResult?.count ?? 0;

		const rootNodesResult = this.database
			.select(
				{
					count: count(),
				},
			)
			.from(nodeContent)
			.where(and(isNull(nodeContent.parentId), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get();
		logger.logSqlResult("getNodeStats.root", rootNodesResult);
		const rootNodes = rootNodesResult?.count ?? 0;

		return {
			total: totalNodes,
			root: rootNodes,
			completed: completedNodes,
		};
	}

	private getLastSync(): Date | null
	{
		const result = this.database
			.select(
				{
					systemFrom: nodeContent.systemFrom,
				},
			)
			.from(nodeContent)
			.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
			.orderBy(desc(nodeContent.systemFrom))
			.limit(1)
			.get();
		logger.logSqlResult("getLastSync", result);

		if (!result)
		{
			return null;
		}

		return new Date(`${result.systemFrom.replace(" ", "T")}Z`);
	}

	private getDatabaseSize(dbPath: string): string
	{
		if (!fs.existsSync(dbPath))
		{
			return "0 KB";
		}

		return formatBytes(fs.statSync(dbPath).size);
	}

	getLastImportDate(): string | null
	{
		const lastImport = this.database
			.select(
				{
					backupDate: backupImports.backupDate,
				},
			)
			.from(backupImports)
			.where(eq(backupImports.systemTo, FAR_FUTURE_DATE))
			.orderBy(desc(backupImports.backupDate))
			.limit(1)
			.get();
		logger.logSqlResult("getLastImportDate", lastImport);

		return lastImport?.backupDate ?? null;
	}
}
