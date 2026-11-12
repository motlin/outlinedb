/**
 * One no-op mutation shared by every render, like react-query's stable `mutate`. A fresh `{mutate}` per render
 * rebuilds anything memoized on `mutate`, which no real render does.
 */
export const noopMutation =
{
	mutate: (): void =>
	{
	},
};
