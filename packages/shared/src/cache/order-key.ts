import {generateNKeysBetween} from "fractional-indexing";

/**
 * Sibling order. `node_metadata.order_key` is a fractional index: base-62 digits (`0-9A-Za-z`) that sort as plain
 * strings, the Figma/Rocicorp "fractional-indexing" scheme. Siblings sort by order key, then creation time, then id.
 * A node without metadata sorts as `a0`, the key of integer 0.
 */
export const DEFAULT_ORDER_KEY = "a0";

/** Compare two strings by code unit, as SQLite's BINARY collation does, so JS sorts agree with `ORDER BY`. */
export function compareBinary(a: string, b: string): number
{
	if (a === b)
	{
		return 0;
	}
	return a < b ? -1 : 1;
}

/** One sibling's sort fields; a missing order key or creation time sorts as `a0` or 0. */
export interface SiblingOrder
{
	orderKey: string | null | undefined;
	createdAt: Date | number | null | undefined;
	id: string;
}

function createdAtValue(createdAt: Date | number | null | undefined): number
{
	if (createdAt === null || createdAt === undefined)
	{
		return 0;
	}
	return typeof createdAt === "number" ? createdAt : createdAt.getTime();
}

/** Sibling order: order key, then creation time, then id. Pass creation times in one unit throughout. */
export function compareSiblingOrder(a: SiblingOrder, b: SiblingOrder): number
{
	return (
		compareBinary(a.orderKey ?? DEFAULT_ORDER_KEY, b.orderKey ?? DEFAULT_ORDER_KEY) ||
		createdAtValue(a.createdAt) - createdAtValue(b.createdAt) ||
		compareBinary(a.id, b.id)
	);
}

/** One sibling in its target order, with its current key under this parent if it has one. */
export interface TargetSibling
{
	id: string;
	/** The node's current key under this parent; null or undefined when it is new or comes from another parent. */
	orderKey: string | null | undefined;
	/** A pinned sibling keeps its key no matter what. Pinned keys must already be strictly increasing. */
	pinned?: boolean;
}

/** Indexes of one longest run, in sequence order, of strictly increasing keys. */
function longestIncreasing(keys: readonly string[]): number[]
{
	const tails: number[] = [];
	const previous: number[] = [];
	for (const [index, key] of keys.entries())
	{
		let low = 0;
		let high = tails.length;
		while (low < high)
		{
			const middle = (low + high) >>> 1;
			if (compareBinary(keys[tails[middle] ?? 0] ?? "", key) < 0)
			{
				low = middle + 1;
			}
			else
			{
				high = middle;
			}
		}
		previous[index] = low > 0 ? (tails[low - 1] ?? -1) : -1;
		tails[low] = index;
	}
	const result: number[] = [];
	for (let at = tails.at(-1) ?? -1; at !== -1; at = previous[at] ?? -1)
	{
		result.push(at);
	}
	return result.toReversed();
}

/**
 * Map a target sibling order onto order keys, changing as few keys as possible. The longest run of siblings whose
 * current keys already increase in the target order keeps its keys; every other sibling (new, moved in from another
 * parent, or out of order) gets a key between its kept neighbours. Returns only the keys that change, so a target
 * order that matches the local order returns an empty map.
 */
export function orderKeysFor(siblings: readonly TargetSibling[]): Map<string, string>
{
	const kept = new Set<number>();
	let segment: number[] = [];
	let lower: string | null = null;
	const keepSegment = (upper: string | null): void =>
	{
		const candidates = segment.filter((at) =>
		{
			const key = siblings[at]?.orderKey;
			return (
				key !== null &&
				key !== undefined &&
				(lower === null || compareBinary(key, lower) > 0) &&
				(upper === null || compareBinary(key, upper) < 0)
			);
		});
		for (const at of longestIncreasing(candidates.map((index) => siblings[index]?.orderKey ?? "")))
		{
			kept.add(candidates[at] ?? -1);
		}
		segment = [];
	};
	for (const [index, sibling] of siblings.entries())
	{
		if (sibling.pinned === true)
		{
			keepSegment(sibling.orderKey ?? null);
			kept.add(index);
			lower = sibling.orderKey ?? null;
		}
		else
		{
			segment.push(index);
		}
	}
	keepSegment(null);

	const result = new Map<string, string>();
	let previous: string | null = null;
	let run: string[] = [];
	const keyRun = (upper: string | null): void =>
	{
		for (const [at, orderKey] of generateNKeysBetween(previous, upper, run.length).entries())
		{
			result.set(run[at] ?? "", orderKey);
		}
		run = [];
	};
	for (const [index, sibling] of siblings.entries())
	{
		if (kept.has(index))
		{
			const key = sibling.orderKey ?? null;
			keyRun(key);
			previous = key;
		}
		else
		{
			run.push(sibling.id);
		}
	}
	keyRun(null);
	return result;
}
