function isPlainObject(value: unknown): value is Record<string, unknown>
{
	if (typeof value !== "object" || value === null)
	{
		return false;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Each item's string `id`, or null unless every item has one and no two share it. */
function uniqueIds(items: readonly unknown[]): string[] | null
{
	const ids: string[] = [];
	for (const item of items)
	{
		const id = isPlainObject(item) ? item.id : undefined;
		if (typeof id !== "string")
		{
			return null;
		}
		ids.push(id);
	}
	return new Set(ids).size === ids.length ? ids : null;
}

function shareArray(previous: readonly unknown[], next: readonly unknown[]): readonly unknown[]
{
	const previousIds = uniqueIds(previous);
	const nextIds = previousIds === null ? null : uniqueIds(next);
	const byId =
		previousIds === null || nextIds === null
			? null
			: new Map(previousIds.map((id, index) => [id, previous[index]]));
	let same = previous.length === next.length;
	const shared = next.map((item, index) =>
	{
		const counterpart = byId === null || nextIds === null ? previous[index] : byId.get(nextIds[index] ?? "");
		const value = counterpart === undefined ? item : shareById(counterpart, item);
		if (value !== previous[index])
		{
			same = false;
		}
		return value;
	});
	return same ? previous : shared;
}

function shareObject(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown>
{
	const keys = Object.keys(next);
	let same = Object.keys(previous).length === keys.length;
	const shared: Record<string, unknown> = {};
	for (const key of keys)
	{
		const value = Object.hasOwn(previous, key) ? shareById(previous[key], next[key]) : next[key];
		shared[key] = value;
		if (!Object.hasOwn(previous, key) || value !== previous[key])
		{
			same = false;
		}
	}
	return same ? previous : shared;
}

/**
 * TanStack's structural sharing, but matching list items by `id` instead of position: when rows leave or enter a
 * cached list (a block move, a create, a delete), every row after them keeps its object instead of being diffed
 * against its neighbour and copied, so a memoized row that did not change does not re-render. Lists without unique
 * ids are matched by position, as `replaceEqualDeep` does; anything that is not a plain object or array is taken
 * from `next` unless it is identical.
 */
export function shareById(previous: unknown, next: unknown): unknown
{
	if (previous === next)
	{
		return previous;
	}
	if (Array.isArray(previous) && Array.isArray(next))
	{
		return shareArray(previous, next);
	}
	if (isPlainObject(previous) && isPlainObject(next))
	{
		return shareObject(previous, next);
	}
	return next;
}
