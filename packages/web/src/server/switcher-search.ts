import {stripHtmlTags} from "@workflowy/shared/html";
import {guessDates} from "@workflowy/shared";
import {
	baseScore,
	highlight,
	indexText,
	matchField,
	nameBoost,
	parseQuery,
	foldPerCharacter,
	normalizeForSearch,
	splitIntoWords,
	textFactor,
	withMonthNames,
} from "@workflowy/shared/search";
import {searchItem, withRowText} from "./tree-search.js";
import type {RowTextSource, TreeSearchRow} from "./tree-search.js";

/** Upstream's index keys words by their first 16 characters. */
const INDEX_WORD_LENGTH = 16;
const DEFAULT_LIMIT = 20;

export interface SwitcherAncestor {
	id: string;
	name: string;
}

export interface SwitcherResult {
	id: string;
	labelHtml: string;
	completed: boolean;
	starred: boolean;
	/** Root-first, without Home; names are whole (the client slices them). */
	ancestors: SwitcherAncestor[];
}

export interface SwitcherResponse {
	results: SwitcherResult[];
	hasMore: boolean;
}

export interface RankSwitcherOptions {
	joinedSec: number;
	offset?: number;
	limit?: number;
	/** A node to leave out of the results (the location picker's own item). */
	excludeId?: string;
	/** Keep completed rows and rows under a completed ancestor (score factor 1, flagged `completed`). */
	showCompleted?: boolean;
}

/** Upstream's switcher word-start boundary, as in matchField. */
const START_OF_WORD_CHUNK = String.raw`([^\p{L}\p{N}#@]|^)`;

/** matchField's word-start test for one word (words hold only letters, digits, # and @, so need no escaping). */
function wordStart(word: string): RegExp {
	return new RegExp(`${START_OF_WORD_CHUNK}(${word})`, "iu");
}

interface IndexText {
	indexName: string;
	indexNote: string;
}

interface RowText {
	plainName: string;
	plainNote: string;
	foldedName: string;
	foldedNote: string;
	/** Upstream's `zb` text of the name and note, whose lengths rank a hit; filled on first use, so only for hits. */
	index?: IndexText;
	/** matchField's per-character folding of the plain name, raw name and plain note, filled on first use. */
	fields?: [plainName: string, rawName: string, plainNote: string];
}

interface Placement {
	depth: number;
	underCompleted: boolean;
}

interface RowIndex {
	byId: Map<string, TreeSearchRow>;
	childCount: Map<string, number>;
	placements: Map<string, Placement>;
	/** Position of each row in a depth-first walk with children by priority: upstream's index insertion order. */
	preorder?: Map<string, number>;
	childrenOf?: Map<string | null, TreeSearchRow[]>;
}

// Snapshot rows are shared across keystrokes, so their stripped and folded text and the tree index are reused.
const textCache = new WeakMap<TreeSearchRow, RowText>();
const indexCache = new WeakMap<readonly TreeSearchRow[], RowIndex>();

/** `held` when it equals `fresh`, so the fresh copy can be collected. */
function same(fresh: string, held: string): string {
	return fresh === held ? held : fresh;
}

function rowText(row: TreeSearchRow): RowText {
	let text = textCache.get(row);
	if (text === undefined) {
		const name = row.name ?? "";
		const note = row.note ?? "";
		const plainName = same(stripHtmlTags(name), name);
		const plainNote = same(stripHtmlTags(note), note);
		const foldedName = same(normalizeForSearch(plainName), plainName);
		const foldedNote = same(normalizeForSearch(plainNote), plainNote);
		text = {plainName, plainNote, foldedName, foldedNote};
		textCache.set(row, text);
	}
	return text;
}

function indexTexts(row: TreeSearchRow, text: RowText): IndexText {
	if (text.index === undefined) {
		const indexName = indexText(withMonthNames(row.name ?? ""));
		const indexNote = indexText(withMonthNames(row.note ?? ""));
		text.index = {
			indexName: same(same(indexName, text.plainName), text.foldedName),
			indexNote: same(same(indexNote, text.plainNote), text.foldedNote),
		};
	}
	return text.index;
}

