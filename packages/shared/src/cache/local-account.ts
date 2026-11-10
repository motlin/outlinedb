/**
 * Account-global state (root metadata and account settings) changed in the temporal account tables. The pure
 * `with...` steps turn one change into the next snapshot: the internal adapter applies them after its push, and
 * {@link LocalAccount} applies them directly in a context with no workflowy.com account.
 */

import {applyMetadataPatches, buildMetadataChanges} from "../internal/metadata-patch.js";
import type {MetadataChange, MetadataPatchSet} from "../internal/metadata-patch.js";
import {accountRows, readAccountRows, snapshotFromRows, writeAccountRows} from "./account-store.js";
import type {AccountRows, AccountSnapshot} from "./account-store.js";
import {runUnitOfWork} from "./node-composite.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** `snapshot` with `changes` applied to its root metadata, plus the patches (and inverses) that carry them upstream. */
export function withRootMetaChanges(
	snapshot: AccountSnapshot,
	changes: MetadataChange[],
): MetadataPatchSet & {snapshot: AccountSnapshot} {
	const {patches, inverse} = buildMetadataChanges(snapshot.rootMetadata, changes);
	return {
		patches,
		inverse,
		snapshot: {...snapshot, rootMetadata: applyMetadataPatches(snapshot.rootMetadata, patches)},
	};
}

/** `snapshot` with one account setting replaced. */
export function withSetting(snapshot: AccountSnapshot, name: string, value: unknown): AccountSnapshot {
	return {...snapshot, settings: {...snapshot.settings, [name]: value}};
}

function getPath(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const key of path) {
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) {
			return undefined;
		}
		current = Reflect.get(current, key);
	}
	return current;
}

/**
 * The snapshot of `rows`, with a stand-in account row (user id from the preference rows, else 0, joined at the Unix
 * epoch) when no account import ever wrote one.
 */
function localSnapshot(rows: AccountRows): AccountSnapshot {
	const userId = rows.account[0]?.userId ?? rows.rootPreferences[0]?.userId ?? rows.accountSettings[0]?.userId ?? 0;
	const standIn = {userId, dateJoinedSec: 0, fullName: null, entropyKey: null, username: null, email: null};
	const snapshot = snapshotFromRows({...rows, account: rows.account.length > 0 ? rows.account : [standIn]});
	if (snapshot === undefined) {
		throw new TypeError("account snapshot without an account row");
	}
	return snapshot;
}

/**
 * The account state of a context with no workflowy.com account, read from and written to the temporal account
 * tables with no push: the root-metadata and settings reads and writes the internal adapter offers. Each write is one
 * unit of work and leaves the `account` row as it was.
 */
export class LocalAccount {
	constructor(private readonly db: TemporalTransaction) {}

	/** The root (Home) metadata value at `path`; the whole object for an empty path. */
	async getRootMeta(path: string[]): Promise<unknown> {
		return Promise.resolve(getPath(this.snapshot().rootMetadata, path));
	}

	/** Set (or, with `undefined`, remove) one root metadata value. */
	async setRootMeta(path: string[], value: unknown): Promise<void> {
		await this.setRootMetaValues([{path, value}]);
	}

	/** Set (or, with `undefined`, remove) several root metadata values, applied in order. */
	async setRootMetaValues(changes: MetadataChange[]): Promise<void> {
		this.change(changes, []);
		return Promise.resolve();
	}

	async getSetting(name: string): Promise<unknown> {
		return Promise.resolve(this.snapshot().settings[name]);
	}

	async setSetting(name: string, value: string | boolean): Promise<void> {
		this.change([], [[name, value]]);
		return Promise.resolve();
	}

	/**
	 * Apply root metadata changes and then settings, in order, in one unit of work: separate writes to the same
	 * singleton row within one millisecond would fail.
	 */
	change(rootChanges: MetadataChange[], settings: readonly (readonly [string, unknown])[]): void {
		this.update((snapshot) =>
			settings.reduce(
				(next, [name, value]) => withSetting(next, name, value),
				withRootMetaChanges(snapshot, rootChanges).snapshot,
			),
		);
	}

	/** Store `json` as `saved_views_json`; the delta only matters to workflowy.com. */
	async setSavedViews(json: string, _delta: string): Promise<void> {
		this.update((snapshot) => withSetting(snapshot, "saved_views_json", json));
		return Promise.resolve();
	}

	/** The stored account, or the stand-in (joined at the Unix epoch) before any account import. */
	async getAccount(): Promise<{userId: number; joinedAt: Date; fullName: string | null}> {
		const {account} = this.snapshot();
		return Promise.resolve({
			userId: account.userId,
			joinedAt: new Date(account.dateJoinedSec * 1000),
			fullName: account.fullName ?? null,
		});
	}

	private snapshot(): AccountSnapshot {
		return localSnapshot(readAccountRows(this.db));
	}

	private update(change: (snapshot: AccountSnapshot) => AccountSnapshot): void {
		runUnitOfWork(this.db, (unitOfWork) => {
			const rows = readAccountRows(unitOfWork.tx);
			writeAccountRows(unitOfWork, {...accountRows(change(localSnapshot(rows))), account: rows.account});
		});
	}
}
