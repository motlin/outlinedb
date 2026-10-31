/**
 * Upstream's What's New read state (`changelog.read.<id>` in root metadata, served as preferences
 * `changelogRead`): the Help menu's blue dot, each entry's unread dot and the boot-time pre-mark for new accounts.
 */

import {CHANGELOG_ENTRIES} from "./changelog-entries.js";

export type ChangelogRead = Readonly<Record<string, boolean>> | null;

/** Upstream `Ht0`'s cutoff, `new Date(2025, 4, 26)`: local midnight of 2025-05-26. */
export const CHANGELOG_PREMARK_JOINED_AFTER = new Date(2025, 4, 26);

/** Upstream What's New `blueDot`: no `changelog.read` at all, or an entry that is missing or false. */
export function changelogUnread(read: ChangelogRead): boolean {
	return read === null || CHANGELOG_ENTRIES.some((entry) => read[entry.id] !== true);
}

/** Upstream `Ut0`: an entry shows its unread dot only while it has no stored value at all. */
export function changelogEntryUnread(read: ChangelogRead, id: string): boolean {
	return read?.[id] === undefined;
}

/** The flags that mark every entry not yet stored as read; empty when all are read. */
export function unreadChangelogFlags(read: ChangelogRead): Record<string, true> {
	return Object.fromEntries(
		CHANGELOG_ENTRIES.filter((entry) => read?.[entry.id] !== true).map((entry) => [entry.id, true] as const),
	);
}

/** Upstream `Ht0`: an account that joined after the cutoff and never stored `changelog.read` starts with all read. */
export function shouldPremarkChangelog(read: ChangelogRead, joinedAt: string): boolean {
	return read === null && Date.parse(joinedAt) > CHANGELOG_PREMARK_JOINED_AFTER.getTime();
}
