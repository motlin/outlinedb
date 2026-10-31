import {QueryClient} from "@tanstack/react-query";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {CHANGELOG_ENTRIES} from "../src/client/changelog-entries.js";
import {
	EMPTY_PREFERENCES,
	changelogUnreadFrom,
	markChangelogRead,
	preferenceKeys,
	premarkChangelog,
} from "../src/client/hooks/use-preferences.js";
import type {PreferencesState} from "../src/client/hooks/use-preferences.js";

const ALL_READ = Object.fromEntries(CHANGELOG_ENTRIES.map((entry) => [entry.id, true]));
const NEWER = new Date(2026, 0, 1).toISOString();

function available(changelogRead: Record<string, boolean> | null): PreferencesState {
	return {preferences: {...EMPTY_PREFERENCES, changelogRead}, available: true, error: null};
}

const UNAVAILABLE: PreferencesState = {preferences: EMPTY_PREFERENCES, available: false, error: "x"};

function preferencesClient(state: PreferencesState | undefined): QueryClient {
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	if (state !== undefined) {
		queryClient.setQueryData(preferenceKeys.all, state);
	}
	return queryClient;
}

function stubFetch(): {url: string; method: string; body: unknown}[] {
	const requests: {url: string; method: string; body: unknown}[] = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		requests.push({url, method: init?.method ?? "GET", body: JSON.parse(init?.body as string) as unknown});
		return Promise.resolve(Response.json({...EMPTY_PREFERENCES, changelogRead: ALL_READ}));
	});
	return requests;
}

describe("changelogUnreadFrom", () => {
	it("is false while loading or unavailable, where the flags can never be cleared, and follows the stored flags otherwise", () => {
		expect({
			loading: changelogUnreadFrom(undefined),
			unavailable: changelogUnreadFrom(UNAVAILABLE),
			neverRead: changelogUnreadFrom(available(null)),
			oneUnread: changelogUnreadFrom(available({...ALL_READ, may27_2025: false})),
			allRead: changelogUnreadFrom(available(ALL_READ)),
		}).toStrictEqual({loading: false, unavailable: false, neverRead: true, oneUnread: true, allRead: false});
	});
});

describe("markChangelogRead", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("PATCHes every entry read, merged with the stored flags, and stores the answer", async () => {
		const requests = stubFetch();
		const queryClient = preferencesClient(available({may27_2025: true, liked_elsewhere: false}));
		await markChangelogRead(queryClient);
		expect({
			requests,
			cached: queryClient.getQueryData<PreferencesState>(preferenceKeys.all)?.preferences.changelogRead,
		}).toStrictEqual({
			requests: [
				{
					url: "/api/v1/preferences",
					method: "PATCH",
					body: {changelogRead: {may27_2025: true, liked_elsewhere: false, ...ALL_READ}},
				},
			],
			cached: ALL_READ,
		});
	});

	it("issues no request when every entry is read, or while loading or unavailable", async () => {
		const requests = stubFetch();
		await markChangelogRead(preferencesClient(available(ALL_READ)));
		await markChangelogRead(preferencesClient(undefined));
		await markChangelogRead(preferencesClient(UNAVAILABLE));
		expect(requests).toStrictEqual([]);
	});
});

describe("premarkChangelog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("marks every entry read for an account that joined after the cutoff with no changelog.read", async () => {
		const requests = stubFetch();
		await premarkChangelog(preferencesClient(available(null)), NEWER);
		expect(requests).toStrictEqual([
			{url: "/api/v1/preferences", method: "PATCH", body: {changelogRead: ALL_READ}},
		]);
	});

	it("leaves older accounts, stored flags, loading and unavailable preferences alone", async () => {
		const requests = stubFetch();
		await premarkChangelog(preferencesClient(available(null)), "2017-07-14T02:40:00.000Z");
		await premarkChangelog(preferencesClient(available({})), NEWER);
		await premarkChangelog(preferencesClient(undefined), NEWER);
		await premarkChangelog(preferencesClient(UNAVAILABLE), NEWER);
		expect(requests).toStrictEqual([]);
	});
});
