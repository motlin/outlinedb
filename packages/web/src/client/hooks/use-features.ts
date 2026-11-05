/**
 * Account feature flags over `/api/v1/features`: the server's visible list and the enabled dict.
 * Toggling is optimistic like upstream's `WF.Features.toggle`, but restores the previous dict when
 * the POST fails (upstream keeps the optimistic value).
 */

import {useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import type {FeatureSetResponse, FeaturesResponse} from "../../node-types.js";
import {DEFAULT_FEATURES, isFeatureOn, setAccountFeatures} from "../features.js";
import type {FeatureName} from "../features.js";
import {readJson} from "../read-json.js";

export const featureKeys = {all: ["features"] as const};

const LOADING: FeaturesResponse = {visible: [], enabled: DEFAULT_FEATURES, available: false};

async function fetchFeatures(): Promise<FeaturesResponse> {
	const response = await fetch("/api/v1/features");
	if (!response.ok) {
		throw new Error(`Failed to fetch features: ${response.status}`);
	}
	return readJson<FeaturesResponse>(response);
}

/** Optimistically flip `codename`, POST it, then store the server's dict (or restore on failure). */
export async function setFeature(queryClient: QueryClient, codename: string, on: boolean): Promise<void> {
	await queryClient.cancelQueries({queryKey: featureKeys.all});
	const previous = queryClient.getQueryData<FeaturesResponse>(featureKeys.all) ?? LOADING;
	const optimistic: Record<string, true> = on
		? {...previous.enabled, [codename]: true}
		: Object.fromEntries(Object.entries(previous.enabled).filter(([name]) => name !== codename));
	queryClient.setQueryData<FeaturesResponse>(featureKeys.all, {...previous, enabled: optimistic});
	setAccountFeatures(optimistic);
	try {
		const response = await fetch(`/api/v1/features/${encodeURIComponent(codename)}`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({on}),
		});
		if (!response.ok) {
			throw new Error(`Failed to set feature ${codename}: ${response.status}`);
		}
		const {enabled} = await readJson<FeatureSetResponse>(response);
		queryClient.setQueryData<FeaturesResponse>(featureKeys.all, {...previous, enabled, available: true});
		setAccountFeatures(enabled);
	} catch (error) {
		queryClient.setQueryData(featureKeys.all, previous);
		setAccountFeatures(previous.enabled);
		throw error;
	}
}

export interface UseFeatures extends FeaturesResponse {
	setFeature: (codename: string, on: boolean) => Promise<void>;
}

export function useFeatures(): UseFeatures {
	const queryClient = useQueryClient();
	const {data = LOADING} = useQuery({queryKey: featureKeys.all, queryFn: fetchFeatures});
	const loaded = data !== LOADING;
	useEffect(() => {
		if (loaded) {
			setAccountFeatures(data.enabled);
		}
	}, [data, loaded]);
	return {...data, setFeature: async (codename, on) => setFeature(queryClient, codename, on)};
}

/**
 * Whether `codename` is on, re-rendering when the account's dict changes. Until the dict loads this is the
 * `isFeatureOn` fallback, so a gated surface does not flash away on first paint.
 */
export function useFeatureOn(codename: FeatureName): boolean {
	const {data} = useQuery({queryKey: featureKeys.all, queryFn: fetchFeatures});
	return data === undefined ? isFeatureOn(codename) : data.enabled[codename] === true;
}
