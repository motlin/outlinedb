/**
 * Priority helpers for sibling order. Workflowy orders siblings by `priority`;
 * writes target an exact sibling index, so priorities here only order the
 * client cache.
 */

export interface SiblingLike
{
	id: string;
	priority: number;
}

/** Return a copy of the siblings sorted by ascending priority. */
export function sortByPriority<T extends SiblingLike>(siblings: T[]): T[]
{
	return [...siblings].toSorted((a, b) => a.priority - b.priority);
}
