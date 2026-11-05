import {z} from "zod";
import {PathBuilder} from "@workflowy/shared/cache";
import {nodeContent, nodeMetadata} from "@workflowy/shared/db";
import type {AppDatabase} from "@workflowy/shared/db";
import {buildSearchConditions, getScoringTerms, parseSearchQuery, resolveJoinedSec} from "@workflowy/shared/search";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {stripHtmlTags} from "@workflowy/shared/html";
import {and, eq, inArray, sql} from "drizzle-orm";
import {toUnixSeconds} from "./nodes-shared.js";
import {notReferencesContent} from "../backlinks.js";
import {collectHelperTags} from "../helper-tags.js";
import type {HelperTags} from "../helper-tags.js";
import type {ServerContext} from "../context.js";
import {filterLocations} from "../location-search.js";
import {rankSwitcher, rankSwitcherPaged} from "../switcher-search.js";
import type {RankSwitcherOptions, SwitcherResponse} from "../switcher-search.js";
import {computeTreeSearch} from "../tree-search.js";
import type {TreeSearchRow} from "../tree-search.js";
import {defineOp, ok, toJson} from "./define.js";
import {
	loadTreeRowText,
	loadTreeRows,
	loadTreeRowsWithBacklinks,
	loadTreeSearchRows,
	loadTreeSkeletonRows,
	queryNeedsBacklinks,
} from "../tree-snapshot.js";

type TreeLoader = (database: AppDatabase, rootId: string | null) => TreeSearchRow[];

/** The snapshot loader, or the SQL subtree query when `features.treeSnapshot` is off (no whole tree held in memory). */
function treeLoader(ctx: ServerContext): TreeLoader {
	return ctx.config.features.treeSnapshot ? loadTreeRows : loadTreeSearchRows;
}

/** Rows of text per read when the jump menu pages the text (`features.treeSnapshot` off). */
const SWITCHER_TEXT_PAGE_SIZE = 2000;

type SwitcherRanker = (
	rows: readonly TreeSearchRow[],
	query: string,
	starredIds: readonly string[],
	nowSec: number,
	options: RankSwitcherOptions,
) => SwitcherResponse;

/**
 * The jump menu's rows and ranking: the snapshot with {@link rankSwitcher}, or, with `features.treeSnapshot` off
 * (a Durable Object cannot hold every row's text), the text-free skeleton with {@link rankSwitcherPaged}.
 */
function switcherSearch(ctx: ServerContext): {rows: TreeSearchRow[]; rank: SwitcherRanker} {
	if (ctx.config.features.treeSnapshot) {
		return {rows: loadTreeRows(ctx.db, null), rank: rankSwitcher};
	}
	const source = {pageSize: SWITCHER_TEXT_PAGE_SIZE, read: (ids: readonly string[]) => loadTreeRowText(ctx.db, ids)};
	return {
		rows: loadTreeSkeletonRows(ctx.db),
		rank: (rows, query, starredIds, nowSec, options) =>
			rankSwitcherPaged(rows, query, starredIds, nowSec, options, source),
	};
}

const SearchResultSchema = z.strictObject({
	id: z.string(),
	name: z.string().nullable(),
	note: z.string().nullable(),
	parentPath: z.string(),
	/** Completion time in epoch seconds, or null when incomplete (as in the node responses). */
	completedAt: z.number().nullable(),
});

type SearchResult = z.output<typeof SearchResultSchema>;

const TextSearchResponseSchema = z.strictObject({results: z.array(SearchResultSchema), totalCount: z.number()});

export const HelperTagsSchema = z.strictObject({hashTags: z.array(z.string()), atTags: z.array(z.string())});

const TreeSearchResultSchema = z.strictObject({
	matchIds: z.array(z.string()),
	nameMatchIds: z.array(z.string()),
	noteMatchIds: z.array(z.string()),
	/** Operator-only matches: matched without a name or note text match. */
	metaMatchIds: z.array(z.string()),
	/** Nodes (excluding the root) with at least one matching descendant. */
	ancestorIds: z.array(z.string()),
	/** Ancestors with at least one child that neither matches nor has matching descendants. */
	halfExpandedIds: z.array(z.string()),
	rootHalfExpanded: z.boolean(),
	/** Matches that are completed or sit under a completed ancestor. */
	completedMatchCount: z.number(),
	matchCount: z.number(),
	revealsCompleted: z.boolean(),
});

