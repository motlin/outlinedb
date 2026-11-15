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
