/**
 * Mirror mode's account outbox: which pieces of account-level state (root metadata paths, account settings, legacy
 * saved views, expansion keys) a local write left ahead of workflowy.com, keyed by their own business keys. Like the
 * node outbox it holds no payload: the change is the current local value, which the drain reads when it sends.
 */

import {and, asc, desc, isNotNull, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {accountOutbox} from "../db/schema.js";
import {applyMetadataPatches, buildMetadataChanges} from "../internal/metadata-patch.js";
import {overlaySavedViews} from "../internal/saved-views.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {readAccountSnapshot} from "./account-store.js";
import type {AccountSnapshot} from "./account-store.js";
import {currentVersion} from "./cache-temporal.js";
import type {UnitOfWork} from "./node-composite.js";
import {closeCurrentVersions} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** The kinds of account-level state a mirror-mode write can leave ahead of workflowy.com. */
export const ACCOUNT_OUTBOX_SUBJECTS = ["root_metadata", "setting", "saved_view", "expansion"] as const;

export type AccountOutboxSubject = (typeof ACCOUNT_OUTBOX_SUBJECTS)[number];

export interface AccountOutboxEntry
{
	subject: AccountOutboxSubject;
	key: string;
}

/** One current account outbox row. */
export interface PendingAccountOutboxRow extends AccountOutboxEntry
{
	enqueuedAt: string;
	lastError: string | null;
}

/** Durable Object SQLite caps a statement at 100 bound parameters; a row binds 6. */
const ROWS_PER_INSERT = 15;

/** A root metadata path's key: the segments joined by U+001F, which no metadata key contains. */
const PATH_SEPARATOR = "\u001F";

export function rootMetadataKey(path: readonly string[]): string
{
	return path.join(PATH_SEPARATOR);
}

export function rootMetadataPath(key: string): string[]
{
	return key.split(PATH_SEPARATOR);
}

/** The value at `path` of a metadata object; undefined when any segment is missing. */
export function metadataAt(value: unknown, path: readonly string[]): unknown
{
	let current = value;
	for (const segment of path)
	{
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment))
		{
			return undefined;
		}
		current = Reflect.get(current, segment);
	}
	return current;
}

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
export function canonicalValue(value: unknown): string
{
	if (value === undefined)
	{
		return "undefined";
	}
	return JSON.stringify(value, (_key, inner: unknown) =>
		typeof inner === "object" && inner !== null && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).toSorted(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
			: inner,
	);
}

const entryKey = ({subject, key}: AccountOutboxEntry): string => `${subject}${PATH_SEPARATOR}${key}`;

/** Where `(subject, key)` is one of `entries`, bound as one JSON parameter. */
function entriesWhere(entries: readonly AccountOutboxEntry[]): SQL
{
	return sql`(${accountOutbox.subject} || char(31) || ${accountOutbox.key}) IN (SELECT value FROM json_each(${JSON.stringify(entries.map(entryKey))}))`;
}

/** The pending keys of each subject, in one read. */
export function pendingAccountKeys(tx: TemporalTransaction): Map<AccountOutboxSubject, Set<string>>
{
	const pending = new Map<AccountOutboxSubject, Set<string>>();
	for (const {subject, key} of readPendingAccountOutbox(tx))
	{
		let keys = pending.get(subject);
		if (keys === undefined)
		{
			keys = new Set();
			pending.set(subject, keys);
		}
		keys.add(key);
	}
	return pending;
}

/** Every current account outbox row, oldest first. */
export function readPendingAccountOutbox(tx: TemporalTransaction): PendingAccountOutboxRow[]
{
	const rows = tx
		.select(
			{
				subject: accountOutbox.subject,
				key: accountOutbox.key,
				enqueuedAt: accountOutbox.enqueuedAt,
				lastError: accountOutbox.lastError,
			},
		)
		.from(accountOutbox)
		.where(currentVersion(accountOutbox))
		.orderBy(asc(accountOutbox.enqueuedAt), asc(accountOutbox.subject), asc(accountOutbox.key))
		.all();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the recorder writes only AccountOutboxSubject values
	return rows as PendingAccountOutboxRow[];
}

function insertRows(tx: TemporalTransaction, rows: (typeof accountOutbox.$inferInsert)[]): void
{
	for (let start = 0; start < rows.length; start += ROWS_PER_INSERT)
	{
		tx.insert(accountOutbox)
			.values(rows.slice(start, start + ROWS_PER_INSERT))
			.run();
	}
}

/**
 * Records which account-level keys a unit of work left ahead of workflowy.com, as current `account_outbox` rows in
 * that same unit of work. A key that already has a current row keeps it, so a burst of edits coalesces into one row.
 */
export class AccountOutboxRecorder
{
	record({tx, systemTime}: UnitOfWork, entries: readonly AccountOutboxEntry[]): void
	{
		const pending = pendingAccountKeys(tx);
		const fresh = new Map(
			entries
				.filter(({subject, key}) => pending.get(subject)?.has(key) !== true)
				.map((entry) => [entryKey(entry), entry]),
		);
		insertRows(
			tx,
			[...fresh.values()].map(({subject, key}) => (
			{
				subject,
				key,
				enqueuedAt: systemTime,
				lastError: null,
				systemFrom: systemTime,
				systemTo: FAR_FUTURE_DATE,
			})),
		);
	}
}

