/**
 * The account state as one seed: the account tables' live rows plus the expanded keys. A new deployment (the
 * Cloudflare Durable Object) is seeded from the local cache's copy, since its own account import would lose the
 * history and the values written locally.
 */

import {ACCOUNT_IMPORT_NAME, readAccountRows, stampImportTime, writeAccountRows} from "./account-store.js";
import type {AccountState} from "./account-store.js";
import {readExpansion, replaceExpansion} from "./expansion-store.js";
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