function rowIndex(rows: readonly TreeSearchRow[]): RowIndex {
	let index = indexCache.get(rows);
	if (index === undefined) {
		const childCount = new Map<string, number>();
		for (const row of rows) {
			if (row.parentId !== null) {
				childCount.set(row.parentId, (childCount.get(row.parentId) ?? 0) + 1);
			}
		}
		index = {byId: new Map(rows.map((row) => [row.id, row])), childCount, placements: new Map()};
		indexCache.set(rows, index);
	}
	return index;
}

function childrenByParent(rows: readonly TreeSearchRow[], index: RowIndex): Map<string | null, TreeSearchRow[]> {
	if (index.childrenOf === undefined) {
		const children = new Map<string | null, TreeSearchRow[]>();
		for (const row of rows) {
			// A row whose parent is not in the snapshot hangs at the top, like a top-level row.
			const key = row.parentId !== null && index.byId.has(row.parentId) ? row.parentId : null;
			const siblings = children.get(key);
			if (siblings) {
				siblings.push(row);
			} else {
				children.set(key, [row]);
			}
		}
		for (const siblings of children.values()) {
			siblings.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
		}
		index.childrenOf = children;
	}
	return index.childrenOf;
}

/** The rows in tree preorder (children by priority). */
function preorderRows(rows: readonly TreeSearchRow[], index: RowIndex): TreeSearchRow[] {
	const children = childrenByParent(rows, index);
	const ordered: TreeSearchRow[] = [];
	const stack = [...(children.get(null) ?? [])].toReversed();
	while (stack.length > 0) {
		const row = stack.pop();
		if (row === undefined) {
			break;
		}
		ordered.push(row);
		stack.push(...(children.get(row.id) ?? []).toReversed());
	}
	return ordered;
}

function preorderIndex(rows: readonly TreeSearchRow[], index: RowIndex): Map<string, number> {
	index.preorder ??= new Map(preorderRows(rows, index).map((row, position) => [row.id, position]));
	return index.preorder;
}

function matchFields(row: TreeSearchRow, text: RowText): [string, string, string] {
	if (text.fields === undefined) {
		// Reuse an equal string already held, so a row whose fields fold the same way keeps one copy, not three.
		const plainName = same(foldPerCharacter(text.plainName), text.foldedName);
		const rawName = same(foldPerCharacter(row.name ?? ""), plainName);
		const plainNote = same(foldPerCharacter(text.plainNote), text.foldedNote);
		text.fields = [plainName, rawName, plainNote];
	}
	return text.fields;
}

/**
 * Fill every row's text caches, the tree index and each row's placement ahead of the first jump-menu keystroke. Run off the request path
 * after each snapshot refresh: cold, these cost about a second on a large tree, which the first query would pay.
 */
export function warmSwitcher(rows: readonly TreeSearchRow[]): void {
	const index = rowIndex(rows);
	for (const row of rows) {
		const text = rowText(row);
		matchFields(row, text);
		indexTexts(row, text);
		placement(row, index);
	}
	preorderIndex(rows, index);
}

/** A row's cached jump-menu text, or undefined before it is computed, for tests. */
export function peekSwitcherText(row: TreeSearchRow): RowText | undefined {
	return textCache.get(row);
}

/** Depth counted from Home (top level is 2) and whether any ancestor is completed, memoised per tree. */
function placement(row: TreeSearchRow, index: RowIndex): Placement {
	const cached = index.placements.get(row.id);
	if (cached) {
		return cached;
	}
	const parent = row.parentId === null ? undefined : index.byId.get(row.parentId);
	// Upstream's boot walk counts Home as depth 1, so a top-level row is depth 2.
	let result: Placement = {depth: 2, underCompleted: false};
	if (parent) {
		const above = placement(parent, index);
		result = {depth: above.depth + 1, underCompleted: above.underCompleted || parent.completedAt !== null};
	}
	index.placements.set(row.id, result);
	return result;
}

function toSeconds(millis: number | null): number | null {
	return millis === null ? null : Math.floor(millis / 1000);
}

/** Splits a nested `a > b` query on standalone `>` tokens; the last segment is the one that is ranked. */
function nestedSegments(query: string): string[] {
	return query
		.split(/(?<=^|\s)>(?=\s|$)/u)
		.map((segment) => segment.trim())
		.filter((segment) => segment !== "");
}

