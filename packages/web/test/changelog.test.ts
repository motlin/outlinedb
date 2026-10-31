import {describe, expect, it} from "vite-plus/test";
import {
	CHANGELOG_PREMARK_JOINED_AFTER,
	changelogEntryUnread,
	changelogUnread,
	unreadChangelogFlags,
	shouldPremarkChangelog,
} from "../src/client/changelog.js";
import {CHANGELOG_ENTRIES} from "../src/client/changelog-entries.js";

const ALL_READ = Object.fromEntries(CHANGELOG_ENTRIES.map((entry) => [entry.id, true]));

describe("changelog entries", () => {
	it("holds upstream's 34 entries newest first, from september07_2026 to may27_2025", () => {
		expect({
			count: CHANGELOG_ENTRIES.length,
			first: CHANGELOG_ENTRIES.at(0)?.id,
			last: CHANGELOG_ENTRIES.at(-1)?.id,
			lastHeader: [CHANGELOG_ENTRIES.at(-1)?.date, CHANGELOG_ENTRIES.at(-1)?.title],
		}).toStrictEqual({
			count: 34,
			first: "september07_2026",
			last: "may27_2025",
			lastHeader: ["May 27th, 2025", "2025.2 - Patch Notes"],
		});
	});
});

describe("changelogUnread (upstream What's New blueDot)", () => {
	it("is true with no changelog.read at all, or while any entry is missing or false, and false once every entry is read", () => {
		expect([
			changelogUnread(null),
			changelogUnread({}),
			changelogUnread({...ALL_READ, may27_2025: false}),
			changelogUnread(Object.fromEntries(Object.entries(ALL_READ).slice(1))),
			changelogUnread(ALL_READ),
			changelogUnread({...ALL_READ, unknown_entry: false}),
		]).toStrictEqual([true, true, true, true, false, false]);
	});
});

describe("changelogEntryUnread (upstream Ut0)", () => {
	it("flags only an entry with no stored value, so a stored false shows no dot", () => {
		expect([
			changelogEntryUnread(null, "may27_2025"),
			changelogEntryUnread({}, "may27_2025"),
			changelogEntryUnread({may27_2025: false}, "may27_2025"),
			changelogEntryUnread({may27_2025: true}, "may27_2025"),
		]).toStrictEqual([true, true, false, false]);
	});
});

describe("unreadChangelogFlags", () => {
	it("marks every entry that is not stored as true, keeping the read ones out", () => {
		const read = Object.fromEntries(CHANGELOG_ENTRIES.slice(2).map((entry) => [entry.id, true]));
		expect([
			unreadChangelogFlags({...read, [CHANGELOG_ENTRIES[1].id]: false}),
			unreadChangelogFlags(ALL_READ),
		]).toStrictEqual([{september07_2026: true, august05_2026: true}, {}]);
	});

	it("marks every entry with no changelog.read", () => {
		expect(unreadChangelogFlags(null)).toStrictEqual(ALL_READ);
	});
});

describe("shouldPremarkChangelog (upstream Ht0)", () => {
	it("pre-marks only accounts that joined after 2025-05-26 (local midnight) and never stored changelog.read", () => {
		const after = new Date(CHANGELOG_PREMARK_JOINED_AFTER.getTime() + 1000).toISOString();
		const at = CHANGELOG_PREMARK_JOINED_AFTER.toISOString();
		expect({
			cutoff: [
				CHANGELOG_PREMARK_JOINED_AFTER.getFullYear(),
				CHANGELOG_PREMARK_JOINED_AFTER.getMonth(),
				CHANGELOG_PREMARK_JOINED_AFTER.getDate(),
				CHANGELOG_PREMARK_JOINED_AFTER.getHours(),
			],
			newAccount: shouldPremarkChangelog(null, after),
			atCutoff: shouldPremarkChangelog(null, at),
			oldAccount: shouldPremarkChangelog(null, "2017-07-14T02:40:00.000Z"),
			alreadyStored: shouldPremarkChangelog({}, after),
		}).toStrictEqual({
			cutoff: [2025, 4, 26, 0],
			newAccount: true,
			atCutoff: false,
			oldAccount: false,
			alreadyStored: false,
		});
	});
});
