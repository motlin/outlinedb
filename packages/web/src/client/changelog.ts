/**
 * Our What's New read state: the ids of our entries the user has seen (`/api/v1/whats-new`), which drive the blue
 * dots on Help, What's New and the kebab, and each entry's unread dot.
 */

import {WHATS_NEW_ENTRIES} from "./whats-new-entries.js";

export type ChangelogRead = readonly string[];

/** The ids of our entries not read yet. */
export function unreadChangelogEntries(read: ChangelogRead): string[]
{
	return WHATS_NEW_ENTRIES.filter((entry) => !read.includes(entry.id)).map((entry) => entry.id);
}

/** Upstream What's New `blueDot`: one of our entries is not read yet. */
export function changelogUnread(read: ChangelogRead): boolean
{
	return unreadChangelogEntries(read).length > 0;
}

/** An entry shows its unread dot until it is read. */
export function changelogEntryUnread(read: ChangelogRead, id: string): boolean
{
	return !read.includes(id);
}
