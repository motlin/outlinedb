/**
 * Account-global preferences over `/api/v1/preferences`, backed by upstream's root
 * metadata and account settings so they match workflowy.com. Changes PATCH only the changed keys and
 * update the `["preferences"]` query optimistically, rolling back on failure.
 */

import {useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useMemo} from "react";
import type {OpErrorBody, Preferences} from "../../node-types.js";
import {resolveDateSettings} from "../date-settings.js";
import type {DateSettings} from "../date-settings.js";
import {readJson} from "../read-json.js";
import {embedFor, firstLinkHref} from "../components/embeds.js";
import type {Embed} from "../components/embeds.js";

export type {Preferences} from "../../node-types.js";

export type PreferencesPatch = Partial<Omit<Preferences, "account">>;

export interface PreferencesState {
	preferences: Preferences;
	/** False when the internal API is not configured (503); preferences are then the defaults. */
	available: boolean;
	/** The endpoint's error text when unavailable. */
	error: string | null;
}

export const preferenceKeys = {all: ["preferences"] as const};

export const EMPTY_PREFERENCES: Preferences = {
	dateFormat: null,
	timeFormat: null,
	weekStartDay: null,
	slashDiscovered: false,
	calendarTooltipSeen: false,
	emojiSelected: null,
	aiEmbeddingStatus: null,
	aiEmbeddingTooltipDismissed: false,
	notesRootId: null,
	showCompleted: false,
	showKeyboardShortcuts: false,
	sameColorForLinks: false,
	theme: null,
	font: null,
	displayImagePreviewsAsThumbnails: false,
	ignoreYoutube: false,
	ignoreYtShort: false,
	ignoreTwitter: false,
	ignoreLoom: false,
	unsubscribeFromSummaryEmails: false,
	unsubscribeFromCommentsEmails: false,
	backupToDropbox: false,
	weeklyReportOn: false,
	latestColor: null,
	searchForChangesAfter: null,
	account: null,
	mfa: null,
	changelogRead: null,
};

const LOADING: PreferencesState = {preferences: EMPTY_PREFERENCES, available: true, error: null};

