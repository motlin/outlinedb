import {and, eq} from "drizzle-orm";
import type {AppDatabase} from "../db/types.js";
import {nodeContent, rootPreferences} from "../db/schema.js";
import {stripHtmlTags} from "../html/strip-tags.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {CacheService} from "./cache-service.js";

/** The name of the Home child that serves as the Inbox when root metadata `inbox_id` names no live node. */
export const INBOX_NAME = "Inbox";

/** The account's Inbox, and whether root metadata `inbox_id` or the Home child's name located it. */
export interface InboxLookup
{
	id: string;
	name: string;
	source: "inbox_id" | "name";
}

/**
 * The account's Inbox, or undefined: the live node root metadata `inbox_id`
 * (`root_preferences.inbox_id`) names, like upstream's `WF.AppInbox.id`, else the
 * Home child named `Inbox`. Upstream's `AppInbox.ensured` creates and records a
 * missing Inbox; this read-only lookup leaves that to a write-through caller.
 */
export function findInbox(db: AppDatabase): InboxLookup | undefined
{
	const pointed = db
		.select(
			{
				id: nodeContent.id,
				name: nodeContent.name,
			},
		)
		.from(rootPreferences)
		.innerJoin(nodeContent, eq(nodeContent.id, rootPreferences.inboxId))
		.where(and(eq(rootPreferences.systemTo, FAR_FUTURE_DATE), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
		.get();
	if (pointed)
	{
		return {
			id: pointed.id,
			name: stripHtmlTags(pointed.name ?? "").trim(),
			source: "inbox_id",
		};
	}
	const named = new CacheService(db).getChildByName(null, INBOX_NAME);
	return named
		?
			{
				id: named.id,
				name: stripHtmlTags(named.name ?? "").trim(),
				source: "name",
			}
		: undefined;
}
