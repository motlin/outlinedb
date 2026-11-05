import {eq, inArray} from "drizzle-orm";
import {expandedNodes} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
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

/** The stored keys, or undefined before any import seeded them. */
export function readExpansion(tx: TemporalTransaction): Set<string> | undefined {
	if (readImportTime(tx, EXPANDED_NODES_IMPORT_NAME) === undefined) {
		return undefined;
	}
	return new Set(
		tx
			.select({shortKey: expandedNodes.shortKey})
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
export function expansionVersion(keys: ReadonlySet<string>): string {
	return hash64(canonicalJson(keys));
}

/**
 * A 64-bit string hash (cyrb53's mixing, both 32-bit halves kept) as 16 hex chars. Synchronous and free of Node
 * builtins, since the browser bundle reaches this module.
 */
export function hash64(text: string): string {
	let h1 = 0xde_ad_be_ef;
	let h2 = 0x41_c6_ce_57;
	for (let index = 0; index < text.length; index++) {
		const code = text.codePointAt(index) ?? 0;
		h1 = Math.imul(h1 ^ code, 2_654_435_761);
		h2 = Math.imul(h2 ^ code, 1_597_334_677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
	return [h2, h1].map((half) => (half >>> 0).toString(16).padStart(8, "0")).join("");
}

function canonicalJson(keys: Iterable<string>): string {
	return JSON.stringify([...new Set(keys)].toSorted());
}

function liveKeys(tx: TemporalTransaction): {shortKey: string}[] {
	return tx
		.select({shortKey: expandedNodes.shortKey})
		.from(expandedNodes)
		.where(eq(expandedNodes.systemTo, FAR_FUTURE_DATE))
		.all();
}

const byKey = (row: {shortKey: string}) => row.shortKey;

/** Replace the stored keys and record the seed at `at` (Unix ms), as a whole-tree import does, in the caller's unit of work. */
export function replaceExpansion(unitOfWork: UnitOfWork, keys: Iterable<string>, at: number): void {
	temporalMerge(
		unitOfWork.tx,
		{
			table: expandedNodes,
			keyColumn: expandedNodes.shortKey,
			incomingKey: byKey,
			currentKey: byKey,
			contentMatches: () => true,
			buildInsertRow: (row) => ({shortKey: row.shortKey}),
		},
		[...new Set(keys)].map((shortKey) => ({shortKey})),
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
export function applyExpansionDelta(unitOfWork: UnitOfWork, delta: Record<string, boolean>): Set<string> | undefined {
	const {tx, systemTime} = unitOfWork;
	const stored = readExpansion(tx);
	if (stored === undefined) {
		return undefined;
	}
	const added = Object.entries(delta).flatMap(([key, expanded]) => (expanded && !stored.has(key) ? [key] : []));
	const removed = Object.entries(delta).flatMap(([key, expanded]) => (!expanded && stored.has(key) ? [key] : []));
	for (let start = 0; start < removed.length; start += KEY_CHUNK) {
		closeCurrentVersions(
			tx,
			expandedNodes,
			systemTime,
			inArray(expandedNodes.shortKey, removed.slice(start, start + KEY_CHUNK)),
		);
	}
	for (let start = 0; start < added.length; start += KEY_CHUNK) {
		tx.insert(expandedNodes)
			.values(
				added
					.slice(start, start + KEY_CHUNK)
					.map((shortKey) => ({shortKey, systemFrom: systemTime, systemTo: FAR_FUTURE_DATE})),
			)
			.run();
	}
	const keys = new Set(stored);
	for (const key of removed) {
		keys.delete(key);
	}
	for (const key of added) {
		keys.add(key);
	}
	return keys;
}