export async function fetchPreferences(): Promise<PreferencesState> {
	const response = await fetch("/api/v1/preferences");
	if (response.status === 503) {
		const {error = null} = await readJson<OpErrorBody>(response);
		return {preferences: EMPTY_PREFERENCES, available: false, error};
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch preferences: ${response.status}`);
	}
	return {preferences: await readJson<Preferences>(response), available: true, error: null};
}

/** Apply `patch` to the cache, PATCH it, then store the server's answer (or restore on failure). */
export async function setPreferences(queryClient: QueryClient, patch: PreferencesPatch): Promise<void> {
	await queryClient.cancelQueries({queryKey: preferenceKeys.all});
	const previous = queryClient.getQueryData<PreferencesState>(preferenceKeys.all) ?? LOADING;
	queryClient.setQueryData<PreferencesState>(preferenceKeys.all, {
		...previous,
		preferences: {...previous.preferences, ...patch},
	});
	try {
		const response = await fetch("/api/v1/preferences", {
			method: "PATCH",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify(patch),
		});
		if (!response.ok) {
			throw new Error(`Failed to update preferences: ${response.status}`);
		}
		const preferences = await readJson<Preferences>(response);
		queryClient.setQueryData<PreferencesState>(preferenceKeys.all, {preferences, available: true, error: null});
	} catch (error) {
		queryClient.setQueryData(preferenceKeys.all, previous);
		throw error;
	}
}

/** The account's `slashDiscovered`; true while loading or unavailable so the slash hint never flashes. */
export function slashDiscoveredFrom(state: PreferencesState | undefined): boolean {
	return state?.available === true ? state.preferences.slashDiscovered : true;
}

/** Upstream `WF.Slash.discover()`: the first slash-menu open turns the placeholder hint off for good. */
export async function markSlashDiscovered(queryClient: QueryClient): Promise<void> {
	if (!slashDiscoveredFrom(queryClient.getQueryData<PreferencesState>(preferenceKeys.all))) {
		await setPreferences(queryClient, {slashDiscovered: true});
	}
}

/** Whether the slash menu has been discovered on this account (true while loading or unavailable). */
export function useSlashDiscovered(): boolean {
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	return slashDiscoveredFrom(data);
}

/**
 * The account's `calendarTooltipSeen` (upstream `calendar.tooltip_seen`): null while loading so neither Today nor the
 * onboarding tooltip flashes, and true when the internal API is unavailable, where the flag could never be saved.
 */
export function calendarTooltipSeenFrom(state: PreferencesState | undefined): boolean | null {
	if (state === undefined) {
		return null;
	}
	return state.available ? state.preferences.calendarTooltipSeen : true;
}

/** Whether the calendar onboarding tooltip has been seen; null while loading. */
export function useCalendarTooltipSeen(): boolean | null {
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	return calendarTooltipSeenFrom(data);
}

/** Upstream `WF.CoreKv.set("calendar.tooltip_seen", true)`: dismissing or trying the onboarding tooltip retires it. */
export async function markCalendarTooltipSeen(queryClient: QueryClient): Promise<void> {
	if (calendarTooltipSeenFrom(queryClient.getQueryData<PreferencesState>(preferenceKeys.all)) === false) {
		await setPreferences(queryClient, {calendarTooltipSeen: true});
	}
}

/**
 * Where upstream's AI embedding onboarding stands (root metadata `ai.embeddingStatus`): `onboarding` shows the
 * Enable AI prompt, `requested` waits for the server to index the notes, and `ready` allows AI/semantic UI. Loading
 * gates everything; an unavailable internal API, where the status can never be read or saved, counts as ready.
 */
export type AiEmbeddingStage = "loading" | "onboarding" | "requested" | "ready";

export function aiEmbeddingStageFrom(state: PreferencesState | undefined): AiEmbeddingStage {
	if (state === undefined) {
		return "loading";
	}
	if (!state.available) {
		return "ready";
	}
	const status = state.preferences.aiEmbeddingStatus;
	if (status === null) {
		return "onboarding";
	}
	return status === "requested" ? "requested" : "ready";
}

/** The account's AI embedding onboarding stage. */
export function useAiEmbeddingStage(): AiEmbeddingStage {
	const {data} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	return aiEmbeddingStageFrom(data);
}

/** Upstream's chat mount: `WF.CoreKv.get("ai.embedding_tooltip_dismissed") || WF.CoreKv.set(..., true)`. */
export async function markAiEmbeddingTooltipDismissed(queryClient: QueryClient): Promise<void> {
	const state = queryClient.getQueryData<PreferencesState>(preferenceKeys.all);
	if (state?.available === true && !state.preferences.aiEmbeddingTooltipDismissed) {
		await setPreferences(queryClient, {aiEmbeddingTooltipDismissed: true});
	}
}

export interface UsePreferences extends PreferencesState {
	dateSettings: DateSettings;
	setPreferences: (patch: PreferencesPatch) => Promise<void>;
}

export function usePreferences(): UsePreferences {
	const queryClient = useQueryClient();
	const {data = LOADING} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	const dateSettings = useMemo(() => resolveDateSettings(data.preferences), [data.preferences]);
	return {
		...data,
		dateSettings,
		setPreferences: async (patch) => setPreferences(queryClient, patch),
	};
}

/** The account's date settings for pill labels; upstream defaults while loading or unavailable. */
export function useDateSettings(): DateSettings {
	return usePreferences().dateSettings;
}

/** The account's `showCompleted` once preferences load; null while loading or when the internal API is unavailable. */
export function serverShowCompleted(state: PreferencesState | undefined): boolean | null {
	return state?.available === true ? state.preferences.showCompleted : null;
}

/** The account's `showKeyboardShortcuts` once preferences load; null while loading or when the internal API is unavailable. */
export function serverShowKeyboardShortcuts(state: PreferencesState | undefined): boolean | null {
	return state?.available === true ? state.preferences.showKeyboardShortcuts : null;
}

/** The account's `theme` once preferences load; null while loading, unavailable or unset. */
export function serverTheme(state: PreferencesState | undefined): string | null {
	return state?.available === true ? state.preferences.theme : null;
}

/** The account's `font` once preferences load; null while loading, unavailable or unset. */
export function serverFont(state: PreferencesState | undefined): string | null {
	return state?.available === true ? state.preferences.font : null;
}

/** The embed a row's first link gets under the account's embed flags, or null; a row re-renders only when its own embed changes. */
export function useRowEmbed(nameHtml: string | null): Embed | null {
	const {data} = useQuery({
		queryKey: preferenceKeys.all,
		queryFn: fetchPreferences,
		select: (state): Embed | null => {
			const href = firstLinkHref(nameHtml);
			return href === null ? null : embedFor(href, state.preferences);
		},
	});
	return data ?? null;
}
