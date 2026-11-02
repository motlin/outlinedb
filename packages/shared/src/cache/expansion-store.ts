import {and, eq, inArray, like} from "drizzle-orm";
import {expandedNodes, mirrors as mirrorsTable, nodeContent} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {upstreamExpansionKey as expansionKey, virtualId} from "../workflowy/virtual-id.js";
import {readImportTime, stampImportTime} from "./account-store.js";
import type {UnitOfWork} from "./node-composite.js";
import {closeCurrentVersions, temporalMerge} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/**
 * Our store of the account's expanded-node keys (the first 8 chars of each id, plus `v_` mirror-instance and
 * `leftbar__` keys), the source of truth for expansion: one temporal `expanded_nodes` row per expanded key. A
 * whole-tree import seeds it and every local change applies to it; nothing re-reads workflowy.com's list on a
 * request path.
 *
 * The seed is recorded as the `expanded_nodes` row of `api_import_timestamp`, so an account with no expanded keys
 * still reads as seeded. A poller compares content versions ({@link expansionVersion}), never times.
 */
export const EXPANDED_NODES_IMPORT_NAME = "expanded_nodes";

/** Durable Object SQLite caps a statement at 100 bound parameters. */
const KEY_CHUNK = 90;

/** The id-prefix length of each chunk of a `v_` mirror-instance key. */
const PREFIX_CHUNK = 4;

/** The stored keys, or undefined before any import seeded them. */
export function readExpansion(tx: TemporalTransaction): Set<string> | undefined
{
	if (readImportTime(tx, EXPANDED_NODES_IMPORT_NAME) === undefined)
	{
		return undefined;
	}
	return new Set(
		tx
			.select(
				{
					shortKey: expandedNodes.shortKey,
				},
			)
			.from(expandedNodes)
			.where(eq(expandedNodes.systemTo, FAR_FUTURE_DATE))
			.all()
			.map((row) => row.shortKey),
	);
}

/**
 * A version of `keys` that changes exactly when their content does, whatever the change times: a change feed's
 * cursor, since two changes may share a timestamp or land out of order.
 */
export function expansionVersion(keys: ReadonlySet<string>): string
{
	return hash64(canonicalJson(keys));
}

/**
 * A 64-bit string hash (cyrb53's mixing, both 32-bit halves kept) as 16 hex chars. Synchronous and free of Node
 * builtins, since the browser bundle reaches this module.
 */
