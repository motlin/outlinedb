import {matchNested, parseNestedQuery, parseQuery} from "@workflowy/shared/search";
import type {MatchResult, SearchItem} from "@workflowy/shared/search";

/** A live node as loaded for tree search. Timestamps are epoch milliseconds. */
export interface TreeSearchRow {
	id: string;
	parentId: string | null;
	priority: number | null;
	name: string | null;
	note: string | null;
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
	layoutMode: string | null;
	isMirror: boolean;
	/** A backlink item under a references root; only `is:backlink` / `in:backlink:` queries load these rows. */
	isBacklink: boolean;
	/** The MIME type of the node's live (not deleted) attachment, or null without one. */
	fileType: string | null;
}

export interface TreeSearchResult {
	matchIds: string[];
	nameMatchIds: string[];
	noteMatchIds: string[];
	/** Operator-only matches: matched without a name or note text match. */
	metaMatchIds: string[];
	/** Nodes (excluding the root) with at least one matching descendant. */
	ancestorIds: string[];
	/** Ancestors with at least one child that neither matches nor has matching descendants. */
	halfExpandedIds: string[];
	rootHalfExpanded: boolean;
	/** Matches that are completed or sit under a completed ancestor. */
	completedMatchCount: number;
	matchCount: number;
	revealsCompleted: boolean;
}

interface Visit {
	id: string;
	childIds: string[];
	matches: boolean;
	nameMatches: boolean;
	noteMatches: boolean;
	metaMatches: boolean;
	completed: boolean;
}

function emptyResult(revealsCompleted: boolean): TreeSearchResult {
	return {
		matchIds: [],
		nameMatchIds: [],
		noteMatchIds: [],
		metaMatchIds: [],
		ancestorIds: [],
		halfExpandedIds: [],
		rootHalfExpanded: false,
		completedMatchCount: 0,
		matchCount: 0,
		revealsCompleted,
	};
}

// Rows from the tree snapshot are shared across requests, so their sibling index and search items (whose
// stripped, folded text `parseQuery` caches per item) are reused rather than rebuilt for every query.
const childrenCache = new WeakMap<readonly TreeSearchRow[], Map<string | null, TreeSearchRow[]>>();
const itemCache = new WeakMap<TreeSearchRow, [open?: SearchItem, underCompleted?: SearchItem]>();

function childrenByParent(rows: TreeSearchRow[]): Map<string | null, TreeSearchRow[]> {
	const cached = childrenCache.get(rows);
	if (cached) {
		return cached;
	}
	const children = new Map<string | null, TreeSearchRow[]>();
	for (const row of rows) {
		const siblings = children.get(row.parentId);
		if (siblings) {
			siblings.push(row);
		} else {
			children.set(row.parentId, [row]);
		}
	}
	for (const siblings of children.values()) {
		siblings.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
	}
	childrenCache.set(rows, children);
	return children;
}

export function searchItem(row: TreeSearchRow, childCount: number, ancestorCompleted: boolean): SearchItem {
	let slots = itemCache.get(row);
	if (slots === undefined) {
		slots = [];
		itemCache.set(row, slots);
	}
	const slot = ancestorCompleted ? 1 : 0;
	const cached = slots[slot];
	if (cached?.childCount === childCount) {
		return cached;
	}
	const item: SearchItem = {
		id: row.id,
		nameHtml: row.name ?? "",
		noteHtml: row.note ?? "",
		completedAt: row.completedAt,
		createdAt: row.createdAt,
		modifiedAt: row.modifiedAt,
		layoutMode: row.layoutMode,
		childCount,
		isMirror: row.isMirror,
		isBacklink: row.isBacklink,
		fileType: row.fileType,
		ancestorCompleted,
	};
	slots[slot] = item;
	return item;
}

/** Where a paged search reads row text: `read` answers one page of at most `pageSize` ids. */
export interface RowTextSource {
	pageSize: number;
	read(ids: readonly string[]): ReadonlyMap<string, {name: string | null; note: string | null}>;
}

