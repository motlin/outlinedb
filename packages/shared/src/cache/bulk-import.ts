import {and, eq, getTableName, gt, max} from "drizzle-orm";
import {apiImportTimestamp} from "../db/schema.js";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "../temporal/constants.js";
import {stampImportTime} from "./account-store.js";
import type {UnitOfWork} from "./node-composite.js";
import {runUnitOfWork} from "./node-composite.js";
import {syncNodeTags} from "./node-tags.js";
import {assertWithinTransactionTimeout, BULK_IMPORT_TIMEOUT_MS, startUnitOfWork} from "./system-time.js";
import {closeCurrentVersions, SameMillisecondOverwriteError} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** The `api_import_timestamp` name of an in-flight bulk import's lease; its timestamp is when the lease expires. */
export const BULK_IMPORT_LEASE_NAME = "bulk_import";

/**
 * Run a whole-snapshot import (a backup or an API export) as one atomic unit of
 * work under one system time, allowed {@link BULK_IMPORT_TIMEOUT_MS} instead of
 * the transaction timeout. First it commits a lease in `api_import_timestamp`
 * so change-feed watermarks stop before the lease while the import runs (see
 * {@link bulkImportLeaseStart}); the import's rows are stamped after it. The
 * transaction takes the write lock before reading the clock, so nothing commits
 * with a later stamp before the import does. The lease ends when the import
 * commits or fails, and expires on its own if the process dies.
 * `work` gets the unit and its system time as a Date. `systemTime` overrides
 * the stamp (replays of old backups, tests).
 */
export function runBulkUnitOfWork<T>(
	database: TemporalTransaction,
	work: (unitOfWork: UnitOfWork, at: Date) => T,
	systemTime?: Date,
): T {
	const lease = startUnitOfWork();
	runUnitOfWork(
		database,
		(unitOfWork) => {
			// A lease that began, and so ended, in this millisecond: a second bulk import in it would overwrite that history.
			const earlier = unitOfWork.tx
				.select({name: apiImportTimestamp.name})
				.from(apiImportTimestamp)
				.where(
					and(
						eq(apiImportTimestamp.name, BULK_IMPORT_LEASE_NAME),
						eq(apiImportTimestamp.systemFrom, unitOfWork.systemTime),
					),
				)
				.get();
			if (earlier !== undefined) {
				throw new SameMillisecondOverwriteError(
					getTableName(apiImportTimestamp),
					`name=${BULK_IMPORT_LEASE_NAME}`,
					unitOfWork.systemTime,
				);
			}
			stampImportTime(unitOfWork, BULK_IMPORT_LEASE_NAME, lease.startedAt + BULK_IMPORT_TIMEOUT_MS);
		},
		lease,
	);
	try {
		return database.transaction(
			(tx) => {
				const at = systemTime ?? new Date(Date.now());
				const start = {systemTime: formatTemporalTimestamp(at), startedAt: lease.startedAt};
				const result = work({tx, systemTime: start.systemTime}, at);
				syncNodeTags(tx, start.systemTime);
				assertWithinTransactionTimeout(start, BULK_IMPORT_TIMEOUT_MS);
				return result;
			},
			{behavior: "immediate"},
		);
	} finally {
		// A lease ending in the millisecond it began would leave an empty interval, so it ends a millisecond later.
		const end = startUnitOfWork(new Date(Math.max(Date.now(), lease.startedAt + 1)));
		runUnitOfWork(
			database,
			({tx, systemTime: at}) => {
				closeCurrentVersions(tx, apiImportTimestamp, at, eq(apiImportTimestamp.name, BULK_IMPORT_LEASE_NAME));
			},
			end,
		);
	}
}

/**
 * The system time of the open, unexpired bulk-import lease, or undefined when no bulk import is in flight. Every row
 * the import writes is stamped at or after it.
 */
export function bulkImportLeaseStart(database: TemporalTransaction): string | undefined {
	const row = database
		.select({systemFrom: max(apiImportTimestamp.systemFrom)})
		.from(apiImportTimestamp)
		.where(
			and(
				eq(apiImportTimestamp.name, BULK_IMPORT_LEASE_NAME),
				eq(apiImportTimestamp.systemTo, FAR_FUTURE_DATE),
				gt(apiImportTimestamp.timestamp, new Date(Date.now())),
			),
		)
		.get();
	return row?.systemFrom ?? undefined;
}
