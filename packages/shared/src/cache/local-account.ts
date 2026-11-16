/**
 * Account-global state (root metadata and account settings) changed in the temporal account tables. The pure
 * `with...` steps turn one change into the next snapshot: the internal adapter applies them after its push, and
 * {@link LocalAccount} applies them directly in a context with no workflowy.com account.
 */

import {applyMetadataPatches, buildMetadataChanges} from "../internal/metadata-patch.js";
import type {MetadataChange, MetadataPatchSet} from "../internal/metadata-patch.js";
import {changedSavedViewKeys} from "../internal/saved-views.js";
import {canonicalValue, featureFlags, metadataAt, rootMetadataKey} from "./account-outbox.js";
import type {AccountOutboxEntry, AccountOutboxRecorder} from "./account-outbox.js";
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

/**
 * Write the account row of a newly provisioned standalone store, in one unit of work, with a fresh entropy key: the
 * salt of the account's deterministic calendar ids, as workflowy.com gives each account one.
 */
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
						entropyKey: crypto.randomUUID(),
						username: null,
						email: identity.email,
					},
				],
			},
		);
	});
}

export interface LocalAccountOptions
{
	/**
	 * A mirror's account outbox: each write also records the root metadata paths, settings and saved views it changed,
	 * which a drain later delivers to workflowy.com. A standalone account passes none.
	 */
	outbox?: AccountOutboxRecorder;
}

/** Throws when `next`'s value at a changed root path or setting does not survive the account tables. */
function assertStored(next: AccountSnapshot, rootChanges: MetadataChange[], settings: readonly string[]): void
{
	const stored = localSnapshot(accountRows(next));
	for (const {path} of rootChanges)
	{
		if (
			canonicalValue(metadataAt(stored.rootMetadata, path)) !==
			canonicalValue(metadataAt(next.rootMetadata, path))
		)
		{
			throw new Error(`root metadata ${path.join(".")} has no local column, so it cannot be written locally`);
		}
	}
	for (const name of settings)
	{
		if (canonicalValue(stored.settings[name]) !== canonicalValue(next.settings[name]))
		{
			throw new Error(`account setting ${name} has no local column, so it cannot be written locally`);
		}
	}
}

/**
 * The account state in the temporal account tables, read and written with no push: a standalone account's, or a
 * mirror's, whose writes also record account outbox rows for the drain. Each write is one unit of work and leaves the
 * `account` row as it was.
 */
export class LocalAccount
{
	constructor(
		private readonly db: TemporalTransaction,
		private readonly options: LocalAccountOptions = {},
	)
	{
	}

	/** The root (Home) metadata value at `path`; the whole object for an empty path. */
	async getRootMeta(path: string[]): Promise<unknown>
	{
		return Promise.resolve(metadataAt(this.snapshot().rootMetadata, path));
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
	 * singleton row within one microsecond would fail.
	 */
	change(rootChanges: MetadataChange[], settings: readonly (readonly [string, unknown])[]): void
	{
		this.update(
			(snapshot) =>
			{
				const next = settings.reduce(
					(changed, [name, value]) => withSetting(changed, name, value),
					withRootMetaChanges(snapshot, rootChanges).snapshot,
				);
				if (this.options.outbox !== undefined)
				{
					assertStored(
						next,
						rootChanges,
						settings.map(([name]) => name),
					);
				}
				return next;
			},
			() => [
				...rootChanges.map(({path}): AccountOutboxEntry => (
				{
					subject: "root_metadata",
					key: rootMetadataKey(path),
				})),
				...settings.map(([name]): AccountOutboxEntry => (
				{
					subject: "setting",
					key: name,
				})),
			],
		);
	}

	/** Store `json` as `saved_views_json`; a mirror's outbox records each location whose presence changed. */
	async setSavedViews(json: string, _delta: string): Promise<void>
	{
		this.update(
			(snapshot) => withSetting(snapshot, "saved_views_json", json),
			(before) =>
				changedSavedViewKeys(
					typeof before.settings.saved_views_json === "string" ? before.settings.saved_views_json : undefined,
					json,
				).map((key) => (
				{
					subject: "saved_view",
					key,
				})),
		);
		return Promise.resolve();
	}

	/** Turn one account feature on or off; a mirror's outbox records the codename for the drain to enable or disable. */
	setFeature(codename: string, on: boolean): void
	{
		this.update(
			(snapshot) =>
				withSetting(
					snapshot,
					"features",
					{
						...featureFlags(snapshot.settings.features),
						[codename]: on,
					},
				),
			() => [
				{
					subject: "feature",
					key: codename,
				},
			],
		);
	}

	/** The enabled feature codenames, each mapped to true. */
	enabledFeatures(): Record<string, true>
	{
		return Object.fromEntries(
			Object.entries(featureFlags(this.snapshot().settings.features)).flatMap(([codename, on]) =>
				on ? [[codename, true as const]] : [],
			),
		);
	}

	/** The account's entropy key, or undefined for a store provisioned without one. */
	async getEntropyKey(): Promise<string | undefined>
	{
		const row = readAccountRows(this.db).account[0];
		if (row === undefined)
		{
			throw new AccountNotProvisionedError();
		}
		return Promise.resolve(row.entropyKey ?? undefined);
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

	/** Write `change`'s snapshot and, for a mirror, record `entries` (of the snapshot before it) in the same unit of work. */
	private update(
		change: (snapshot: AccountSnapshot) => AccountSnapshot,
		entries: (before: AccountSnapshot) => AccountOutboxEntry[],
	): void
	{
		runUnitOfWork(this.db, (unitOfWork) =>
		{
			const rows = readAccountRows(unitOfWork.tx);
			const before = localSnapshot(rows);
			writeAccountRows(
				unitOfWork,
				{
					...accountRows(change(before)),
					account: rows.account,
				},
			);
			this.options.outbox?.record(unitOfWork, entries(before));
		});
	}
}
