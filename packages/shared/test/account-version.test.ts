import {describe, expect, it} from "vite-plus/test";
import {accountVersion} from "../src/cache/account-seed.js";
import type {AccountRows} from "../src/cache/account-store.js";

const EMPTY: AccountRows = {
	account: [],
	rootPreferences: [],
	accountSettings: [],
	tagColors: [],
	stars: [],
	starOrder: [],
	locationRenames: [],
	enabledFeatures: [],
	visibleFeatures: [],
	changelogReads: [],
	surveys: [],
	savedViews: [],
	aiAssistants: [],
	aiPromptButtons: [],
};

describe("accountVersion", () => {
	it("moves when a row changes and ignores row order", () => {
		const a = {codename: "a", enabled: 1};
		const b = {codename: "full_width_page", enabled: 1};
		expect({
			empty: accountVersion(EMPTY) === accountVersion({...EMPTY}),
			reordered:
				accountVersion({...EMPTY, enabledFeatures: [a, b]}) ===
				accountVersion({...EMPTY, enabledFeatures: [b, a]}),
			added: accountVersion(EMPTY) === accountVersion({...EMPTY, enabledFeatures: [b]}),
			format: /^[0-9a-f]{16}$/u.test(accountVersion(EMPTY)),
		}).toStrictEqual({empty: true, reordered: true, added: false, format: true});
	});
});