const WORD_CHARS = /[\p{L}\p{N}#@]+/giu;

interface TrieNode {
	ids: string[];
	children: Record<string, TrieNode>;
}

function newNode(): TrieNode {
	return {ids: [], children: {}};
}

/**
 * Upstream's trie `gather` order for `prefix`: ids stored at the exact-prefix node first, then each child subtrie. A
 * child key is one UTF-16 code unit, and a plain object lists integer-like keys (digits) first, then the others in
 * insertion order, exactly as upstream does. `entries` arrive in tree preorder, which is the index insertion order.
 */
function gatherPositions(
	prefix: string,
	entries: readonly {id: string; words: readonly string[]}[],
): Map<string, number> {
	const root = newNode();
	for (const {id, words} of entries) {
		for (const word of words) {
			if (!word.startsWith(prefix)) {
				continue;
			}
			let node = root;
			for (let i = 0; i < word.length; i++) {
				const key = word[i] ?? "";
				node = node.children[key] ??= newNode();
			}
			if (node.ids.at(-1) !== id) {
				node.ids.push(id);
			}
		}
	}
	let start = root;
	for (let i = 0; i < prefix.length; i++) {
		start = start.children[prefix[i] ?? ""] ?? newNode();
	}
	const positions = new Map<string, number>();
	const visit = (node: TrieNode): void => {
		for (const id of node.ids) {
			if (!positions.has(id)) {
				positions.set(id, positions.size);
			}
		}
		for (const key of Object.getOwnPropertyNames(node.children)) {
			const child = node.children[key];
			if (child) {
				visit(child);
			}
		}
	};
	visit(start);
	return positions;
}

function indexWords(text: string): string[] {
	return (text.match(WORD_CHARS) ?? []).map((word) => word.slice(0, INDEX_WORD_LENGTH));
}

/** Queries upstream answers with the full tree search, in tree order: a quote, an emoji or a date phrase. */
function needsTreeSearch(query: string): boolean {
	return query.includes('"') || /\p{Emoji_Presentation}/u.test(query) || guessDates(query).length > 0;
}

function ancestorChain(row: TreeSearchRow, byId: ReadonlyMap<string, TreeSearchRow>): TreeSearchRow[] {
	const chain: TreeSearchRow[] = [];
	let parent = row.parentId === null ? undefined : byId.get(row.parentId);
	while (parent) {
		chain.push(parent);
		parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
	}
	return chain.toReversed();
}

function toResult(
	row: TreeSearchRow,
	byId: Map<string, TreeSearchRow>,
	labelHtml: string,
	completed: boolean,
	starred: boolean,
): SwitcherResult {
	return {
		id: row.id,
		labelHtml,
		completed,
		starred,
		ancestors: ancestorChain(row, byId).map((ancestor) => ({
			id: ancestor.id,
			name: stripHtmlTags(ancestor.name ?? ""),
		})),
	};
}

/**
 * Upstream's tree-search iterator for quoted, emoji and date queries: full search semantics, tree order, mirrors
 * included, the label highlighted by the query's matching ranges (a phrase is one hit).
 */
function treeOrderSwitcher(
	rows: readonly TreeSearchRow[],
	query: string,
	starred: ReadonlySet<string>,
	nowSec: number,
	{offset = 0, limit = DEFAULT_LIMIT, excludeId, showCompleted = false}: RankSwitcherOptions,
): SwitcherResponse {
	const parsed = parseQuery(query, {now: nowSec * 1000});
	if (parsed.isEmpty()) {
		return {results: [], hasMore: false};
	}
	const index = rowIndex(rows);
	const {byId, childCount} = index;
	const hits: {row: TreeSearchRow; completed: boolean}[] = [];
	for (const row of preorderRows(rows, index)) {
		if (row.id === excludeId) {
			continue;
		}
		const {underCompleted} = placement(row, index);
		const completed = underCompleted || row.completedAt !== null;
		if (completed && !showCompleted) {
			continue;
		}
		if (parsed.matches(searchItem(row, childCount.get(row.id) ?? 0, underCompleted)).matches) {
			hits.push({row, completed});
		}
	}
	return {
		results: hits.slice(offset, offset + limit).map(({row, completed}) => {
			const plain = rowText(row).plainName;
			return toResult(row, byId, highlight(plain, parsed.ranges(plain)), completed, starred.has(row.id));
		}),
		hasMore: hits.length > offset + limit,
	};
}

/**
 * Upstream's jump-menu search over the live tree: candidates hold the longest query word (first 16 chars)
 * somewhere in their name or note, word-start matches only survive, completed nodes and nodes under a completed
 * ancestor are dropped (unless `showCompleted`), mirrors are never indexed, and the rest sort by
 * `baseScore x nameBoost x textFactor` descending, ties in upstream's trie gather order.
 */
export function rankSwitcher(
	rows: readonly TreeSearchRow[],
	query: string,
	starredIds: readonly string[],
	nowSec: number,
	options: RankSwitcherOptions,
): SwitcherResponse {
	const {joinedSec, offset = 0, limit = DEFAULT_LIMIT, excludeId, showCompleted = false} = options;
	const starred = new Set(starredIds);
	if (needsTreeSearch(query)) {
		return treeOrderSwitcher(rows, query, starred, nowSec, options);
	}
	const segments = nestedSegments(query);
	const words = splitIntoWords(segments.at(-1) ?? "");
	if (words.length === 0) {
		return {results: [], hasMore: false};
	}
	const longest = words.toSorted((a, b) => b.length - a.length)[0]?.slice(0, INDEX_WORD_LENGTH) ?? "";
	const index = rowIndex(rows);
	const {byId, childCount} = index;
	const earlier = segments.slice(0, -1).map((segment) => parseQuery(segment));
	// Upstream's `P94`: walking up from the parent, an ancestor matching the current earlier segment consumes it.
	const ancestorsMatch = (row: TreeSearchRow): boolean => {
		let remaining = earlier.length - 1;
		let parent = row.parentId === null ? undefined : byId.get(row.parentId);
		while (remaining >= 0 && parent) {
			if (
				earlier[remaining]?.matches(searchItem(parent, childCount.get(parent.id) ?? 0, false)).matches === true
			) {
				remaining--;
			}
			parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
		}
		return remaining < 0;
	};
	// matchField's word-start tests, run on its own folding: a field hits when it holds every word.
	const longestAtWordStart = wordStart(longest);
	const wordRegExps = words.map(wordStart);
	const hitsEvery = (field: string): boolean => wordRegExps.every((regexp) => regexp.test(field));

	// Scoring needs only depth, completion and hits, so ancestor chains and highlighting run for the page alone.
	const scored: {score: number; row: TreeSearchRow; completed: boolean; nameHit: boolean}[] = [];
	for (const row of preorderRows(rows, index)) {
		// Upstream never indexes a mirror.
		if (row.id === excludeId || row.isMirror) {
			continue;
		}
		const text = rowText(row);
		// Stands in for the SQL LIKE prefilter on the normalised plain text.
		if (!text.foldedName.includes(longest) && !text.foldedNote.includes(longest)) {
			continue;
		}
		const {depth, underCompleted} = placement(row, index);
		const completed = underCompleted || row.completedAt !== null;
		if (completed && !showCompleted) {
			continue;
		}
		const [plainNameField, rawNameField, noteField] = matchFields(row, text);
		// matchSwitcherRow answers null exactly when no field holds every word.
		if (!hitsEvery(plainNameField) && !hitsEvery(rawNameField) && !hitsEvery(noteField)) {
			continue;
		}
		if (earlier.length > 0 && !ancestorsMatch(row)) {
			continue;
		}
		const nameHit = longestAtWordStart.test(plainNameField);
		const noteHit = longestAtWordStart.test(noteField);
		const {indexName, indexNote} = indexTexts(row, text);
		const score =
			baseScore({
				depth,
				childCount: childCount.get(row.id) ?? 0,
				completed,
				lastModifiedSec: toSeconds(row.modifiedAt),
				joinedSec,
				nowSec,
				layoutMode: row.layoutMode,
				starred: starred.has(row.id),
			}) *
			nameBoost(row.name ?? "") *
			textFactor(longest, indexName, indexNote, nameHit, noteHit);
		scored.push({score, row, completed, nameHit});
	}
	// `scored` is in tree preorder, which is the index insertion order that the trie gather order refines.
	const toEntries = (hits: typeof scored, field: "indexName" | "indexNote") =>
		hits.map(({row}) => ({id: row.id, words: indexWords(indexTexts(row, rowText(row))[field])}));
	const position = new Map([
		...gatherPositions(
			longest,
			toEntries(
				scored.filter(({nameHit}) => nameHit),
				"indexName",
			),
		),
		...gatherPositions(
			longest,
			toEntries(
				scored.filter(({nameHit}) => !nameHit),
				"indexNote",
			),
		),
	]);
	const preorder = preorderIndex(rows, index);
	const at = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			at(a.row.id) - at(b.row.id) ||
			(preorder.get(a.row.id) ?? 0) - (preorder.get(b.row.id) ?? 0),
	);
	return {
		results: scored.slice(offset, offset + limit).map(({row, completed}) =>
			// matchSwitcherRow's label: the plain name highlighted (the row is known to match).
			toResult(row, byId, matchField(words, rowText(row).plainName).html, completed, starred.has(row.id)),
		),
		hasMore: scored.length > offset + limit,
	};
}

