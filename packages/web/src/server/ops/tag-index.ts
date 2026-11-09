/**
 * `GET /api/v1/tags/autocomplete?root=<id|empty>&prefix=<#..>&limit=8&fallback=<0|1>&item=<id>&name=..&note=..`
 * -> `{tags: {tag, count}[]}`.
 *
 * `item` with a live `name` and/or `note` counts that item's unsaved editor text in place of its
 * saved text, as upstream's tag counts follow every keystroke (so an in-progress tag counts and a
 * saved partial it replaced does not).
 *
 * Ranks the tags in the zoomed item's live subtree, including the zoom root's
 * own name and note (the whole tree at Home). When a root is given and it yields
 * fewer than `limit` tags, the list is filled from the whole tree unless
 * `fallback=0`.
 */

import {nodeContent, nodeMetadata, nodeTags} from "@outlinedb/shared/db";
import {itemTags} from "@outlinedb/shared/tags";
import type {TaggedText} from "@outlinedb/shared/tags";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {z} from "zod";
import type {ServerContext} from "../context.js";
import {defineOp, ok} from "./define.js";

const DEFAULT_LIMIT = 8;

export interface TagCount {
	tag: string;
	count: number;
}

/** Each tag's count keyed by its lowercase form: once per item, keeping its first-seen casing. */
type TagCounts = ReadonlyMap<string, TagCount>;

interface LiveText {
	id: string;
	name: string | undefined;
	note: string | undefined;
}

/**
 * The `node_tags` rows whose tag starts with `prefix` (case-insensitively), as a range on `tag_key` so its index
 * applies: every key with the prefix sorts at or after it and before it followed by the highest code point.
 */
function prefixRange(prefix: string): SQL {
	const key = prefix.toLowerCase();
	return sql`${nodeTags.tagKey} >= ${key} AND ${nodeTags.tagKey} < ${`${key}\u{10FFFF}`}`;
}

/**
 * Count the live `node_tags` rows of `tagged` (a FROM clause ending in `node_tags`) by tag, keeping
 * each tag's casing from the item with the lowest `node_content` rowid: the first one a rowid-order scan would see.
 * SQLite takes a bare column from the row that holds the group's `min()`.
 */
function countTags(ctx: ServerContext, withClause: SQL, tagged: SQL, prefix: string): TagCounts {
	const rows = ctx.db.all<{key: string; tag: string; count: number}>(sql`
		${withClause}
		SELECT ${nodeTags.tagKey} AS key, ${nodeTags.tag} AS tag, min(c.rowid) AS first, count(*) AS count
		FROM ${tagged}
		INNER JOIN node_content c ON c.id = ${nodeTags.nodeId} AND c.system_to = ${FAR_FUTURE_DATE}
		WHERE ${prefixRange(prefix)}
		GROUP BY ${nodeTags.tagKey}
	`);
	return new Map(rows.map(({key, tag, count}) => [key, {tag, count}]));
}

function wholeTreeTagCounts(ctx: ServerContext, prefix: string): TagCounts {
	return countTags(ctx, sql``, sql`${nodeTags}`, prefix);
}

function subtreeTagCounts(ctx: ServerContext, rootId: string, prefix: string): TagCounts {
	const withClause = sql`
		WITH RECURSIVE subtree(id) AS (
			SELECT id FROM node_content WHERE id = ${rootId} AND system_to = ${FAR_FUTURE_DATE}
			UNION ALL
			SELECT n.id FROM node_content n
			INNER JOIN subtree s ON n.parent_id = s.id
			WHERE n.system_to = ${FAR_FUTURE_DATE}
		)
	`;
	return countTags(ctx, withClause, sql`subtree s INNER JOIN ${nodeTags} ON ${nodeTags.nodeId} = s.id`, prefix);
}

/** Whether `itemId` is `rootId` or one of its live descendants, walking up from the item. */
function inSubtree(ctx: ServerContext, rootId: string, itemId: string): boolean {
	const found = ctx.db.all(sql`
		WITH RECURSIVE up(id, parent) AS (
			SELECT id, parent_id FROM node_content WHERE id = ${itemId} AND system_to = ${FAR_FUTURE_DATE}
			UNION ALL
			SELECT c.id, c.parent_id FROM node_content c
			INNER JOIN up ON c.id = up.parent
			WHERE c.system_to = ${FAR_FUTURE_DATE}
		)
		SELECT 1 FROM up WHERE id = ${rootId} LIMIT 1
	`);
	return found.length > 0;
}

function addItem(counts: Map<string, TagCount>, row: TaggedText): void {
	for (const [lower, tag] of itemTags(row)) {
		const entry = counts.get(lower);
		counts.set(lower, entry ? {tag: entry.tag, count: entry.count + 1} : {tag, count: 1});
	}
}

