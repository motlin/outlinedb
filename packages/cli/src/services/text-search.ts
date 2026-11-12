import {CacheService, PathBuilder} from "@outlinedb/shared/cache";
import type {TextSearchOptions} from "@outlinedb/shared/cache";
import type * as schema from "@outlinedb/shared/db";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {logger} from "./logger.js";

export type {TextSearchOptions};

export interface TextSearchResult
{
	shortId: string | null;
	name: string | null;
	note: string | null;
	path: string;
}

export class TextSearchService
{
	private readonly cacheService: CacheService;
	private readonly pathBuilder: PathBuilder;

	constructor(database: BetterSQLite3Database<typeof schema>)
	{
		this.cacheService = new CacheService(database);
		this.pathBuilder = new PathBuilder(database);
	}

	search(options: TextSearchOptions): TextSearchResult[]
	{
		const rows = this.cacheService.searchText(options);
		logger.logSqlResult("textSearch", rows);

		if (rows.length === 0)
		{
			return [];
		}

		const pathMap = this.pathBuilder.buildFullPathsBatch(rows.map((r) => r.id));

		return rows.map((row) => (
		{
			shortId: row.shortId,
			name: row.name,
			note: row.note,
			path: pathMap.get(row.id) ?? "",
		}));
	}
}
