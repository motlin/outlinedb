import {CacheService as BaseCacheService} from "@outlinedb/shared/cache";
import type {Node} from "@outlinedb/shared/types";
import {importBackup} from "./cache-import.js";
import type {BackupSystemTime, ImportBackupResult} from "./cache-import.js";
import {logger} from "./logger.js";

/**
 * CLI-specific CacheService that extends the shared CacheService with
 * backup import functionality. This functionality requires Node.js fs
 * module, so it cannot be included in the shared package.
 */
export class CacheService extends BaseCacheService {
	/**
	 * Import nodes from a Workflowy backup file
	 * @param filePath Path to the backup JSON file
	 * @param backupImportFilename Filename of the backup being imported
	 * @param verbose Show detailed timing information
	 * @param force Bypass the stale-snapshot watermark guard
	 * @param systemTime Stamp the import from the backup instead of the clock
	 */
	async importBackup(
		filePath: string,
		backupImportFilename: string,
		verbose = false,
		force = false,
		systemTime?: BackupSystemTime,
	): Promise<ImportBackupResult> {
		return importBackup(this.database, filePath, backupImportFilename, verbose, systemTime, force);
	}

	getNode(nodeId: string): Node | undefined {
		const result = super.getNode(nodeId);
		logger.logSqlResult("getNode", result);
		return result;
	}

	getChildren(parentId: string | null): Node[] {
		const results = super.getChildren(parentId);
		logger.logSqlResult("getChildren", results);
		return results;
	}

	getChildrenWithMergedData(
		parentId: string | null,
	): Awaited<ReturnType<BaseCacheService["getChildrenWithMergedData"]>> {
		const result = super.getChildrenWithMergedData(parentId);
		logger.logSqlResult("getChildrenWithMergedData", result);
		return result;
	}

	getChildrenForMultipleParents(
		parentIds: string[],
	): Awaited<ReturnType<BaseCacheService["getChildrenForMultipleParents"]>> {
		const result = super.getChildrenForMultipleParents(parentIds);
		logger.logSqlResult("getChildrenForMultipleParents", result);
		return result;
	}

	getMirrorOriginal(nodeId: string) {
		const result = super.getMirrorOriginal(nodeId);
		logger.logSqlResult("getMirrorOriginal", result);
		return result;
	}
}
