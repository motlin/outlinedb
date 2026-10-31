import {describe, expect, it} from "vite-plus/test";
import {EMPTY_PREFERENCES} from "../src/client/hooks/use-preferences.js";
import type {PreferencesState} from "../src/client/hooks/use-preferences.js";
import {searchForChangesAfterPatch} from "../src/client/search-for-changes-after.js";

const NOW = new Date("2026-10-31T12:00:00.000Z");

function loaded(searchForChangesAfter: string | null): PreferencesState {
	return {preferences: {...EMPTY_PREFERENCES, searchForChangesAfter}, available: true, error: null};
}

describe("searchForChangesAfterPatch", () => {
	it("sets the start to now when it is missing, in the future, or already past (left alone)", () => {
		expect({
			missing: searchForChangesAfterPatch(loaded(null), NOW),
			future: searchForChangesAfterPatch(loaded("2026-11-01T00:00:00.000Z"), NOW),
			past: searchForChangesAfterPatch(loaded("2020-01-01T00:00:00.000Z"), NOW),
			exactlyNow: searchForChangesAfterPatch(loaded(NOW.toISOString()), NOW),
		}).toStrictEqual({
			missing: {searchForChangesAfter: "2026-10-31T12:00:00.000Z"},
			future: {searchForChangesAfter: "2026-10-31T12:00:00.000Z"},
			past: null,
			exactlyNow: null,
		});
	});

	it("writes nothing while preferences load or when the internal API is unavailable", () => {
		expect({
			loading: searchForChangesAfterPatch(undefined, NOW),
			unavailable: searchForChangesAfterPatch(
				{preferences: EMPTY_PREFERENCES, available: false, error: "not configured"},
				NOW,
			),
		}).toStrictEqual({loading: null, unavailable: null});
	});
});
