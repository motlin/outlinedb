/**
 * Account-global state (root metadata and account settings) changed in the temporal account tables. The pure
 * `with...` steps turn one change into the next snapshot: the internal adapter applies them after its push, and
 * {@link LocalAccount} applies them directly in a context with no workflowy.com account.
 */

import {applyMetadataPatches, buildMetadataChanges} from "../internal/metadata-patch.js";
import type {MetadataChange, MetadataPatchSet} from "../internal/metadata-patch.js";
import
{
	AccountNotProvisionedError,
	accountRows,
	readAccountRows,
	snapshotFromRows,
	writeAccountRows,
} from "./account-store.js";
import type {AccountRows, AccountSnapshot} from "./account-store.js";
import {runUnitOfWork} from "./node-composite.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** `snapshot` with `changes` applied to its root metadata, plus the patches (and inverses) that carry them upstream. */
export function withRootMetaChanges(
	snapshot: AccountSnapshot,
	changes: MetadataChange[],
): MetadataPatchSet &
{
	snapshot: AccountSnapshot;
}
{
	const {patches, inverse} = buildMetadataChanges(snapshot.rootMetadata, changes);
	return {
		patches,
		inverse,
		snapshot:
		{
			...snapshot,
			rootMetadata: applyMetadataPatches(snapshot.rootMetadata, patches),
		},
	};
}

/** `snapshot` with one account setting replaced. */
export function withSetting(snapshot: AccountSnapshot, name: string, value: unknown): AccountSnapshot
{
	return {
		...snapshot,
		settings:
		{
			...snapshot.settings,
			[name]: value,
		},
	};
}

function getPath(value: unknown, path: readonly string[]): unknown
{
	let current = value;
	for (const key of path)
	{
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key))
		{
			return undefined;
		}
		current = Reflect.get(current, key);
	}
	return current;
}

/** The snapshot of `rows`; throws {@link AccountNotProvisionedError} when no account row exists. */
function localSnapshot(rows: AccountRows): AccountSnapshot
{
	const snapshot = snapshotFromRows(rows);
	if (snapshot === undefined)
	{
		throw new AccountNotProvisionedError();
	}
	return snapshot;
}

/** Whom a standalone store was provisioned for: the sign-in user id and email, and when they joined. */
export interface LocalIdentity
{
	userId: string;
	email: string;
	joinedAt: Date;
}

/** Write the account row of a newly provisioned standalone store, in one unit of work. */
export function provisionLocalAccount(db: TemporalTransaction, identity: LocalIdentity): void
{
	runUnitOfWork(db, (unitOfWork) =>
	{
		writeAccountRows(
			unitOfWork,
			{
				...readAccountRows(unitOfWork.tx),
				account: [
					{
						userId: identity.userId,
						fullName: null,
						dateJoinedSec: Math.floor(identity.joinedAt.getTime() / 1000),
						entropyKey: null,
						username: null,
						email: identity.email,
					},
				],
			},
		);
	});
}

/**
 * The account state of a context with no workflowy.com account, read from and written to the temporal account
 * tables with no push: the root-metadata and settings reads and writes the internal adapter offers. Each write is one
 * unit of work and leaves the `account` row as it was.
 */
export class LocalAccount
{
	constructor(private readonly db: TemporalTransaction)
	{
	}

	/** The root (Home) metadata value at `path`; the whole object for an empty path. */
	async getRootMeta(path: string[]): Promise<unknown>
	{
		return Promise.resolve(getPath(this.snapshot().rootMetadata, path));
	}

	/** Set (or, with `undefined`, remove) one root metadata value. */
	async setRootMeta(path: string[], value: unknown): Promise<void>
	{
		await this.setRootMetaValues([
			{
				path,
				value,
			},
		]);
	}

	/** Set (or, with `undefined`, remove) several root metadata values, applied in order. */
	async setRootMetaValues(changes: MetadataChange[]): Promise<void>
	{
		this.change(changes, []);
		return Promise.resolve();
	}

	async getSetting(name: string): Promise<unknown>
	{
		return Promise.resolve(this.snapshot().settings[name]);
	}

	async setSetting(name: string, value: string | boolean): Promise<void>
	{
		this.change([], [[name, value]]);
		return Promise.resolve();
	}

	/**
	 * Apply root metadata changes and then settings, in order, in one unit of work: separate writes to the same
	 * singleton row within one millisecond would fail.
	 */
	change(rootChanges: MetadataChange[], settings: readonly (readonly [string, unknown])[]): void
	{
		this.update((snapshot) =>
			settings.reduce(
				(next, [name, value]) => withSetting(next, name, value),
				withRootMetaChanges(snapshot, rootChanges).snapshot,
			),
		);
	}

	/** Store `json` as `saved_views_json`; the delta only matters to workflowy.com. */
	async setSavedViews(json: string, _delta: string): Promise<void>
	{
		this.update((snapshot) => withSetting(snapshot, "saved_views_json", json));
		return Promise.resolve();
	}

	/** The provisioned account and its email. */
	async getAccount(): Promise<
	{
		userId: string;
		joinedAt: Date;
		fullName: string | null;
		email: string | null;
	}>
	{
		const row = readAccountRows(this.db).account[0];
		if (row === undefined)
		{
			throw new AccountNotProvisionedError();
		}
		return Promise.resolve(
			{
				userId: row.userId,
				joinedAt: new Date(row.dateJoinedSec * 1000),
				fullName: row.fullName ?? null,
				email: row.email ?? null,
			},
		);
	}

	private snapshot(): AccountSnapshot
	{
		return localSnapshot(readAccountRows(this.db));
	}

	private update(change: (snapshot: AccountSnapshot) => AccountSnapshot): void
	{
		runUnitOfWork(this.db, (unitOfWork) =>
		{
			const rows = readAccountRows(unitOfWork.tx);
			writeAccountRows(
				unitOfWork,
				{
					...accountRows(change(localSnapshot(rows))),
					account: rows.account,
				},
			);
		});
	}
}
