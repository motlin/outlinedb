import {describe, expect, it} from "vite-plus/test";
import {changelogEntryUnread, changelogUnread, unreadChangelogEntries} from "../src/client/changelog.js";
import {WHATS_NEW_ENTRIES} from "../src/client/whats-new-entries.js";

describe("What's New entries", () => {
	it("announces only our own features, starting with as-of queries", () => {
		expect(WHATS_NEW_ENTRIES.map(({id, date, title}) => ({id, date, title}))).toStrictEqual([
			{id: "as_of_queries", date: "October 31st, 2026", title: "As-of queries: see what changed since any time"},
		]);
	});

	it("links nowhere on workflowy.com and embeds no upstream media", () => {
		const serialized = JSON.stringify(WHATS_NEW_ENTRIES);
		expect({
			workflowy: serialized.includes("workflowy.com"),
			media: /"t":"(img|video)"/u.test(serialized),
		}).toStrictEqual({workflowy: false, media: false});
	});
});

describe("changelogUnread", () => {
	it("is true while any of our entries is not read, ignoring ids that are not ours", () => {
		expect([
			changelogUnread([]),
			changelogUnread(["unknown_entry"]),
			changelogUnread(["as_of_queries"]),
		]).toStrictEqual([true, true, false]);
	});
});

describe("changelogEntryUnread", () => {
	it("flags an entry until it is read", () => {
		expect([
			changelogEntryUnread([], "as_of_queries"),
			changelogEntryUnread(["as_of_queries"], "as_of_queries"),
		]).toStrictEqual([true, false]);
	});
});

describe("unreadChangelogEntries", () => {
	it("lists the ids of our entries that are not read yet", () => {
		expect([unreadChangelogEntries([]), unreadChangelogEntries(["as_of_queries"])]).toStrictEqual([
			["as_of_queries"],
			[],
		]);
	});
});
