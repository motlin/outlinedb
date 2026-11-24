/** The account state: the account tables' live rows plus the expanded keys, and a version of those rows. */

import {readAccountRows} from "./account-store.js";
import type {AccountRows, AccountState} from "./account-store.js";
import {hash64, readExpansion} from "./expansion-store.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** The live account state. */
export function readAccountState(tx: TemporalTransaction): AccountState
{
	const expansion = readExpansion(tx);
	return {
		rows: readAccountRows(tx),
		expandedKeys: expansion === undefined ? null : [...expansion].toSorted(),
	};
}

/**
 * A version of the account tables' live rows that changes exactly when their content does, ignoring row order: an open
 * tab's cue to re-read its features and preferences after a sync, import or seed rewrote them.
 */
export function accountVersion(rows: AccountRows): string
{
	const tables = Object.entries(rows).map(([name, tableRows]: [string, unknown[]]) => [
		name,
		tableRows.map((row) => JSON.stringify(row)).toSorted(),
	]);
	return hash64(JSON.stringify(tables.toSorted(([a], [b]) => String(a).localeCompare(String(b)))));
}