/**
 * `entries` in their order, read in pages of `source.pageSize`, each row carrying its text from `source`
 * (rows without live text are dropped).
 */
export function* withRowText<T extends {row: TreeSearchRow}>(
	entries: Iterable<T>,
	source: RowTextSource,
): Generator<T> {
	let page: T[] = [];
	const flush = function* (): Generator<T> {
		const text = source.read(page.map(({row}) => row.id));
		for (const entry of page) {
			const found = text.get(entry.row.id);
			if (found !== undefined) {
				yield {...entry, row: {...entry.row, name: found.name, note: found.note}};
			}
		}
		page = [];
	};
	for (const entry of entries) {
		page.push(entry);
		if (page.length === source.pageSize) {
			yield* flush();
		}
	}
	if (page.length > 0) {
		yield* flush();
	}
}

interface ParseOpts {
	dateFormat?: string;
	weekStartDay?: 0 | 1;
}

function parseTreeQuery(query: string, now: number, opts: ParseOpts) {
	const parseOpts = {
		now,
		...(opts.dateFormat === undefined ? {} : {dateFormat: opts.dateFormat}),
		...(opts.weekStartDay === undefined ? {} : {weekStartDay: opts.weekStartDay}),
	};
	const nested = parseNestedQuery(query, parseOpts);
	return {nested, parsed: nested?.highlight ?? parseQuery(query, parseOpts)};
}

/** The result from `visits` (in document order) and the ids of the search root's children. */
function summarize(
	visits: readonly Visit[],
	rootChildIds: readonly string[],
	revealsCompleted: boolean,
): TreeSearchResult {
	// Children follow their parent in `visits`, so a reverse pass sees every child before its parent.
	const hasDescendantMatch = new Set<string>();
	const visible = new Set<string>();
	for (const visit of visits.toReversed()) {
		if (visit.childIds.some((id) => visible.has(id))) {
			hasDescendantMatch.add(visit.id);
		}
		if (visit.matches || hasDescendantMatch.has(visit.id)) {
			visible.add(visit.id);
		}
	}
	const isHalfExpanded = (childIds: readonly string[]): boolean =>
		childIds.some((id) => visible.has(id)) && childIds.some((id) => !visible.has(id));

	const result = emptyResult(revealsCompleted);
	for (const visit of visits) {
		if (visit.matches) {
			result.matchIds.push(visit.id);
			result.matchCount += 1;
			if (visit.completed) {
				result.completedMatchCount += 1;
			}
			if (visit.nameMatches) {
				result.nameMatchIds.push(visit.id);
			}
			if (visit.noteMatches) {
				result.noteMatchIds.push(visit.id);
			}
			if (visit.metaMatches && !visit.nameMatches && !visit.noteMatches) {
				result.metaMatchIds.push(visit.id);
			}
		}
		if (hasDescendantMatch.has(visit.id)) {
			result.ancestorIds.push(visit.id);
			if (isHalfExpanded(visit.childIds)) {
				result.halfExpandedIds.push(visit.id);
			}
		}
	}
	result.rootHalfExpanded = isHalfExpanded(rootChildIds);
	return result;
}

/**
 * Port of upstream's in-place search: matches every descendant of `rootId` (the whole tree when null) against the
 * query AST, never the root itself, and reports ids in document order (parent, then children by priority).
 */
