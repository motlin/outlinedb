import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useEffect, useRef} from "react";
import {preferencesQuery, setPreferences} from "./hooks/use-preferences.js";
import type {PreferencesPatch, PreferencesState} from "./hooks/use-preferences.js";

/**
 * Upstream's `app.initialized` handler in `WF.Updates`: the account's `searchForChangesAfter` (when change
 * tracking started) is set to now when missing or in the future, and otherwise left alone.
 */
export function searchForChangesAfterPatch(state: PreferencesState | undefined, now: Date): PreferencesPatch | null {
	if (state?.available !== true) {
		return null;
	}
	const stored = state.preferences.searchForChangesAfter;
	return stored === null || Date.parse(stored) > now.getTime() ? {searchForChangesAfter: now.toISOString()} : null;
}

/** Once preferences load, start the account's change tracking as upstream does on startup. */
export function useSearchForChangesAfterSync(): void {
	const queryClient = useQueryClient();
	const {data} = useQuery(preferencesQuery);
	const done = useRef(false);
	useEffect(() => {
		if (done.current || data === undefined) {
			return;
		}
		done.current = true;
		const patch = searchForChangesAfterPatch(data, new Date());
		if (patch !== null) {
			setPreferences(queryClient, patch).catch(() => {
				// Change tracking starts on a later load instead.
			});
		}
	}, [data, queryClient]);
}
