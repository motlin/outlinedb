import {backupImports, nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, count, desc, eq, isNotNull, isNull, max} from "drizzle-orm";
import {z} from "zod";
import {defineOp, ok} from "./define.js";

/**
 * Live node counts, when the cache last took a change (ISO, or null when it holds no nodes) and the newest imported
 * backup's date, as the CLI's `cache status` reports them.
 */
export const cacheStatus = defineOp({
	input: z.object({}),
	output: z.strictObject({
		totalNodes: z.number(),
		rootNodes: z.number(),
		completedNodes: z.number(),
		lastSync: z.string().nullable(),
		lastBackupImport: z.string().nullable(),
	}),
	run({db}) {
		const live = eq(nodeContent.systemTo, FAR_FUTURE_DATE);
		const nodes = db
			.select({total: count(), lastChange: max(nodeContent.systemFrom)})
			.from(nodeContent)
			.where(live)
			.get();
		const roots = db
			.select({count: count()})
			.from(nodeContent)
			.where(and(live, isNull(nodeContent.parentId)))
			.get();
		const completed = db
			.select({count: count()})
			.from(nodeMetadata)
			.where(and(eq(nodeMetadata.systemTo, FAR_FUTURE_DATE), isNotNull(nodeMetadata.completedAt)))
			.get();
		const lastImport = db
			.select({backupDate: backupImports.backupDate})
			.from(backupImports)
			.where(eq(backupImports.systemTo, FAR_FUTURE_DATE))
			.orderBy(desc(backupImports.backupDate))
			.limit(1)
			.get();
		const lastChange = nodes?.lastChange ?? null;
		return ok({
			totalNodes: nodes?.total ?? 0,
			rootNodes: roots?.count ?? 0,
			completedNodes: completed?.count ?? 0,
			// systemFrom is SQLite's UTC "YYYY-MM-DD HH:MM:SS[.fff]".
			lastSync: lastChange === null ? null : new Date(`${lastChange.replace(" ", "T")}Z`).toISOString(),
			lastBackupImport: lastImport?.backupDate ?? null,
		});
	},
});