const SwitcherAncestorSchema = z.strictObject({id: z.string(), name: z.string()});

const SwitcherResponseSchema = z.strictObject({
	results: z.array(
		z.strictObject({
			id: z.string(),
			labelHtml: z.string(),
			completed: z.boolean(),
			starred: z.boolean(),
			/** Root-first, without Home; names are whole (the client slices them). */
			ancestors: z.array(SwitcherAncestorSchema),
		}),
	),
	hasMore: z.boolean(),
});

export const LocationResponseSchema = z.strictObject({
	results: z.array(
		z.strictObject({
			id: z.string(),
			labelHtml: z.string(),
			/** Root-first, without Home. */
			ancestors: z.array(SwitcherAncestorSchema),
		}),
	),
	hasMore: z.boolean(),
});

// Get all descendant node IDs using a recursive CTE
function getDescendantIds(database: AppDatabase, parentId: string): string[] {
	const result = database.all<{id: string}>(sql`
		WITH RECURSIVE descendants(id) AS (
			SELECT id FROM node_content
			WHERE parent_id = ${parentId}
			AND system_to = ${FAR_FUTURE_DATE}
			UNION ALL
			SELECT n.id FROM node_content n
			INNER JOIN descendants d ON n.parent_id = d.id
			WHERE n.system_to = ${FAR_FUTURE_DATE}
		)
		SELECT id FROM descendants
	`);
	return result.map((row) => row.id);
}

/** Search helper #tags/@tags of the live descendants of `rootId`, excluding the root (whole tree when empty). */
export function loadHelperTags(database: AppDatabase, rootId: string, load: TreeLoader = loadTreeRows): HelperTags {
	const rows = load(database, rootId === "" ? null : rootId);
	return collectHelperTags(rows.filter((row) => row.id !== rootId));
}

/** `GET /api/search/helpers?rootId=` - subtree tags for the search helper's #TAGS / @TAGS sections. */
export const searchHelpers = defineOp({
	input: z.object({rootId: z.string()}),
	output: HelperTagsSchema,
	run: (ctx, {rootId}) => ok(toJson(loadHelperTags(ctx.db, rootId, treeLoader(ctx)))),
});

/** The account's stored date format (so strict `date:` queries parse it), or null when unset or unavailable. */
async function loadDateFormat(ctx: ServerContext): Promise<string | null> {
	const adapter = ctx.internalAdapter?.();
	if (!adapter) {
		return null;
	}
	try {
		const value = await adapter.getRootMeta(["dateFormat"]);
		return typeof value === "string" && value !== "" ? value : null;
	} catch {
		return null;
	}
}

/** The account's week start (Monday = 1), or null for Sunday, unset or unavailable. */
async function loadWeekStartDay(ctx: ServerContext): Promise<0 | 1 | null> {
	const adapter = ctx.internalAdapter?.();
	if (!adapter) {
		return null;
	}
	try {
		const value = await adapter.getRootMeta(["weekStartDay"]);
		return value === 1 ? 1 : value === 0 ? 0 : null;
	} catch {
		return null;
	}
}

/** `POST /api/search/tree` - in-place search of the zoomed subtree, driven by the upstream query AST. */
export const searchTree = defineOp({
	input: z.object({query: z.string(), rootId: z.string().nullable()}),
	output: TreeSearchResultSchema,
	async run(ctx, {query, rootId}) {
		const load = treeLoader(ctx);
		const rows = queryNeedsBacklinks(query)
			? loadTreeRowsWithBacklinks(ctx.db, rootId, load)
			: load(ctx.db, rootId);
		const dateFormat = await loadDateFormat(ctx);
		const weekStartDay = await loadWeekStartDay(ctx);
		return ok(
			toJson(
				computeTreeSearch(rows, rootId, query, Date.now(), {
					...(dateFormat === null ? {} : {dateFormat}),
					...(weekStartDay === null ? {} : {weekStartDay}),
				}),
			),
		);
	},
});