/** Close `entries`' current rows: workflowy.com has them, or they no longer need sending. */
export function closeAccountOutboxRows({tx, systemTime}: UnitOfWork, entries: readonly AccountOutboxEntry[]): void
{
	if (entries.length > 0)
	{
		closeCurrentVersions(tx, accountOutbox, systemTime, entriesWhere(entries));
	}
}

/**
 * Record a failed drain on those of `entries` still pending: each current row closes and a new version opens with the
 * same `enqueued_at` and `error` as `last_error`, so the rows stay pending.
 */
export function failAccountOutboxRows(
	{tx, systemTime}: UnitOfWork,
	entries: readonly AccountOutboxEntry[],
	error: string,
): void
{
	if (entries.length === 0)
	{
		return;
	}
	const current = tx
		.select(
			{
				subject: accountOutbox.subject,
				key: accountOutbox.key,
				enqueuedAt: accountOutbox.enqueuedAt,
			},
		)
		.from(accountOutbox)
		.where(and(currentVersion(accountOutbox), entriesWhere(entries)))
		.all();
	if (current.length === 0)
	{
		return;
	}
	closeCurrentVersions(tx, accountOutbox, systemTime, entriesWhere(entries));
	insertRows(
		tx,
		current.map(({subject, key, enqueuedAt}) => (
		{
			subject,
			key,
			enqueuedAt,
			lastError: error,
			systemFrom: systemTime,
			systemTo: FAR_FUTURE_DATE,
		})),
	);
}

/** The account outbox at a glance: pending rows, the oldest one's `enqueued_at`, and the newest failure. */
export function accountOutboxStatus(tx: TemporalTransaction):
{
	pending: number;
	oldestEnqueuedAt: string | null;
	lastError: string | null;
	lastErrorAt: string | null;
}
{
	const summary = tx
		.select(
			{
				pending: sql<number>`count(*)`,
				oldestEnqueuedAt: sql<string | null>`min(${accountOutbox.enqueuedAt})`,
			},
		)
		.from(accountOutbox)
		.where(currentVersion(accountOutbox))
		.get();
	const failed = tx
		.select(
			{
				lastError: accountOutbox.lastError,
				systemFrom: accountOutbox.systemFrom,
			},
		)
		.from(accountOutbox)
		.where(and(currentVersion(accountOutbox), isNotNull(accountOutbox.lastError)))
		.orderBy(desc(accountOutbox.systemFrom))
		.limit(1)
		.get();
	return {
		pending: summary?.pending ?? 0,
		oldestEnqueuedAt: summary?.oldestEnqueuedAt ?? null,
		lastError: failed?.lastError ?? null,
		lastErrorAt: failed?.systemFrom ?? null,
	};
}

/**
 * `fresh` (an upstream snapshot about to be stored) with every pending key's local value kept: a refresh must never
 * overwrite a change the drain has not delivered yet. Root metadata paths apply shortest first, so a pending child
 * path wins over its pending parent's value.
 */
export function withPendingAccountState(tx: TemporalTransaction, fresh: AccountSnapshot): AccountSnapshot
{
	const pending = pendingAccountKeys(tx);
	const rootKeys = [...(pending.get("root_metadata") ?? [])];
	const settingKeys = [...(pending.get("setting") ?? [])];
	const savedViewKeys = pending.get("saved_view") ?? new Set<string>();
	if (rootKeys.length === 0 && settingKeys.length === 0 && savedViewKeys.size === 0)
	{
		return fresh;
	}
	const local = readAccountSnapshot(tx);
	if (local === undefined)
	{
		return fresh;
	}
	const changes = rootKeys
		.map(rootMetadataPath)
		.toSorted((x, y) => x.length - y.length)
		.map((path) => (
		{
			path,
			value: metadataAt(local.rootMetadata, path),
		}));
	const pendingSettings = new Set(settingKeys);
	const settings: Record<string, unknown> = Object.fromEntries(
		[
			...Object.entries(fresh.settings).filter(([name]) => !pendingSettings.has(name)),
			...settingKeys.map((name) => [name, local.settings[name]] as const),
		].filter(([, value]) => value !== undefined),
	);
	if (savedViewKeys.size > 0)
	{
		settings.saved_views_json = overlaySavedViews(
			typeof fresh.settings.saved_views_json === "string" ? fresh.settings.saved_views_json : undefined,
			typeof local.settings.saved_views_json === "string" ? local.settings.saved_views_json : undefined,
			savedViewKeys,
		);
	}
	return {
		...fresh,
		rootMetadata: applyMetadataPatches(
			fresh.rootMetadata,
			buildMetadataChanges(fresh.rootMetadata, changes).patches,
		),
		settings,
	};
}
