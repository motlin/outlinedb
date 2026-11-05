/**
 * Mirrors the account's feature flags into the outline store, kept apart from `use-features.ts` so the features hook
 * stays free of the store's module graph.
 */

import {useEffect} from "react";
import {featureStoreState} from "../features.js";
import {useOutlineStore} from "../stores/outline.js";
import {useFeatures} from "./use-features.js";

/** Keeps the store fields that mirror account flags in step with the features query, as upstream re-renders at once. */
export function useFeatureStoreSync(): void {
	const {enabled, available, visible} = useFeatures();
	const loaded = available || visible.length > 0 || Object.keys(enabled).length > 0;
	useEffect(() => {
		if (loaded) {
			useOutlineStore.setState(featureStoreState(enabled));
		}
	}, [enabled, loaded]);
}
