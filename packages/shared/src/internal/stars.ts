/**
 * Pure mapping between upstream's starring state in root metadata (CoreKv) and the
 * `/api/v1/stars` DTO ({@link Star}).
 *
 * Upstream shape (confirmed read-only against the live account, 2026-10-18):
 * - `starring.locations`: `{[locationKey]: treeRoot}`; keys use FULL node UUIDs, and the
 *   main tree's treeRoot is `"None"`.
 * - `starring.order`: comma-joined uniqueIds (`None/<nodeId or None>/<query>`), present only
 *   once the user has reordered; starring appends to it, unstarring removes from it.
 * - `location.renamed`: `{[uniqueId]: name}`.
 * - `starring.isSynced`: false or absent means upstream still reads stars from the legacy
 *   account setting `saved_views_json` (see `saved-views.ts`); its first toggle copies the
 *   toggled legacy map into `starring.locations` and sets it true.
 *
 * The DTO speaks location keys; uniqueIds never leave this module.
 */

import {z} from "zod";
import {defaultOrder, parseLocationKey, uniqueId} from "../starring.js";
import type {NameText, Star} from "../starring.js";
import type {MetadataChange} from "./metadata-patch.js";
import {savedViewsMap} from "./saved-views.js";

/** The value upstream stores for a star in the main tree. */
const MAIN_TREE = "None";

const LOCATIONS = ["starring", "locations"];
const ORDER = ["starring", "order"];
const RENAMED = ["location", "renamed"];
const IS_SYNCED = ["starring", "isSynced"];

export interface StarNodes {
	/** Whether a (non-Home) node is still in the cache. */
	exists(nodeId: string): boolean;
	nameText: NameText;
}

const RecordSchema = z.record(z.string(), z.unknown());

function record(value: unknown): Record<string, unknown> {
	return RecordSchema.safeParse(value).data ?? {};
}

function getIn(meta: unknown, path: string[]): unknown {
	return path.reduce<unknown>((current, key) => record(current)[key], meta);
}

function storedOrder(meta: unknown): string[] | undefined {
	const order = getIn(meta, ORDER);
	return typeof order === "string" ? order.split(",") : undefined;
}

function isSynced(meta: unknown): boolean {
	return getIn(meta, IS_SYNCED) === true;
}

/**
 * Upstream `toggleLocation`: a synced account toggles `key` in `starring.locations`; an unsynced
 * one gets the whole toggled legacy map there instead, and `starring.isSynced: true`.
 */
function toggleChanges(meta: unknown, key: string, value: string | undefined, legacy: Record<string, string>) {
	return isSynced(meta)
		? {location: [{path: [...LOCATIONS, key], value}], synced: []}
		: {location: [{path: LOCATIONS, value: legacy}], synced: [{path: IS_SYNCED, value: true}]};
}

function keyUniqueId(key: string): string {
	return uniqueId(parseLocationKey(key));
}

/** Upstream `g82`: drop unknown and duplicate ids, then append valid ids missing from the order. */
function normalizeOrder(order: string[], validIds: string[]): string[] | undefined {
	const valid = new Set(validIds);
	const seen = new Set<string>();
	const kept = order.filter((id) => {
		if (!valid.has(id) || seen.has(id)) {
			return false;
		}
		seen.add(id);
		return true;
	});
	if (kept.length === 0 && order.every((id) => id === "")) {
		return undefined;
	}
	return [...kept, ...validIds.filter((id) => !seen.has(id))];
}

/**
 * The valid stars (Home, or a node still in the cache) in upstream's display order, read from
 * `starring.locations`, or from the legacy `savedViews` (`saved_views_json`) while unsynced.
 */
export function starsFromRootMeta(meta: unknown, nodes: StarNodes, savedViews: string | undefined): Star[] {
	const renamed = record(getIn(meta, RENAMED));
	const locations = isSynced(meta) ? record(getIn(meta, LOCATIONS)) : savedViewsMap(savedViews);
	const valid = Object.entries(locations)
		.filter(([, treeRoot]) => treeRoot === MAIN_TREE)
		.map(([key]) => {
			const location = parseLocationKey(key);
			const name = renamed[uniqueId(location)];
			return {key, ...location, name: typeof name === "string" && name !== "" ? name : null};
		})
		.filter((star) => star.nodeId === null || nodes.exists(star.nodeId));

	const stored = storedOrder(meta);
	const order =
		stored &&
		normalizeOrder(
			stored,
			valid.map((star) => uniqueId(star)),
		);
	const ordered = order
		? valid.toSorted((x, y) => order.indexOf(uniqueId(x)) - order.indexOf(uniqueId(y)))
		: defaultOrder(
				valid.map((star) => ({...star, position: 0})),
				nodes.nameText,
			);
	return ordered.map((star, position) => ({
		key: star.key,
		nodeId: star.nodeId,
		query: star.query,
		name: star.name,
		position,
	}));
}

/**
 * Star `key`; an existing order gets its uniqueId appended (upstream `toggleLocation`).
 * `legacy` is the saved-views map after starring, copied in while the account is unsynced.
 */
export function starChanges(meta: unknown, key: string, legacy: Record<string, string>): MetadataChange[] {
	const {location, synced} = toggleChanges(meta, key, MAIN_TREE, legacy);
	const order = storedOrder(meta);
	const id = keyUniqueId(key);
	const orderChange = order && !order.includes(id) ? [{path: ORDER, value: [...order, id].join(",")}] : [];
	return [...location, ...orderChange, ...synced];
}

/**
 * Unstar `key`: its location and its order entry (when ordered). Like upstream, a custom name survives.
 * `legacy` is the saved-views map after unstarring, copied in while the account is unsynced.
 */
export function unstarChanges(meta: unknown, key: string, legacy: Record<string, string>): MetadataChange[] {
	const {location, synced} = toggleChanges(meta, key, undefined, legacy);
	const id = keyUniqueId(key);
	const order = storedOrder(meta);
	const orderChange = order?.includes(id)
		? [{path: ORDER, value: order.filter((entry) => entry !== id).join(",")}]
		: [];
	return [...location, ...orderChange, ...synced];
}

/** Rename `key`; `null` or `""` clears the rename. */
export function renameChanges(key: string, name: string | null): MetadataChange[] {
	return [{path: [...RENAMED, keyUniqueId(key)], value: name === null || name === "" ? undefined : name}];
}

/** Store `keys` as the explicit star order. */
export function orderChanges(keys: readonly string[]): MetadataChange[] {
	return [{path: ORDER, value: keys.map((key) => keyUniqueId(key)).join(",")}];
}