let joinedSecPromise: Promise<number> | undefined;

/** The account join date (once per server), else the earliest cached `created_at`, for switcher recency. */
async function loadJoinedSec(ctx: ServerContext, rows: TreeSearchRow[]): Promise<number> {
	// A loop, not Math.min(...), so a large tree cannot overflow the call stack.
	let earliestCreatedMs = Infinity;
	for (const row of rows) {
		if (row.createdAt !== null && row.createdAt < earliestCreatedMs) {
			earliestCreatedMs = row.createdAt;
		}
	}
	const earliestCreatedSec = Number.isFinite(earliestCreatedMs) ? Math.floor(earliestCreatedMs / 1000) : 0;
	const adapter = ctx.internalAdapter?.();
	if (!adapter) {
		return resolveJoinedSec({account: null, earliestCreatedSec});
	}
	joinedSecPromise ??= adapter.getAccount().then(
		({joinedAt}) => resolveJoinedSec({account: {joinedAt: joinedAt.toISOString()}, earliestCreatedSec}),
		() => {
			joinedSecPromise = undefined;
			return resolveJoinedSec({account: null, earliestCreatedSec});
		},
	);
	return joinedSecPromise;
}

/** `POST /api/search/switcher` - upstream jump-menu search: word-start matches ranked by staticScore x textFactor. */
export const searchSwitcher = defineOp({
	input: z.object({
		query: z.string(),
		offset: z.number().default(0),
		limit: z.number().default(20),
		starredIds: z.array(z.string()).default([]),
		showCompleted: z.boolean().optional(),
	}),
	output: SwitcherResponseSchema,
	async run(ctx, {query, offset, limit, starredIds, showCompleted}) {
		const {rows, rank} = switcherSearch(ctx);
		const joinedSec = await loadJoinedSec(ctx, rows);
		return ok(
			toJson(
				rank(rows, query, starredIds, Math.floor(Date.now() / 1000), {
					joinedSec,
					offset,
					limit,
					showCompleted,
				}),
			),
		);
	},
});

/**
 * `POST /api/search/locations` - upstream move-to location picker: switcher matching without completed nodes or `excludeId`.
 * The HTTP layer answers 499 for a request the client aborted (an AbortSignal cannot cross RPC).
 */
export const searchLocations = defineOp({
	input: z.object({
		query: z.string(),
		offset: z.number().default(0),
		limit: z.number().default(20),
		excludeId: z.string().optional(),
		starredIds: z.array(z.string()).optional(),
		showCompleted: z.boolean().optional(),
	}),
	output: LocationResponseSchema,
	async run(ctx, {query, offset, limit, excludeId, starredIds, showCompleted}) {
		const {rows, rank} = switcherSearch(ctx);
		const joinedSec = await loadJoinedSec(ctx, rows);
		return ok(
			toJson(
				filterLocations(rows, {query, excludeId, offset, limit, joinedSec, starredIds, showCompleted, rank}),
			),
		);
	},
});

/** `POST /api/search` - text-based search with operators. */
export const searchText = defineOp({
	input: z.object({
		query: z.string().optional(),
		limit: z.number().default(10),
		offset: z.number().default(0),
		parentId: z.string().optional(),
	}),
	output: TextSearchResponseSchema,
	run: (ctx, input) => ok(textSearch(ctx, input)),
});

