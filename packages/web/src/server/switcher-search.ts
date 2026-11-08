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
	/** Whether the raw name and note are ASCII, so folding them per character only lowercases. */
	asciiName: boolean;
	asciiNote: boolean;
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

type RowContent = Pick<TreeSearchRow, "name" | "note">;

const ASCII_TEXT = /^\p{ASCII}*$/u;

/** `plain` folded for search; ASCII text (whose stripped text stays ASCII) only lowercases. */
function fold(plain: string, ascii: boolean): string {
	return same(ascii ? plain.toLowerCase() : normalizeForSearch(plain), plain);
}

function computeRowText(row: RowContent): RowText {
	const name = row.name ?? "";
	const note = row.note ?? "";
	const asciiName = ASCII_TEXT.test(name);
	const asciiNote = ASCII_TEXT.test(note);
	const plainName = same(stripHtmlTags(name), name);
	const plainNote = same(stripHtmlTags(note), note);
	return {
		plainName,
		plainNote,
		foldedName: fold(plainName, asciiName),
		foldedNote: fold(plainNote, asciiNote),
		asciiName,
		asciiNote,
	};
}

function rowText(row: TreeSearchRow): RowText {
	let text = textCache.get(row);
	if (text === undefined) {
		text = computeRowText(row);
		textCache.set(row, text);
	}
	return text;
}

