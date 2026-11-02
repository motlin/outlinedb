import {parseQuery} from "@outlinedb/shared/search-query";

export interface CompletedVisibility
{
	/** Whether completed rows render: the preference, or a revealing query forcing them. */
	shown: boolean;
	/** The persisted preference alone, which a forced value never changes. */
	userShown: boolean;
	/** The committed query reveals completed matches (`is:complete`, also negated), so the toggle is moot. */
	forced: boolean;
}

const revealsByQuery = new Map<string, boolean>();

function queryRevealsCompleted(query: string): boolean
{
	if (query === "")
	{
		return false;
	}
	let reveals = revealsByQuery.get(query);
	if (reveals === undefined)
	{
		reveals = parseQuery(query).revealsCompleted();
		revealsByQuery.set(query, reveals);
	}
	return reveals;
}

/**
 * Upstream's `WF.Complete.shown = forced || userShown`. Derived from the committed query, so it is reactive where
 * upstream's non-observable read renders stale.
 */
export function selectCompletedVisibility(state: {showCompleted: boolean; searchQuery: string}): CompletedVisibility
{
	const forced = queryRevealsCompleted(state.searchQuery);
	return {
		shown: forced || state.showCompleted,
		userShown: state.showCompleted,
		forced,
	};
}
