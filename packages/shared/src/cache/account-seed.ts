/**
 * The account state as one seed: the account tables' live rows plus the expanded keys. A new deployment (the
 * Cloudflare Durable Object) is seeded from the local cache's copy, since its own account import would lose the
 * history and the values written locally.
 */

import {ACCOUNT_IMPORT_NAME, readAccountRows, stampImportTime, writeAccountRows} from "./account-store.js";
import type {AccountRows, AccountState} from "./account-store.js";
import {hash64, readExpansion, replaceExpansion} from "./expansion-store.js";
import type {UnitOfWork} from "./node-composite.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** The live account state, as a seed. */
export function readAccountState(tx: TemporalTransaction): AccountState {
	const expansion = readExpansion(tx);
	return {rows: readAccountRows(tx), expandedKeys: expansion === undefined ? null : [...expansion].toSorted()};
}

/** Merge a seed into the account tables, stamped as fetched at `at` (Unix ms), in the caller's unit of work. */
export function writeAccountState(unitOfWork: UnitOfWork, state: AccountState, at: number): void {
	writeAccountRows(unitOfWork, state.rows);
	stampImportTime(unitOfWork, ACCOUNT_IMPORT_NAME, at);
	if (state.expandedKeys !== null) {
		replaceExpansion(unitOfWork, state.expandedKeys, at);
	}
}

/**
 * A version of the account tables' live rows that changes exactly when their content does, ignoring row order: an open
 * tab's cue to re-read its features and preferences after a sync, import or seed rewrote them.
 */
export function accountVersion(rows: AccountRows): string {
	const tables = Object.entries(rows).map(([name, tableRows]: [string, unknown[]]) => [
		name,
		tableRows.map((row) => JSON.stringify(row)).toSorted(),
	]);
	return hash64(JSON.stringify(tables.toSorted(([a], [b]) => String(a).localeCompare(String(b)))));
}