export function computeTreeSearch(
	rows: TreeSearchRow[],
	rootId: string | null,
	query: string,
	now: number,
	opts: ParseOpts = {},
): TreeSearchResult {
	const {nested, parsed} = parseTreeQuery(query, now, opts);
	if (parsed.isEmpty()) {
		return emptyResult(false);
	}

	const children = childrenByParent(rows);
	const rootCompleted = rootId !== null && rows.some((row) => row.id === rootId && row.completedAt !== null);
	const visits: Visit[] = [];
	const byId = nested ? new Map(rows.map((row) => [row.id, row])) : null;
	const matchRow = (row: TreeSearchRow, ancestorCompleted: boolean): MatchResult => {
		const item = searchItem(row, children.get(row.id)?.length ?? 0, ancestorCompleted);
		if (!nested || !byId) {
			return parsed.matches(item);
		}
		const ancestors: SearchItem[] = [];
		const seen = new Set<string>([row.id]);
		for (let id = row.parentId; id !== null && !seen.has(id);) {
			const ancestor = byId.get(id);
			if (!ancestor) {
				break;
			}
			seen.add(id);
			ancestors.push(searchItem(ancestor, children.get(id)?.length ?? 0, false));
			id = ancestor.parentId;
		}
		return matchNested(nested, {...item, ancestors});
	};

	const walk = (parentId: string | null, ancestorCompleted: boolean): void => {
		for (const row of children.get(parentId) ?? []) {
			const match = matchRow(row, ancestorCompleted);
			const completed = ancestorCompleted || row.completedAt !== null;
			visits.push({
				id: row.id,
				childIds: (children.get(row.id) ?? []).map((child) => child.id),
				...match,
				completed,
			});
			walk(row.id, completed);
		}
	};
	walk(rootId, rootCompleted);
	return summarize(
		visits,
		(children.get(rootId) ?? []).map((child) => child.id),
		parsed.revealsCompleted(),
	);
}

interface Placed {
	row: TreeSearchRow;
	depth: number;
	ancestorCompleted: boolean;
}

/** Every row reachable from the top level in document order, with its depth and whether an ancestor is completed. */
function* preorder(children: ReadonlyMap<string | null, TreeSearchRow[]>): Generator<Placed> {
	const stack: Placed[] = (children.get(null) ?? [])
		.toReversed()
		.map((row) => ({row, depth: 0, ancestorCompleted: false}));
	for (let placed = stack.pop(); placed !== undefined; placed = stack.pop()) {
		yield placed;
		const {row, depth, ancestorCompleted} = placed;
		const below = ancestorCompleted || row.completedAt !== null;
		for (const child of (children.get(row.id) ?? []).toReversed()) {
			stack.push({row: child, depth: depth + 1, ancestorCompleted: below});
		}
	}
}

/**
 * {@link computeTreeSearch} over the whole tree held without its text (`skeleton` rows have null `name` and
 * `note`), for a host that cannot hold every row's text (a 128 MB Durable Object). The text is read a page at a
 * time in document order and dropped once each row is matched; a nested query keeps only the current row's
 * ancestor chain.
 */
export function computeTreeSearchPaged(
	skeleton: TreeSearchRow[],
	query: string,
	now: number,
	opts: ParseOpts,
	source: RowTextSource,
): TreeSearchResult {
	const {nested, parsed} = parseTreeQuery(query, now, opts);
	if (parsed.isEmpty()) {
		return emptyResult(false);
	}
	const children = childrenByParent(skeleton);
	const childIds = (id: string): string[] => (children.get(id) ?? []).map((child) => child.id);
	const visits: Visit[] = [];
	// The current row's ancestors with their text, root first (only for a nested query).
	const path: {depth: number; item: SearchItem}[] = [];
	for (const {row, depth, ancestorCompleted} of withRowText(preorder(children), source)) {
		const count = children.get(row.id)?.length ?? 0;
		const item = searchItem(row, count, ancestorCompleted);
		let match: MatchResult;
		if (nested) {
			while ((path.at(-1)?.depth ?? -1) >= depth) {
				path.pop();
			}
			match = matchNested(nested, {...item, ancestors: path.map((entry) => entry.item).toReversed()});
			path.push({depth, item: searchItem(row, count, false)});
		} else {
			match = parsed.matches(item);
		}
		visits.push({
			id: row.id,
			childIds: childIds(row.id),
			...match,
			completed: ancestorCompleted || row.completedAt !== null,
		});
	}
	return summarize(
		visits,
		(children.get(null) ?? []).map((child) => child.id),
		parsed.revealsCompleted(),
	);
}