interface Placed {
	row: TreeSearchRow;
	depth: number;
	underCompleted: boolean;
}

/** The rows in tree preorder (children by priority) with their {@link placement}, computed on the walk. */
function* placedPreorder(rows: readonly TreeSearchRow[], index: RowIndex): Generator<Placed> {
	const children = childrenByParent(rows, index);
	const stack: Placed[] = (children.get(null) ?? [])
		.toReversed()
		.map((row) => ({row, depth: 2, underCompleted: false}));
	for (let placed = stack.pop(); placed !== undefined; placed = stack.pop()) {
		yield placed;
		const {row, depth, underCompleted} = placed;
		const below = underCompleted || row.completedAt !== null;
		for (const child of (children.get(row.id) ?? []).toReversed()) {
			stack.push({row: child, depth: depth + 1, underCompleted: below});
		}
	}
}

/** The page's results: each row's text and its ancestors' names read from `source` once, then labelled by `label`. */
function pagedResults(
	hits: readonly {row: TreeSearchRow; completed: boolean}[],
	byId: ReadonlyMap<string, TreeSearchRow>,
	starred: ReadonlySet<string>,
	source: RowTextSource,
	label: (plainName: string) => string,
): SwitcherResult[] {
	const chains = hits.map(({row}) => ancestorChain(row, byId));
	const ids = [...new Set([...hits.map(({row}) => row.id), ...chains.flat().map(({id}) => id)])];
	const text = new Map<string, {name: string | null; note: string | null}>();
	for (let start = 0; start < ids.length; start += source.pageSize) {
		for (const [id, found] of source.read(ids.slice(start, start + source.pageSize))) {
			text.set(id, found);
		}
	}
	const nameOf = (id: string): string => stripHtmlTags(text.get(id)?.name ?? "");
	return hits.map(({row, completed}, position) => ({
		id: row.id,
		labelHtml: label(nameOf(row.id)),
		completed,
		starred: starred.has(row.id),
		ancestors: (chains[position] ?? []).map(({id}) => ({id, name: nameOf(id)})),
	}));
}

