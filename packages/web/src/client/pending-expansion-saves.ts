/**
 * Expansion PATCHes whose reply has not arrived yet. The server owns expansion: an outline view load expands the rows
 * the account has stored as expanded, so it waits for every save sent before it, and the expand that opened the view
 * is in the walk.
 */
const saves = new Set<Promise<void>>();

/** Track `save` until it settles. */
export function trackExpansionSave(save: Promise<void>): void
{
	saves.add(save);
	void save.finally(() =>
	{
		saves.delete(save);
	});
}

/** Wait until every expansion save sent so far has settled, failed or not. */
export async function expansionSaved(): Promise<void>
{
	await Promise.allSettled(saves);
}