export function hash64(text: string): string
{
	let h1 = 0xde_ad_be_ef;
	let h2 = 0x41_c6_ce_57;
	for (let index = 0; index < text.length; index++)
	{
		const code = text.codePointAt(index) ?? 0;
		h1 = Math.imul(h1 ^ code, 2_654_435_761);
		h2 = Math.imul(h2 ^ code, 1_597_334_677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
	return [h2, h1].map((half) => (half >>> 0).toString(16).padStart(8, "0")).join("");
}

function canonicalJson(keys: Iterable<string>): string
{
	return JSON.stringify([...new Set(keys)].toSorted());
}

function liveKeys(tx: TemporalTransaction):
{
	shortKey: string;
}[]
{
	return tx
		.select(
			{
				shortKey: expandedNodes.shortKey,
			},
		)
		.from(expandedNodes)
		.where(eq(expandedNodes.systemTo, FAR_FUTURE_DATE))
		.all();
}

const byKey = (row: {shortKey: string}) => row.shortKey;

/** Replace the stored keys and record the seed at `at` (Unix ms), as a whole-tree import does, in the caller's unit of work. */
export function replaceExpansion(unitOfWork: UnitOfWork, keys: Iterable<string>, at: number): void
{
	temporalMerge(
		unitOfWork.tx,
		{
			table: expandedNodes,
			keyColumn: expandedNodes.shortKey,
			incomingKey: byKey,
			currentKey: byKey,
			contentMatches: () => true,
			buildInsertRow: (row) => (
			{
				shortKey: row.shortKey,
			}),
		},
		[...new Set(keys)].map((shortKey) => (
		{
			shortKey,
		})),
		liveKeys(unitOfWork.tx),
		unitOfWork.systemTime,
	);
	stampImportTime(unitOfWork, EXPANDED_NODES_IMPORT_NAME, at);
}

/**
 * Apply an expansion delta (`true` adds a key, `false` removes it) to the stored keys, touching only the delta's
 * keys, and return the result; an unseeded store stays unseeded (undefined), since a partial set would read as the
 * whole account's.
 */
export function applyExpansionDelta(unitOfWork: UnitOfWork, delta: Record<string, boolean>): Set<string> | undefined
{
	const {tx, systemTime} = unitOfWork;
	const stored = readExpansion(tx);
	if (stored === undefined)
	{
		return undefined;
	}
	const added = Object.entries(delta).flatMap(([key, expanded]) => (expanded && !stored.has(key) ? [key] : []));
	const removed = Object.entries(delta).flatMap(([key, expanded]) => (!expanded && stored.has(key) ? [key] : []));
	for (let start = 0; start < removed.length; start += KEY_CHUNK)
	{
		closeCurrentVersions(
			tx,
			expandedNodes,
			systemTime,
			inArray(expandedNodes.shortKey, removed.slice(start, start + KEY_CHUNK)),
		);
	}
	for (let start = 0; start < added.length; start += KEY_CHUNK)
	{
		tx.insert(expandedNodes)
			.values(
				added.slice(start, start + KEY_CHUNK).map((shortKey) => (
				{
					shortKey,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				})),
			)
			.run();
	}
	const keys = new Set(stored);
	for (const key of removed)
	{
		keys.delete(key);
	}
	for (const key of added)
	{
		keys.add(key);
	}
	return keys;
}

/**
 * Apply an expansion delta in a context with no workflowy.com account, where no import ever seeds the store: an
 * unseeded store is seeded empty first, so the delta's keys are the whole expanded set.
 */
export function applyLocalExpansionDelta(unitOfWork: UnitOfWork, delta: Record<string, boolean>): void
{
	if (readExpansion(unitOfWork.tx) === undefined)
	{
		replaceExpansion(unitOfWork, [], Date.now());
	}
	applyExpansionDelta(unitOfWork, delta);
}

/**
 * Every cached node the stored  expand. Upstream keys expansion by the first 8 chars of the id, so a key
 * resolves to every cached id it prefixes (twins expand together, as upstream) and keys with no cached node are
 * dropped; a `v_` key resolves to the mirror instances it names.
 */
export function resolveExpandedIds(tx: TemporalTransaction, keys: ReadonlySet<string>): string[]
{
	const plain = tx
		.select(
			{
				id: nodeContent.id,
			},
		)
		.from(nodeContent)
		.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
		.orderBy(nodeContent.id)
		.all()
		.map(({id}) => id)
		.filter((id) => keys.has(expansionKey(id)));
	const instances = [...keys].filter((key) => key.startsWith("v_")).flatMap((key) => instanceIds(tx, key));
	return [...plain, ...instances];
}

/**
 * The virtual ids a `v_<child4><mirror4><path>` key expands. The key holds only id prefixes, so it is read back by
 * walking: from each mirror root whose id starts with the mirror chunk, down the original's rows (children of a
 * mirror are its original's), following only the rows whose chunk is the key path's next one. A row met when the
 * walk's path equals the key's path and whose id starts with the child chunk is an expanded instance.
 */
function instanceIds(tx: TemporalTransaction, key: string): string[]
{
	const child = key.slice(2, 2 + PREFIX_CHUNK);
	const mirror = key.slice(2 + PREFIX_CHUNK, 2 + 2 * PREFIX_CHUNK);
	const path = key.slice(2 + 2 * PREFIX_CHUNK);
	if (child.length < PREFIX_CHUNK || mirror.length < PREFIX_CHUNK || !path.startsWith(mirror))
	{
		return [];
	}
	const roots = tx
		.select(
			{
				id: mirrorsTable.mirrorId,
				originalId: mirrorsTable.originalId,
			},
		)
		.from(mirrorsTable)
		.where(and(like(mirrorsTable.mirrorId, `${mirror}%`), eq(mirrorsTable.systemTo, FAR_FUTURE_DATE)))
		.all();
	const found: string[] = [];
	const walk = (rootId: string, rowId: string, walked: string): void =>
	{
		const childIds = shownChildIds(tx, rowId);
		if (walked === path)
		{
			found.push(
				...childIds
					.filter((id) => id.startsWith(child))
					.map((id) =>
						virtualId(
							{
								childId: id,
								mirrorRootId: rootId,
								path,
							},
						),
					),
			);
			return;
		}
		const chunk = path.slice(walked.length, walked.length + PREFIX_CHUNK);
		for (const id of childIds)
		{
			if (id.startsWith(chunk))
			{
				walk(rootId, id, walked + chunk);
			}
		}
	};
	for (const root of roots)
	{
		walk(root.id, root.id, mirror);
	}
	return found;
}

/** The ids of a row's current children, taken from its original when it is a mirror. */
function shownChildIds(tx: TemporalTransaction, rowId: string): string[]
{
	const original = tx
		.select(
			{
				originalId: mirrorsTable.originalId,
			},
		)
		.from(mirrorsTable)
		.where(and(eq(mirrorsTable.mirrorId, rowId), eq(mirrorsTable.systemTo, FAR_FUTURE_DATE)))
		.get();
	return tx
		.select(
			{
				id: nodeContent.id,
			},
		)
		.from(nodeContent)
		.where(and(eq(nodeContent.parentId, original?.originalId ?? rowId), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
		.orderBy(nodeContent.id)
		.all()
		.map(({id}) => id);
}