/** `counts` with one item's `saved` text swapped for its `live` text. */
function swapItemText(counts: TagCounts, saved: TaggedText, live: TaggedText): TagCounts {
	const swapped = new Map(counts);
	for (const lower of itemTags(saved).keys()) {
		const entry = swapped.get(lower);
		if (entry === undefined) {
			continue;
		}
		if (entry.count > 1) {
			swapped.set(lower, {tag: entry.tag, count: entry.count - 1});
		} else {
			swapped.delete(lower);
		}
	}
	addItem(swapped, live);
	return swapped;
}

/** `counts` with the edited item's saved text swapped for its live text, when it has a live row. */
function withLive(ctx: ServerContext, counts: TagCounts, live: LiveText | null): TagCounts {
	if (live === null) {
		return counts;
	}
	const saved = ctx.db
		.select({name: nodeContent.name, note: nodeContent.note, layoutMode: nodeMetadata.layoutMode})
		.from(nodeContent)
		.leftJoin(
			nodeMetadata,
			and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
		)
		.where(and(eq(nodeContent.id, live.id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
		.get();
	if (saved === undefined) {
		return counts;
	}
	return swapItemText(counts, saved, {
		name: live.name ?? saved.name,
		note: live.note ?? saved.note,
		layoutMode: saved.layoutMode,
	});
}

function startsWithDigit(tag: string): boolean {
	return /^\d$/u.test(tag.charAt(1));
}

/** Count desc; on a tie a tag with a digit at index 1 goes last; else plain `<` on the tag. */
function compareTags(a: TagCount, b: TagCount): number {
	if (a.count !== b.count) {
		return b.count - a.count;
	}
	const digitOrder = Number(startsWithDigit(a.tag)) - Number(startsWithDigit(b.tag));
	if (digitOrder !== 0) {
		return digitOrder;
	}
	if (a.tag === b.tag) {
		return 0;
	}
	return a.tag < b.tag ? -1 : 1;
}

/** Upstream's `AppTagIndex.autocomplete` ranking: the tags matching `prefix`, most used first, capped at `limit`. */
export function rankCounts(counts: TagCounts, {prefix, limit}: {prefix: string; limit: number}): TagCount[] {
	const prefixLower = prefix.toLowerCase();
	return [...counts.values()]
		.filter(({tag}) => tag.toLowerCase().startsWith(prefixLower))
		.toSorted(compareTags)
		.slice(0, limit);
}

/** Fill `primary` up to `limit` from `fallback`, skipping tags already listed. */
export function mergeFallback(primary: TagCount[], fallback: TagCount[], limit: number): TagCount[] {
	const listed = new Set(primary.map(({tag}) => tag.toLowerCase()));
	const extra = fallback.filter(({tag}) => !listed.has(tag.toLowerCase()));
	return [...primary, ...extra].slice(0, limit);
}

function parseLimit(raw: string | undefined): number {
	const limit = Math.trunc(Number(raw ?? ""));
	return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}

/** Raw query values, as the route passes them; the op owns every default and fallback. */
const Input = z.object({
	root: z.string().default(""),
	prefix: z.string().default("#"),
	limit: z.string().optional(),
	item: z.string().default(""),
	name: z.string().optional(),
	note: z.string().optional(),
	fallback: z.string().optional(),
});

/** Copies each tag into a plain object literal, which is assignable to `Json` where the `TagCount` interface is not. */
function plain(tags: TagCount[]): {tag: string; count: number}[] {
	return tags.map(({tag, count}) => ({tag, count}));
}

/** Each matching tag with its count, most used first. */
export const TagAutocompleteResponseSchema = z.strictObject({
	tags: z.array(z.strictObject({tag: z.string(), count: z.number()})),
});

export const tagIndexAutocomplete = defineOp({
	input: Input,
	output: TagAutocompleteResponseSchema,
	run(ctx, {root: rawRoot, prefix, limit: rawLimit, item: rawItem, name, note, fallback}) {
		const limit = parseLimit(rawLimit);
		const live: LiveText | null =
			rawItem === "" ? null : {id: ctx.cacheService.resolveShortIdToUuid(rawItem) ?? rawItem, name, note};

		if (rawRoot === "") {
			return ok({tags: plain(rankCounts(withLive(ctx, wholeTreeTagCounts(ctx, prefix), live), {prefix, limit}))});
		}

		const rootId = ctx.cacheService.resolveShortIdToUuid(rawRoot) ?? rawRoot;
		const subtreeLive = live !== null && inSubtree(ctx, rootId, live.id) ? live : null;
		const tags = rankCounts(withLive(ctx, subtreeTagCounts(ctx, rootId, prefix), subtreeLive), {prefix, limit});
		if (tags.length >= limit || fallback === "0") {
			return ok({tags: plain(tags)});
		}
		const global = rankCounts(withLive(ctx, wholeTreeTagCounts(ctx, prefix), live), {prefix, limit: limit * 2});
		return ok({tags: plain(mergeFallback(tags, global, limit))});
	},
});