/**
 * {@link rankSwitcher} over a whole tree held without its text (`skeleton` rows have null `name` and `note`), for a
 * host that cannot hold every row's text (a 128 MB Durable Object). The text is read a page at a time in tree
 * preorder and dropped after each row is scored; a hit keeps only its score and the index words its tie order
 * needs, and the returned page reads its own labels and ancestor names afterwards.
 */
export function rankSwitcherPaged(
	skeleton: readonly TreeSearchRow[],
	query: string,
	starredIds: readonly string[],
	nowSec: number,
	options: RankSwitcherOptions,
	source: RowTextSource,
): SwitcherResponse {
	const {joinedSec, offset = 0, limit = DEFAULT_LIMIT, excludeId, showCompleted = false} = options;
	const starred = new Set(starredIds);
	const index = rowIndex(skeleton);
	const {byId, childCount} = index;
	const rows = withRowText(placedPreorder(skeleton, index), source);

	if (needsTreeSearch(query)) {
		const parsed = parseQuery(query, {now: nowSec * 1000});
		if (parsed.isEmpty()) {
			return {results: [], hasMore: false};
		}
		const hits: {row: TreeSearchRow; completed: boolean}[] = [];
		for (const {row, underCompleted} of rows) {
			const completed = underCompleted || row.completedAt !== null;
			if (row.id === excludeId || (completed && !showCompleted)) {
				continue;
			}
			if (parsed.matches(searchItem(row, childCount.get(row.id) ?? 0, underCompleted)).matches) {
				hits.push({row: byId.get(row.id) ?? row, completed});
			}
		}
		return {
			results: pagedResults(hits.slice(offset, offset + limit), byId, starred, source, (plain) =>
				highlight(plain, parsed.ranges(plain)),
			),
			hasMore: hits.length > offset + limit,
		};
	}

	const segments = nestedSegments(query);
	const words = splitIntoWords(segments.at(-1) ?? "");
	if (words.length === 0) {
		return {results: [], hasMore: false};
	}
	const longest = words.toSorted((a, b) => b.length - a.length)[0]?.slice(0, INDEX_WORD_LENGTH) ?? "";
	const earlier = segments.slice(0, -1).map((segment) => parseQuery(segment));
	// Which earlier segments each row matches; preorder scores every ancestor before its descendants.
	const segmentHits = new Map<string, boolean[]>();
	const ancestorsMatch = (row: TreeSearchRow): boolean => {
		let remaining = earlier.length - 1;
		let parent = row.parentId === null ? undefined : byId.get(row.parentId);
		while (remaining >= 0 && parent) {
			if (segmentHits.get(parent.id)?.[remaining] === true) {
				remaining--;
			}
			parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
		}
		return remaining < 0;
	};
	const longestAtWordStart = wordStart(longest);
	const wordRegExps = words.map(wordStart);
	const hitsEvery = (field: string): boolean => wordRegExps.every((regexp) => regexp.test(field));
	const prefixWords = (text: string): string[] => indexWords(text).filter((word) => word.startsWith(longest));

	const scored: {score: number; row: TreeSearchRow; completed: boolean; nameHit: boolean; words: string[]}[] = [];
	for (const {row, depth, underCompleted} of rows) {
		if (earlier.length > 0) {
			const item = searchItem(row, childCount.get(row.id) ?? 0, false);
			const matched = earlier.map((parsed) => parsed.matches(item).matches);
			if (matched.includes(true)) {
				segmentHits.set(row.id, matched);
			}
		}
		if (row.id === excludeId || row.isMirror) {
			continue;
		}
		const text = rowText(row);
		if (!text.foldedName.includes(longest) && !text.foldedNote.includes(longest)) {
			continue;
		}
		const completed = underCompleted || row.completedAt !== null;
		if (completed && !showCompleted) {
			continue;
		}
		const [plainNameField, rawNameField, noteField] = matchFields(row, text);
		if (!hitsEvery(plainNameField) && !hitsEvery(rawNameField) && !hitsEvery(noteField)) {
			continue;
		}
		if (earlier.length > 0 && !ancestorsMatch(row)) {
			continue;
		}
		const nameHit = longestAtWordStart.test(plainNameField);
		const noteHit = longestAtWordStart.test(noteField);
		const {indexName, indexNote} = indexTexts(row, text);
		const score =
			baseScore({
				depth,
				childCount: childCount.get(row.id) ?? 0,
				completed,
				lastModifiedSec: toSeconds(row.modifiedAt),
				joinedSec,
				nowSec,
				layoutMode: row.layoutMode,
				starred: starred.has(row.id),
			}) *
			nameBoost(row.name ?? "") *
			textFactor(longest, indexName, indexNote, nameHit, noteHit);
		const skeletonRow = byId.get(row.id) ?? row;
		scored.push({
			score,
			row: skeletonRow,
			completed,
			nameHit,
			words: prefixWords(nameHit ? indexName : indexNote),
		});
	}
	// `scored` is in tree preorder, the index insertion order, so its position is the final tie-break.
	const preorder = new Map(scored.map(({row}, position) => [row.id, position]));
	const toEntries = (hits: typeof scored) => hits.map(({row, words: hitWords}) => ({id: row.id, words: hitWords}));
	const position = new Map([
		...gatherPositions(longest, toEntries(scored.filter(({nameHit}) => nameHit))),
		...gatherPositions(longest, toEntries(scored.filter(({nameHit}) => !nameHit))),
	]);
	const at = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			at(a.row.id) - at(b.row.id) ||
			(preorder.get(a.row.id) ?? 0) - (preorder.get(b.row.id) ?? 0),
	);
	return {
		results: pagedResults(
			scored.slice(offset, offset + limit),
			byId,
			starred,
			source,
			(plain) => matchField(words, plain).html,
		),
		hasMore: scored.length > offset + limit,
	};
}