function textSearch(
	ctx: ServerContext,
	{query, limit, offset, parentId}: {query?: string; limit: number; offset: number; parentId?: string},
): {results: SearchResult[]; totalCount: number} {
	if (!query || query.trim().length === 0) {
		return {results: [], totalCount: 0};
	}

	const database = ctx.db;
	const parsed = parseSearchQuery(query);
	const {contentConditions, metadataConditions, needsMetadataJoin} = buildSearchConditions(parsed);
	// References roots and their backlink items are never search or jump hits.
	contentConditions.push(notReferencesContent());

	// If parentId is provided, limit search to descendants of that node
	if (parentId) {
		const descendantIds = getDescendantIds(database, parentId);
		if (descendantIds.length === 0) {
			return {results: [], totalCount: 0};
		}
		contentConditions.push(inArray(nodeContent.id, descendantIds));
	}

	// Build combined WHERE clause
	const allConditions = [...contentConditions];
	if (needsMetadataJoin) {
		// Add metadata join condition and metadata filters
		allConditions.push(
			eq(nodeMetadata.nodeId, nodeContent.id),
			eq(nodeMetadata.systemTo, FAR_FUTURE_DATE),
			...metadataConditions,
		);
	}

	let totalCount: number;
	let allResults: {id: string; name: string | null; note: string | null}[];

	if (needsMetadataJoin) {
		// Query with metadata join for completion/date filters
		const countResult = database
			.select({count: sql<number>`count(*)`})
			.from(nodeContent)
			.innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodeContent.id))
			.where(and(...allConditions))
			.get();
		totalCount = countResult?.count ?? 0;

		allResults = database
			.select({
				id: nodeContent.id,
				name: nodeContent.name,
				note: nodeContent.note,
			})
			.from(nodeContent)
			.innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodeContent.id))
			.where(and(...allConditions))
			.all();
	} else {
		// Simple query without metadata join
		const countResult = database
			.select({count: sql<number>`count(*)`})
			.from(nodeContent)
			.where(and(...contentConditions))
			.get();
		totalCount = countResult?.count ?? 0;

		allResults = database
			.select({
				id: nodeContent.id,
				name: nodeContent.name,
				note: nodeContent.note,
			})
			.from(nodeContent)
			.where(and(...contentConditions))
			.all();
	}

	// Get terms for scoring
	const scoringTerms = getScoringTerms(parsed);

	// Score results based on match quality
	const scoredResults = allResults.map((result) => {
		const namePlain = result.name ? stripHtmlTags(result.name).toLowerCase() : "";
		const notePlain = result.note ? stripHtmlTags(result.note).toLowerCase() : "";

		let score = 0;

		if (scoringTerms.length === 0) {
			// No text terms to match, all results get base score
			score = 50;
		} else {
			// Score based on how well terms match
			for (const term of scoringTerms) {
				const termLower = term.toLowerCase();
				if (namePlain === termLower) {
					score += 100;
				} else if (namePlain.startsWith(termLower)) {
					score += 80;
				} else if (namePlain.includes(termLower)) {
					score += 60;
				} else if (notePlain.includes(termLower)) {
					score += 40;
				}
			}
		}

		return {...result, score};
	});

	// Sort by score descending
	scoredResults.sort((a, b) => b.score - a.score);

	// Apply pagination after scoring and sorting
	const paginatedResults = scoredResults.slice(offset, offset + limit);

	// Build parent paths in two batched queries (parentId + completedAt lookup, then PathBuilder)
	// rather than walking the ancestor chain per result. The parent path excludes the result
	// node itself, so it is the full path of the node's parent.
	const rowOf = new Map<string, {parentId: string | null; completedAt: Date | null}>(
		database
			.select({id: nodeContent.id, parentId: nodeContent.parentId, completedAt: nodeMetadata.completedAt})
			.from(nodeContent)
			.leftJoin(
				nodeMetadata,
				and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
			)
			.where(
				and(
					inArray(
						nodeContent.id,
						paginatedResults.map((r) => r.id),
					),
					eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				),
			)
			.all()
			.map(({id, parentId: rowParentId, completedAt}) => [id, {parentId: rowParentId, completedAt}]),
	);
	const parentIds = [
		...new Set([...rowOf.values()].map((row) => row.parentId).filter((id): id is string => id !== null)),
	];
	const pathByParent = new PathBuilder(database).buildFullPathsBatch(parentIds);

	const results: SearchResult[] = paginatedResults.map(({id, name, note}) => {
		const row = rowOf.get(id);
		const nodeParentId = row?.parentId ?? null;
		return {
			id,
			name,
			note,
			parentPath: nodeParentId ? (pathByParent.get(nodeParentId) ?? "") : "",
			completedAt: toUnixSeconds(row?.completedAt ?? null),
		};
	});

	return {results, totalCount};
}
