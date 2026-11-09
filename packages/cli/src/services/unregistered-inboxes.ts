import {CacheService, findInbox, PathBuilder} from "@outlinedb/shared/cache";
import type * as schema from "@outlinedb/shared/db";
import {stripHtmlTags} from "@outlinedb/shared/html";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";

export function findUnregisteredInboxes(
	database: BetterSQLite3Database<typeof schema>,
	registeredIds: Set<string>,
): {id: string; name: string; path: string}[] {
	const cache = new CacheService(database);
	// SQLite's negative limit searches the entire cache, including deep descendants.
	const named = cache
		.searchText({query: "Inbox", limit: -1})
		.map((node) => ({id: node.id, name: stripHtmlTags(node.name ?? "").trim()}))
		.filter(({id, name}) => (name === "Inbox" || name === "📥 Inbox") && !registeredIds.has(id));
	// Root metadata `inbox_id` names the account Inbox whatever it is called.
	const accountInbox = findInbox(database);
	const unregistered =
		accountInbox === undefined || registeredIds.has(accountInbox.id) || named.some(({id}) => id === accountInbox.id)
			? named
			: [...named, {id: accountInbox.id, name: accountInbox.name}];
	const paths = new PathBuilder(database).buildFullPathsBatch(unregistered.map(({id}) => id));
	return unregistered
		.map(({id, name}) => ({id, name, path: paths.get(id) ?? ""}))
		.toSorted((left, right) => left.id.localeCompare(right.id));
}
