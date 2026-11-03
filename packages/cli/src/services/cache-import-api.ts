import type {InternalTreeItem} from "@workflowy/shared/api";
import {importFromApi as sharedImportFromApi} from "@workflowy/shared/cache";
import type {ImportApiResult, ImportLogger} from "@workflowy/shared/cache";
import type * as schema from "@workflowy/shared/db";
import type {WorkflowyNode} from "@workflowy/shared/types";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import {logger} from "./logger.js";

export type {ImportApiResult};

function cliImportLogger(verbose: boolean): ImportLogger {
	return {
		debug: (message) => {
			if (verbose) {
				logger.debug(message);
			}
		},
		warn: (message) => {
			console.warn(message);
		},
		error: (message) => {
			console.error(message);
		},
	};
}

/**
 * Import nodes from the Workflowy API export endpoint. The orchestration lives
 * in `@workflowy/shared/cache`; this adds the CLI's logger.
 */
export function importFromApi(
	database: BetterSQLite3Database<typeof schema>,
	apiNodes: WorkflowyNode[],
	verbose = false,
	timestamp?: Date,
	treeItems?: InternalTreeItem[],
	snapshotTakenAt?: Date,
): ImportApiResult {
	return sharedImportFromApi(database, apiNodes, {
		logger: cliImportLogger(verbose),
		timestamp,
		treeItems,
		snapshotTakenAt,
	});
}