function indexTexts(row: RowContent, text: RowText): IndexText {
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

function matchFields(row: RowContent, text: RowText): [string, string, string] {
	if (text.fields === undefined) {
		// Reuse an equal string already held, so a row whose fields fold the same way keeps one copy, not three.
		const plainName = text.asciiName ? text.foldedName : same(foldPerCharacter(text.plainName), text.foldedName);
		const raw = row.name ?? "";
		const rawName = same(text.asciiName ? raw.toLowerCase() : foldPerCharacter(raw), plainName);
		const plainNote = text.asciiNote ? text.foldedNote : same(foldPerCharacter(text.plainNote), text.foldedNote);
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

/** `indexWords(text)` that start with `prefix` (letters, digits, # and @ only), without splitting out every word. */
function wordsStartingWith(prefix: string): (text: string) => string[] {
	const runs = new RegExp(`(?<![\\p{L}\\p{N}#@])${prefix}[\\p{L}\\p{N}#@]*`, "gu");
	return (text) =>
		text.includes(prefix) ? (text.match(runs) ?? []).map((word) => word.slice(0, INDEX_WORD_LENGTH)) : [];
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

/** Skeleton flag bits. */
const COMPLETED = 1;
const UNDER_COMPLETED = 2;
const MIRROR = 4;
/** The raw name is ASCII without `<` or `&`, so its index text is just its lowercase copy. */
const SIMPLE_NAME = 8;
/** The raw name holds `#` or `@`, which the tag boost needs. */
const TAGGED_NAME = 16;
/** The raw name or note holds a tag or non-ASCII text, so its folded text can hold a word its raw text lacks. */
const FOLDS = 32;

/** What a row's jump-menu score bound and prefilter need from its own text, without holding the text. */
export interface SwitcherTextSize {
	/** The raw name's length in code points, 0 when null. */
	nameLength: number;
	simpleName: boolean;
	taggedName: boolean;
	folds: boolean;
}

const UNSIZED: SwitcherTextSize = {nameLength: 0, simpleName: false, taggedName: false, folds: false};

const ASCII_SIMPLE_NAME = /^[\0-\x25\x27-\x3B\x3D-\x7F]*$/u;
const FOLDING_TEXT = /[<\u0080-\u{10FFFF}]/u;

/** {@link SwitcherTextSize} of a row's own name and note, as `buildSwitcherSkeleton` measures them in SQL. */
function textSize(name: string | null, note: string | null): SwitcherTextSize {
	return {
		// Code points, as SQLite's length() counts them.
		// oxlint-disable-next-line typescript/no-misused-spread -- code points are the point here
		nameLength: name === null ? 0 : [...name].length,
		simpleName: name !== null && ASCII_SIMPLE_NAME.test(name),
		taggedName: name !== null && (name.includes("#") || name.includes("@")),
		folds: [name, note].some((text) => text !== null && FOLDING_TEXT.test(text)),
	};
}

/** The text-size bits of a skeleton row's flags, for tests. */
export function switcherTextFlags(flag: number): Omit<SwitcherTextSize, "nameLength"> {
	return {
		simpleName: (flag & SIMPLE_NAME) !== 0,
		taggedName: (flag & TAGGED_NAME) !== 0,
		folds: (flag & FOLDS) !== 0,
	};
}

/**
 * The jump menu's whole tree without text, in tree preorder and in typed arrays: small enough (about a tenth of the
 * row objects) for a 128 MB Durable Object to keep between keystrokes. Index `i` is the row's preorder position.
 */
export interface SwitcherSkeleton {
	ids: string[];
	position: Map<string, number>;
	/** The parent's index, or -1 for a row hanging at the top. */
	parent: Int32Array;
	/** Counted from Home, so a top-level row is 2. */
	depth: Uint16Array;
	childCount: Uint32Array;
	/** The raw name's length in code points; 0 for a mirror, which the jump menu skips. */
	nameLength: Uint32Array;
	/** Milliseconds, NaN when unknown. */
	modifiedMs: Float64Array;
	flags: Uint8Array;
	/** The few rows with a layout mode, by index. */
	layoutModes: Map<number, string>;
	/** The earliest creation time of any row (Infinity when none), for the joined-at fallback. */
	earliestCreatedMs: number;
}

/**
 * {@link SwitcherSkeleton} of tree rows; the rows can be dropped afterwards. Each row's {@link SwitcherTextSize} is
 * `sizes[i]`, or else measured from the row's own text; a mirror's is left unsized.
 */
export function compactSwitcherSkeleton(
	rows: readonly TreeSearchRow[],
	sizes?: readonly SwitcherTextSize[],
): SwitcherSkeleton {
	const count = rows.length;
	const indexOf = new Map<string, number>();
	rows.forEach((row, i) => {
		indexOf.set(row.id, i);
	});
	// Typed arrays and index lists rather than per-row maps and objects: this runs on every jump-menu rebuild.
	const parentOf = new Int32Array(count);
	const childCount = new Uint32Array(count);
	rows.forEach((row, i) => {
		const parent = row.parentId === null ? -1 : (indexOf.get(row.parentId) ?? -1);
		parentOf[i] = parent;
		if (parent >= 0) {
			childCount[parent] = (childCount[parent] ?? 0) + 1;
		}
	});
	// Children grouped by parent (a row whose parent is not a row hangs at the top), each group by priority, stably.
	const top: number[] = [];
	const children: (number[] | undefined)[] = Array.from({length: count});
	for (let i = 0; i < count; i++) {
		const parent = parentOf[i] ?? -1;
		if (parent < 0) {
			top.push(i);
		} else {
			(children[parent] ??= []).push(i);
		}
	}
	const byPriority = (a: number, b: number) => (rows[a]?.priority ?? 0) - (rows[b]?.priority ?? 0) || a - b;
	top.sort(byPriority);
	for (const group of children) {
		group?.sort(byPriority);
	}
	const order: number[] = [];
	const stack = top.toReversed();
	for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
		order.push(i);
		const group = children[i];
		if (group) {
			for (let j = group.length - 1; j >= 0; j--) {
				stack.push(group[j] ?? 0);
			}
		}
	}
	const size = order.length;
	const skeleton: SwitcherSkeleton = {
		ids: order.map((i) => rows[i]?.id ?? ""),
		position: new Map(),
		parent: new Int32Array(size),
		depth: new Uint16Array(size),
		childCount: new Uint32Array(size),
		nameLength: new Uint32Array(size),
		modifiedMs: new Float64Array(size),
		flags: new Uint8Array(size),
		layoutModes: new Map(),
		earliestCreatedMs: Infinity,
	};
	const preorderOf = new Int32Array(count).fill(-1);
	order.forEach((i, at) => {
		preorderOf[i] = at;
		skeleton.position.set(rows[i]?.id ?? "", at);
	});
	order.forEach((i, at) => {
		const row = rows[i];
		if (row === undefined) {
			return;
		}
		const parentRow = parentOf[i] ?? -1;
		// Preorder places a parent before its children, so its depth and flags are already set.
		const parent = parentRow < 0 ? -1 : (preorderOf[parentRow] ?? -1);
		const parentFlags = parent < 0 ? 0 : (skeleton.flags[parent] ?? 0);
		skeleton.parent[at] = row.parentId === null ? -1 : (skeleton.position.get(row.parentId) ?? -1);
		skeleton.depth[at] = parent < 0 ? 2 : (skeleton.depth[parent] ?? 0) + 1;
		skeleton.childCount[at] = childCount[i] ?? 0;
		skeleton.modifiedMs[at] = row.modifiedAt ?? Number.NaN;
		const text = row.isMirror ? UNSIZED : (sizes?.[i] ?? textSize(row.name, row.note));
		skeleton.nameLength[at] = text.nameLength;
		skeleton.flags[at] =
			(row.completedAt === null ? 0 : COMPLETED) |
			((parentFlags & (COMPLETED | UNDER_COMPLETED)) === 0 ? 0 : UNDER_COMPLETED) |
			(row.isMirror ? MIRROR : 0) |
			(text.simpleName ? SIMPLE_NAME : 0) |
			(text.taggedName ? TAGGED_NAME : 0) |
			(text.folds ? FOLDS : 0);
		if (row.layoutMode !== null) {
			skeleton.layoutModes.set(at, row.layoutMode);
		}
		if (row.createdAt !== null && row.createdAt < skeleton.earliestCreatedMs) {
			skeleton.earliestCreatedMs = row.createdAt;
		}
	});
	return skeleton;
}

/** Whether {@link rankSwitcherCompact} answers `query`; quoted, emoji, date and nested `a > b` queries need the full rows. */
export function isCompactSwitcherQuery(query: string): boolean {
	return !needsTreeSearch(query) && nestedSegments(query).length <= 1;
}

const PLAIN_WORD = /^[a-z\d#@]+$/u;

/**
 * The longest query word as a case-insensitive SQL LIKE fragment, or null when it is not plain ASCII (folding could
 * then map other text onto it). A row whose folded text holds the word holds it in its raw text too, unless the raw
 * text has a tag (stripping can join letters) or non-ASCII characters (folding can map them to ASCII).
 */
export function scanFragment(longest: string): string | null {
	return PLAIN_WORD.test(longest) ? longest : null;
}

/** Live rows' own text (mirrors carry their own stale text): which hold a fragment, then their text by id. */
export interface SwitcherTextScan {
	/** The ids of live rows whose raw name or note holds `fragment`, ASCII case-insensitively, in any order. */
	holding(fragment: string): Iterable<string>;
	/** The text of `ids` (at most `pageSize` of them), in any order. */
	read(ids: readonly string[]): Iterable<{id: string; name: string | null; note: string | null}>;
	pageSize: number;
}

/** The page's results: labels and ancestor names read from `source` once, ancestors from the skeleton's parents. */
function compactPage(
	skeleton: SwitcherSkeleton,
	page: readonly {at: number; completed: boolean}[],
	words: readonly string[],
	starred: ReadonlySet<string>,
	source: RowTextSource,
): SwitcherResult[] {
	const {ids} = skeleton;
	const chains = page.map(({at}) => {
		const chain: number[] = [];
		for (let up = skeleton.parent[at] ?? -1; up >= 0; up = skeleton.parent[up] ?? -1) {
			chain.push(up);
		}
		return chain.toReversed();
	});
	const wanted = [...new Set([...page.map(({at}) => at), ...chains.flat()])].map((at) => ids[at] ?? "");
	const names = new Map<string, string>();
	for (let start = 0; start < wanted.length; start += source.pageSize) {
		for (const [id, found] of source.read(wanted.slice(start, start + source.pageSize))) {
			names.set(id, stripHtmlTags(found.name ?? ""));
		}
	}
	const nameOf = (at: number): string => names.get(ids[at] ?? "") ?? "";
	return page.map(({at, completed}, i) => ({
		id: ids[at] ?? "",
		labelHtml: matchField(words, nameOf(at)).html,
		completed,
		starred: starred.has(ids[at] ?? ""),
		ancestors: (chains[i] ?? []).map((up) => ({id: ids[up] ?? "", name: nameOf(up)})),
	}));
}

/**
 * Text of printable ASCII, tabs and line breaks without a tag or an entity: stripping leaves it whole, and folding and
 * indexing only lowercase it. Anything else takes the exact path.
 */
const NOT_SIMPLE = /[^\t\n\r -%'-;=-~]/u;

function isSimpleText(text: string | null): boolean {
	return text === null || !NOT_SIMPLE.test(text);
}

/** An ASCII letter or digit, `#` or `@`: what precedes a word without starting it, in ASCII text. */
function isAsciiWordChar(code: number | undefined): boolean {
	if (code === undefined) {
		return false;
	}
	return (
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x23 ||
		code === 0x40
	);
}

/** matchField's word-start test of a plain ASCII `word` in lowercased ASCII `text`, without a regexp. */
function asciiWordStart(text: string, word: string): boolean {
	for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
		if (i === 0 || !isAsciiWordChar(text.codePointAt(i - 1))) {
			return true;
		}
	}
	return false;
}

/**
 * {@link rankSwitcher} over a cached {@link SwitcherSkeleton}, reading only as much text as the page needs: the rows
 * that may hold the longest query word (those `scan` finds holding it plus those whose text folds; every row for one
 * letter) each get an upper bound on their score from their skeleton entry, and text is read a page at a time from the highest bound down, each row scored and dropped. The
 * read stops once enough hits beat every unread bound, unless the page's score ties need the trie gather order's
 * first insertions, which only every hit can tell. Labels and ancestor names are read from `source` afterwards. For
 * {@link isCompactSwitcherQuery} queries only.
 */
export function rankSwitcherCompact(
	skeleton: SwitcherSkeleton,
	query: string,
	starredIds: readonly string[],
	nowSec: number,
	options: RankSwitcherOptions,
	scan: SwitcherTextScan,
	source: RowTextSource,
): SwitcherResponse {
	const {joinedSec, offset = 0, limit = DEFAULT_LIMIT, excludeId, showCompleted = false} = options;
	const starred = new Set(starredIds);
	const words = splitIntoWords(nestedSegments(query).at(-1) ?? "");
	if (words.length === 0) {
		return {results: [], hasMore: false};
	}
	const longest = words.toSorted((a, b) => b.length - a.length)[0]?.slice(0, INDEX_WORD_LENGTH) ?? "";
	const longestAtWordStart = wordStart(longest);
	const wordRegExps = words.map(wordStart);
	const asciiWords = words.every((word) => PLAIN_WORD.test(word));
	const hitsEvery = (field: string): boolean => wordRegExps.every((regexp) => regexp.test(field));
	const simpleHitsEvery = asciiWords
		? (field: string): boolean => words.every((word) => asciiWordStart(field, word))
		: hitsEvery;
	const simpleAtWordStart = asciiWords
		? (field: string): boolean => asciiWordStart(field, longest)
		: (field: string): boolean => longestAtWordStart.test(field);
	const prefixWords = wordsStartingWith(longest);
	const {ids: skeletonIds, position, flags, depth, childCount, nameLength, modifiedMs, layoutModes} = skeleton;

	// Each candidate's skeleton position, static score and score bound; a name hit's text factor is at most
	// 10 x query length / index name length, and a simple name's index text is as long as the name.
	const candidateAt: number[] = [];
	const candidateIds: string[] = [];
	const candidateBase: number[] = [];
	const candidateBound: number[] = [];
	const consider = (at: number): void => {
		const id = skeletonIds[at] ?? "";
		const flag = flags[at] ?? 0;
		const completed = (flag & (COMPLETED | UNDER_COMPLETED)) !== 0;
		if ((flag & MIRROR) !== 0 || (completed && !showCompleted) || id === excludeId) {
			return;
		}
		const modified = modifiedMs[at] ?? Number.NaN;
		const base = baseScore({
			depth: depth[at] ?? 0,
			childCount: childCount[at] ?? 0,
			completed,
			lastModifiedSec: Number.isNaN(modified) ? null : Math.floor(modified / 1000),
			joinedSec,
			nowSec,
			layoutMode: layoutModes.get(at) ?? null,
			starred: starred.has(id),
		});
		const length = nameLength[at] ?? 0;
		let bound: number;
		if (length === 0) {
			bound = 0;
		} else if ((flag & SIMPLE_NAME) === 0) {
			// Stripping, folding and decoding can shorten the name to a single character.
			bound = base * 4 * (longest.length * 10);
		} else {
			bound = base * ((flag & TAGGED_NAME) === 0 ? 1 : 2) * ((longest.length / length) * 10);
		}
		candidateAt.push(at);
		candidateIds.push(id);
		candidateBase.push(base);
		candidateBound.push(bound);
	};
	const fragment = scanFragment(longest);
	if (fragment === null || fragment.length === 1) {
		// Nearly every row holds one letter, so a scan would filter out little at the cost of reading every row.
		for (let at = 0; at < skeletonIds.length; at++) {
			consider(at);
		}
	} else {
		// A row holds the fragment in its folded text only if its raw text holds it, or folding can change the text.
		const considered = new Uint8Array(skeletonIds.length);
		for (let at = 0; at < skeletonIds.length; at++) {
			if (((flags[at] ?? 0) & FOLDS) !== 0) {
				considered[at] = 1;
				consider(at);
			}
		}
		for (const id of scan.holding(fragment)) {
			const at = position.get(id);
			if (at !== undefined && considered[at] === 0) {
				considered[at] = 1;
				consider(at);
			}
		}
	}
	const order = Uint32Array.from(candidateAt, (_, i) => i).toSorted(
		(a, b) => (candidateBound[b] ?? 0) - (candidateBound[a] ?? 0),
	);
	const baseOf = new Map<string, number>();
	const atOf = new Map<string, number>();

	const hits: CompactHit[] = [];
	const score = (found: {id: string; name: string | null; note: string | null}): void => {
		const at = atOf.get(found.id);
		const base = baseOf.get(found.id);
		if (at === undefined || base === undefined) {
			return;
		}
		const completed = ((flags[at] ?? 0) & (COMPLETED | UNDER_COMPLETED)) !== 0;
		const name = found.name ?? "";
		let nameHit: boolean;
		let noteHit: boolean;
		let indexName: string;
		let indexNote: string;
		let boost: number;
		let hitWords: string[];
		if (isSimpleText(found.name) && isSimpleText(found.note)) {
			// Stripping only trims and folding only lowercases, which moves no word start, so one lowercase copy serves
			// every field; with no tag, entity or time pill the index text is that copy too.
			const lowerName = name.toLowerCase();
			const lowerNote = (found.note ?? "").toLowerCase();
			if (!lowerName.includes(longest) && !lowerNote.includes(longest)) {
				return;
			}
			if (!simpleHitsEvery(lowerName) && !simpleHitsEvery(lowerNote)) {
				return;
			}
			nameHit = simpleAtWordStart(lowerName);
			noteHit = simpleAtWordStart(lowerNote);
			indexName = lowerName;
			indexNote = lowerNote;
			// The markup boost needs a tag, and the tag boost a # or @.
			boost = name.includes("#") || name.includes("@") ? nameBoost(name) : 1;
			hitWords = asciiWordsStartingWith(nameHit ? lowerName : lowerNote, longest);
		} else {
			const text = computeRowText(found);
			if (!text.foldedName.includes(longest) && !text.foldedNote.includes(longest)) {
				return;
			}
			const [plainNameField, rawNameField, noteField] = matchFields(found, text);
			if (!hitsEvery(plainNameField) && !hitsEvery(rawNameField) && !hitsEvery(noteField)) {
				return;
			}
			nameHit = longestAtWordStart.test(plainNameField);
			noteHit = longestAtWordStart.test(noteField);
			({indexName, indexNote} = indexTexts(found, text));
			boost = nameBoost(name);
			hitWords = prefixWords(nameHit ? indexName : indexNote);
		}
		hits.push({
			score: base * boost * textFactor(longest, indexName, indexNote, nameHit, noteHit),
			at,
			completed,
			nameHit,
			words: hitWords,
		});
	};

	const end = offset + limit;
	const rank = (complete: boolean): SwitcherResult[] | undefined => {
		const descending = Float64Array.from(hits, (hit) => hit.score)
			.toSorted()
			.toReversed();
		// The page holds the scores from the offset-th highest down to the end-th highest, ties included.
		const highest = descending[offset] ?? Number.NEGATIVE_INFINITY;
		const lowest = descending[Math.min(end, descending.length) - 1] ?? Number.POSITIVE_INFINITY;
		const above = descending.findIndex((hitScore) => hitScore <= highest);
		const tied = hits.filter((hit) => hit.score >= lowest && hit.score <= highest);
		const gathered = gatherOrder(longest, complete ? hits : undefined, tied);
		const onPage = tied.toSorted((a, b) => b.score - a.score || gathered.compare(a, b) || a.at - b.at);
		if (gathered.incomplete) {
			return undefined;
		}
		const start = offset - (above === -1 ? 0 : above);
		return compactPage(skeleton, onPage.slice(start, start + limit), words, starred, source);
	};

	let read = 0;
	while (read < order.length) {
		const ids: string[] = [];
		for (const index of order.subarray(read, read + scan.pageSize)) {
			const id = candidateIds[index] ?? "";
			ids.push(id);
			atOf.set(id, candidateAt[index] ?? 0);
			baseOf.set(id, candidateBase[index] ?? 0);
		}
		read += ids.length;
		for (const found of scan.read(ids)) {
			score(found);
		}
		const unreadBound = candidateBound[order[read] ?? 0] ?? 0;
		// Every unread row scores at most its bound, so once the end-th score beats the highest unread bound, no unread row
		// reaches or ties the page, and one more hit than the page shows there are more.
		if (read < order.length && hits.length > end) {
			const endScore = Float64Array.from(hits, (hit) => hit.score)
				.toSorted()
				.at(-end);
			if (endScore !== undefined && endScore > unreadBound) {
				const results = rank(false);
				if (results !== undefined) {
					return {results, hasMore: true};
				}
			}
		}
	}
	return {results: rank(true) ?? [], hasMore: hits.length > end};
}

interface CompactHit {
	score: number;
	/** Preorder position: the index insertion order, and the last tie-break. */
	at: number;
	completed: boolean;
	nameHit: boolean;
	/** The index words starting with the longest query word, of the name for a name hit and the note otherwise. */
	words: string[];
}

/** `indexWords(text)` that start with the plain ASCII `prefix`, for lowercased ASCII `text`, without a regexp. */
function asciiWordsStartingWith(text: string, prefix: string): string[] {
	const found: string[] = [];
	for (let i = text.indexOf(prefix); i !== -1; i = text.indexOf(prefix, i + 1)) {
		if (i > 0 && isAsciiWordChar(text.codePointAt(i - 1))) {
			continue;
		}
		let stop = i + prefix.length;
		while (stop < text.length && isAsciiWordChar(text.codePointAt(stop))) {
			stop++;
		}
		found.push(text.slice(i, Math.min(stop, i + INDEX_WORD_LENGTH)));
	}
	return found;
}

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

/** A position in the index insertion order: an entry's preorder position, then a word's place in it. */
type Insertion = [at: number, word: number];

/**
 * Upstream's trie gather order (see {@link gatherPositions}) between `candidates`, without building the trie: the
 * name hits and the other hits gather separately, an id sits at its earliest-visited word, words visit depth first
 * (a word before its extensions, digit keys first, other keys in the order the whole group first inserted them),
 * and ids at one word in insertion order. Only the candidates' prefixes need their first insertions, so each of
 * `hits` is checked against those alone. Without `hits` (not every hit is known), a comparison that needs a first
 * insertion answers 0 and sets `incomplete`.
 */
function gatherOrder(
	longest: string,
	hits: readonly CompactHit[] | undefined,
	candidates: readonly CompactHit[],
): {compare: (a: CompactHit, b: CompactHit) => number; incomplete: boolean} {
	const tracked = [new Map<string, Insertion>(), new Map<string, Insertion>()] as const;
	const groupOf = (hit: CompactHit) => tracked[hit.nameHit ? 0 : 1];
	if (hits !== undefined) {
		for (const hit of candidates) {
			const firstInsertions = groupOf(hit);
			for (const word of hit.words) {
				for (let length = longest.length + 1; length <= word.length; length++) {
					firstInsertions.set(word.slice(0, length), [Number.POSITIVE_INFINITY, 0]);
				}
			}
		}
		for (const hit of hits) {
			const firstInsertions = groupOf(hit);
			hit.words.forEach((word, index) => {
				// Tracked prefixes are closed under shortening, so the first untracked one ends the walk.
				for (let length = longest.length + 1; length <= word.length; length++) {
					const first = firstInsertions.get(word.slice(0, length));
					if (first === undefined) {
						break;
					}
					if (hit.at < first[0] || (hit.at === first[0] && index < first[1])) {
						first[0] = hit.at;
						first[1] = index;
					}
				}
			});
		}
	}
	const result = {compare: (_a: CompactHit, _b: CompactHit): number => 0, incomplete: false};
	const visitedBefore = (firstInsertions: Map<string, Insertion>, a: string, b: string): number => {
		let common = 0;
		while (common < a.length && common < b.length && a[common] === b[common]) {
			common++;
		}
		if (common === a.length || common === b.length) {
			return a.length - b.length;
		}
		const keyA = a.codePointAt(common) ?? 0;
		const keyB = b.codePointAt(common) ?? 0;
		if (isDigit(keyA) || isDigit(keyB)) {
			return isDigit(keyA) && isDigit(keyB) ? keyA - keyB : isDigit(keyA) ? -1 : 1;
		}
		if (hits === undefined) {
			result.incomplete = true;
			return 0;
		}
		const firstA = firstInsertions.get(a.slice(0, common + 1)) ?? [Number.POSITIVE_INFINITY, 0];
		const firstB = firstInsertions.get(b.slice(0, common + 1)) ?? [Number.POSITIVE_INFINITY, 0];
		return firstA[0] - firstB[0] || firstA[1] - firstB[1];
	};
	const earliestWord = new Map<CompactHit, string | undefined>();
	const earliest = (hit: CompactHit): string | undefined => {
		if (!earliestWord.has(hit)) {
			const firstInsertions = groupOf(hit);
			earliestWord.set(
				hit,
				hit.words.reduce<string | undefined>(
					(best, word) =>
						best === undefined || visitedBefore(firstInsertions, word, best) < 0 ? word : best,
					undefined,
				),
			);
		}
		return earliestWord.get(hit);
	};
	result.compare = (a, b) => {
		if (a.nameHit !== b.nameHit) {
			return 0;
		}
		const wordA = earliest(a);
		const wordB = earliest(b);
		if (wordA === undefined || wordB === undefined) {
			// A hit without an index word is never gathered, so it follows every gathered one.
			return wordA === wordB ? 0 : wordA === undefined ? 1 : -1;
		}
		return wordA === wordB ? a.at - b.at : visitedBefore(groupOf(a), wordA, wordB);
	};
	return result;
}
