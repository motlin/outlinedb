/**
 * `startId`'s node and its ancestors, nearest first. The walk stops at Home, at an id `get` does not find (null or undefined),
 * or where the chain loops back on itself: a stale cache can hold A under B and B under A.
 */
export function ancestorChain<
	T extends
	{
		id: string;
		parentId: string | null;
	},
>(startId: string | null, get: (id: string) => T | null | undefined): T[]
{
	const chain: T[] = [];
	const seen = new Set<string>();
	for (let id = startId; id !== null && !seen.has(id);)
	{
		const node = get(id);
		if (node === undefined || node === null)
		{
			break;
		}
		seen.add(id);
		chain.push(node);
		id = node.parentId;
	}
	return chain;
}
