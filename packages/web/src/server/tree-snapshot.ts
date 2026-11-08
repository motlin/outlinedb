import {aiMetadata, referencesRoots} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import type {AppDatabase} from "@workflowy/shared/db";
import {compactSwitcherSkeleton, warmSwitcher} from "./switcher-search.js";
import type {SwitcherSkeleton, SwitcherTextScan} from "./switcher-search.js";
import {changedNodeIds, changesSince, latestSystemTime, readConsistently} from "./system-changes.js";
import type {TreeSearchRow} from "./tree-search.js";

export type Database = AppDatabase;

/** What tells the snapshot another connection committed, and whether the database is still usable. */
export interface ChangeSource {
	/** Changes whenever a connection other than this server's commits to the database. */
	dataVersion(): string;
	/** False once the database is closed, so a pending rebuild is skipped. */
	isOpen(): boolean;
}

/** Timers for the debounced background rebuild, so a host without `setTimeout().unref()` can supply its own. */
export interface TreeScheduler {
	/** Runs `run` once after `delayMs`; the returned function cancels it. */
	setTimer(run: () => void, delayMs: number): () => void;
}

export interface TreeHost {
	changeSource: ChangeSource;
	scheduler: TreeScheduler;
}

const hosts = new WeakMap<Database, TreeHost>();

/** Attach the host's change source and scheduler to `database`; the snapshot cannot be read before this. */
export function bindTreeHost(database: Database, host: TreeHost): void {
	hosts.set(database, host);
}

function hostOf(database: Database): TreeHost {
	const host = hosts.get(database);
	if (host === undefined) {
		throw new Error("No tree host is bound to the database; call bindTreeHost first");
	}
	return host;
}

interface TreeSqlRow {
	id: string;
	parentId: string | null;
	priority: number | null;
	name: string | null;
	note: string | null;
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
	layoutMode: string | null;
	isMirror: number;
	/** Distance from the seed rows' depth, so whole-tree rows count from a top-level node at 0. */
	depth: number;
	isReferencesRoot: number;
	underReferencesRoot: number;
	/** An `ai.inChat` item (upstream's "AI Messages" mailbox), whose subtree the tree does not descend into. */
	isInChat: number;
	/** The MIME type of the live, not deleted, attachment (`s3_files`), or null. */
	fileType: string | null;
}

/** Epoch seconds as stored by drizzle's timestamp mode, to milliseconds. */
function toMillis(seconds: number | null): number | null {
	return seconds === null ? null : seconds * 1000;
}

function toSearchRow(row: TreeSqlRow): TreeSearchRow {
	return {
		id: row.id,
		parentId: row.parentId,
		priority: row.priority,
		name: row.name,
		note: row.note,
		createdAt: toMillis(row.createdAt),
		modifiedAt: toMillis(row.modifiedAt),
		completedAt: toMillis(row.completedAt),
		layoutMode: row.layoutMode,
		isMirror: row.isMirror === 1,
		isBacklink: row.underReferencesRoot === 1,
		fileType: row.fileType,
	};
}

/**
 * References roots and their backlink items are never search rows, though the tree continues below them.
 * Nor is an `ai.inChat` item, below which the tree stops, like upstream's `inline_search.ignore` rule.
 */
function isSearchable(row: TreeSqlRow): boolean {
	return row.isReferencesRoot === 0 && row.underReferencesRoot === 0 && row.isInChat === 0;
}

const LIVE_REFERENCES_ROOTS = sql`(SELECT node_id FROM ${referencesRoots} WHERE system_to = ${FAR_FUTURE_DATE})`;
const LIVE_IN_CHAT = sql`(SELECT node_id FROM ${aiMetadata} WHERE in_chat = 1 AND system_to = ${FAR_FUTURE_DATE})`;

/**
 * The live rows `seeds` (an `(id, depth)` select) names, and with `recursive` every live row below them,
 * ordered by depth then id. References roots and their children are included, flagged, since live rows
 * further down are still reachable through them. An `ai.inChat` row is included, flagged, but nothing below it.
 * A mirror takes its text from its live original.
 */
function selectTreeRows(database: Database, seeds: SQL, recursive: boolean, withText = true): TreeSqlRow[] {
	const subtree = recursive
		? sql`WITH RECURSIVE subtree(id, depth) AS (
			${seeds}
			UNION ALL
			SELECT n.id, s.depth + 1 FROM node_content n
			INNER JOIN subtree s ON n.parent_id = s.id
			WHERE n.system_to = ${FAR_FUTURE_DATE} AND s.id NOT IN ${LIVE_IN_CHAT}
		)`
		: sql`WITH subtree(id, depth) AS (${seeds})`;
	return database.all<TreeSqlRow>(sql`
		${subtree}
		SELECT
			c.id AS id,
			c.parent_id AS parentId,
			m.priority AS priority,
			${withText ? sql`CASE WHEN o.id IS NULL THEN c.name ELSE o.name END` : sql`NULL`} AS name,
			${withText ? sql`CASE WHEN o.id IS NULL THEN c.note ELSE o.note END` : sql`NULL`} AS note,
			m.created_at AS createdAt,
			m.modified_at AS modifiedAt,
			CASE WHEN mi.mirror_id IS NULL THEN m.completed_at ELSE om.completed_at END AS completedAt,
			m.layout_mode AS layoutMode,
			mi.mirror_id IS NOT NULL AS isMirror,
			s.depth AS depth,
			c.id IN ${LIVE_REFERENCES_ROOTS} AS isReferencesRoot,
			coalesce(c.parent_id IN ${LIVE_REFERENCES_ROOTS}, 0) AS underReferencesRoot,
			c.id IN ${LIVE_IN_CHAT} AS isInChat,
			(SELECT f.file_type FROM s3_files f WHERE f.node_id = c.id AND f.system_to = ${FAR_FUTURE_DATE} AND coalesce(f.is_deleted, 0) = 0) AS fileType
		FROM subtree s
		INNER JOIN node_content c ON c.id = s.id AND c.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN node_metadata m ON m.node_id = c.id AND m.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN mirrors mi ON mi.mirror_id = c.id AND mi.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN node_content o ON o.id = mi.original_id AND o.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN node_metadata om ON om.node_id = mi.original_id AND om.system_to = ${FAR_FUTURE_DATE}
		ORDER BY s.depth, c.id
	`);
}

const TOP_LEVEL_SEEDS = sql`SELECT id, 0 FROM node_content WHERE parent_id IS NULL AND system_to = ${FAR_FUTURE_DATE}`;

/** `(id, depth)` seeds from a list of pairs. */
function seedsOf(pairs: [id: string, depth: number][]): SQL {
	return sql`SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${JSON.stringify(pairs)})`;
}

/**
 * The live subtree under `rootId` (including the root; every top-level tree when null) for tree search,
 * ordered by depth then id. References roots and their backlink items are skipped, as are `ai.inChat` items
 * and everything below them. A mirror takes its text from its live original.
 */
export function loadTreeSearchRows(database: AppDatabase, rootId: string | null): TreeSearchRow[] {
	const seeds =
		rootId === null
			? TOP_LEVEL_SEEDS
			: sql`SELECT id, 0 FROM node_content WHERE id = ${rootId} AND system_to = ${FAR_FUTURE_DATE}`;
	return selectTreeRows(database, seeds, true).filter(isSearchable).map(toSearchRow);
}

/**
 * {@link loadTreeSearchRows} for the whole tree without the text: `name` and `note` are null. What a search over
 * a tree too large to hold with its text in memory (a 128 MB Durable Object) ranks on, reading text in
 * {@link loadTreeRowText} pages.
 */
export function loadTreeSkeletonRows(database: AppDatabase): TreeSearchRow[] {
	return selectTreeRows(database, TOP_LEVEL_SEEDS, true, false).filter(isSearchable).map(toSearchRow);
}

/** The live text of `ids` (a mirror's from its original), keyed by id; ids that are not live are absent. */
export function loadTreeRowText(
	database: AppDatabase,
	ids: readonly string[],
): Map<string, {name: string | null; note: string | null}> {
	const rows = database.all<{id: string; name: string | null; note: string | null}>(sql`
		SELECT
			c.id AS id,
			CASE WHEN o.id IS NULL THEN c.name ELSE o.name END AS name,
			CASE WHEN o.id IS NULL THEN c.note ELSE o.note END AS note
		FROM json_each(${JSON.stringify(ids)}) j
		INNER JOIN node_content c ON c.id = j.value AND c.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN mirrors mi ON mi.mirror_id = c.id AND mi.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN node_content o ON o.id = mi.original_id AND o.system_to = ${FAR_FUTURE_DATE}
	`);
	return new Map(rows.map(({id, name, note}) => [id, {name, note}]));
}

interface FlatSkeletonSqlRow {
	id: string;
	parentId: string | null;
	priority: number | null;
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
	layoutMode: string | null;
	isMirror: number;
	isReferencesRoot: number;
	isInChat: number;
	nameLength: number | null;
	simpleName: number | null;
	taggedName: number | null;
	folds: number;
}

/**
 * The jump menu's {@link SwitcherSkeleton} from one flat query over every live row, the tree walked in memory: the same
 * rows, order and placement as {@link loadTreeSkeletonRows}' recursive query, which costs several times more on a
 * Durable Object.
 */
export function buildSwitcherSkeleton(database: Database): SwitcherSkeleton {
	const flat = database.all<FlatSkeletonSqlRow>(sql`
		SELECT
			c.id AS id,
			c.parent_id AS parentId,
			m.priority AS priority,
			m.created_at AS createdAt,
			m.modified_at AS modifiedAt,
			CASE WHEN mi.mirror_id IS NULL THEN m.completed_at ELSE om.completed_at END AS completedAt,
			m.layout_mode AS layoutMode,
			mi.mirror_id IS NOT NULL AS isMirror,
			c.id IN ${LIVE_REFERENCES_ROOTS} AS isReferencesRoot,
			c.id IN ${LIVE_IN_CHAT} AS isInChat,
			length(c.name) AS nameLength,
			length(c.name) = octet_length(c.name) AND instr(c.name, '<') = 0 AND instr(c.name, '&') = 0 AS simpleName,
			instr(c.name, '#') > 0 OR instr(c.name, '@') > 0 AS taggedName,
			coalesce(
				instr(c.name, '<') > 0 OR instr(c.note, '<') > 0
				OR length(c.name) <> octet_length(c.name) OR length(c.note) <> octet_length(c.note),
				0
			) AS folds
		FROM node_content c
		LEFT JOIN node_metadata m ON m.node_id = c.id AND m.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN mirrors mi ON mi.mirror_id = c.id AND mi.system_to = ${FAR_FUTURE_DATE}
		LEFT JOIN node_metadata om ON om.node_id = mi.original_id AND om.system_to = ${FAR_FUTURE_DATE}
		WHERE c.system_to = ${FAR_FUTURE_DATE}
	`);
	const children = new Map<string, FlatSkeletonSqlRow[]>();
	const referencesRootIds = new Set<string>();
	let level: FlatSkeletonSqlRow[] = [];
	for (const row of flat) {
		if (row.isReferencesRoot === 1) {
			referencesRootIds.add(row.id);
		}
		if (row.parentId === null) {
			level.push(row);
			continue;
		}
		const siblings = children.get(row.parentId);
		if (siblings) {
			siblings.push(row);
		} else {
			children.set(row.parentId, [row]);
		}
	}
	// Breadth first, each depth by id, as the recursive query orders them; nothing below an `ai.inChat` item.
	const reached: FlatSkeletonSqlRow[] = [];
	while (level.length > 0) {
		level.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		// A loop, not push(...level), so a wide level cannot overflow the call stack.
		for (const row of level) {
			reached.push(row);
		}
		level = level.flatMap((row) => (row.isInChat === 1 ? [] : (children.get(row.id) ?? [])));
	}
	const searchable = reached.filter(
		(row) =>
			row.isReferencesRoot === 0 &&
			row.isInChat === 0 &&
			(row.parentId === null || !referencesRootIds.has(row.parentId)),
	);
	return compactSwitcherSkeleton(
		searchable.map((row) => ({
			id: row.id,
			parentId: row.parentId,
			priority: row.priority,
			name: null,
			note: null,
			createdAt: toMillis(row.createdAt),
			modifiedAt: toMillis(row.modifiedAt),
			completedAt: toMillis(row.completedAt),
			layoutMode: row.layoutMode,
			isMirror: row.isMirror === 1,
			isBacklink: false,
			fileType: null,
		})),
		searchable.map((row) => ({
			nameLength: row.nameLength ?? 0,
			simpleName: row.simpleName === 1,
			taggedName: row.taggedName === 1,
			folds: row.folds === 1,
		})),
	);
}

const switcherSkeletons = new WeakMap<Database, {state: ChangeState; skeleton: SwitcherSkeleton}>();

/**
 * The jump menu's compact whole-tree skeleton, kept per database until it changes, so a burst of keystrokes builds it
 * once instead of rerunning the recursive tree query for each. Built afresh each call when no tree host is bound.
 */
export function loadSwitcherSkeleton(database: Database): SwitcherSkeleton {
	if (!hosts.has(database)) {
		// Without a change source nothing tells a cached skeleton is stale.
		return buildSwitcherSkeleton(database);
	}
	const state = changeState(database);
	const cached = switcherSkeletons.get(database);
	if (
		cached !== undefined &&
		cached.state.dataVersion === state.dataVersion &&
		cached.state.changes === state.changes
	) {
		return cached.skeleton;
	}
	const skeleton = buildSwitcherSkeleton(database);
	switcherSkeletons.set(database, {state, skeleton});
	return skeleton;
}

/** The held switcher skeleton without checking for writes or rebuilding, for tests. */
export function peekSwitcherSkeleton(database: Database): SwitcherSkeleton | undefined {
	return switcherSkeletons.get(database)?.skeleton;
}

const skeletonTimers = new WeakMap<Database, () => void>();

/**
 * Runs `run`, then, when it changed the database and a switcher skeleton is held, rebuilds the skeleton
 * {@link REBUILD_DEBOUNCE_MS} after the last such write, off the request path, so the next jump-menu keystroke does not
 * pay for it. A skeleton not yet held is left for the first jump-menu query, so writes on a freshly woken Durable Object
 * never start a build nobody asked for.
 */
export async function withSwitcherSkeletonRebuild<T>(database: Database, run: () => Promise<T>): Promise<T> {
	const before = changeState(database).changes;
	try {
		return await run();
	} finally {
		if (switcherSkeletons.has(database) && changeState(database).changes !== before) {
			skeletonTimers.get(database)?.();
			const {changeSource, scheduler} = hostOf(database);
			const cancel = scheduler.setTimer(() => {
				skeletonTimers.delete(database);
				if (changeSource.isOpen()) {
					loadSwitcherSkeleton(database);
				}
			}, REBUILD_DEBOUNCE_MS);
			skeletonTimers.set(database, cancel);
		}
	}
}

/**
 * The jump menu's {@link SwitcherTextScan} over live `node_content` rows and their own text (mirrors carry their own
 * stale text; the jump menu skips them): an ASCII case-insensitive LIKE for the rows holding a fragment.
 */
export function switcherTextScan(database: Database, pageSize: number): SwitcherTextScan {
	return {
		pageSize,
		holding(fragment) {
			const pattern = `%${fragment}%`;
			return database
				.all<{id: string}>(sql`
					SELECT c.id AS id
					FROM node_content c
					WHERE c.system_to = ${FAR_FUTURE_DATE} AND (c.name LIKE ${pattern} OR c.note LIKE ${pattern})
				`)
				.map(({id}) => id);
		},
		read(ids) {
			return database.all<{id: string; name: string | null; note: string | null}>(sql`
				SELECT c.id AS id, c.name AS name, c.note AS note
				FROM json_each(${JSON.stringify(ids)}) j
				INNER JOIN node_content c ON c.id = j.value AND c.system_to = ${FAR_FUTURE_DATE}
			`);
		},
	};
}

/** Where a live node reachable from a top-level node sits, searchable or not. */
interface TreeNode {
	parentId: string | null;
	depth: number;
	isReferencesRoot: boolean;
	isInChat: boolean;
}

interface TreeSnapshot {
	dataVersion: string;
	changes: number;
	/** The newest system time the snapshot has read, from which the next patch looks for changes. */
	latest: string;
	build: "full" | "patch";
	/** The searchable rows, ordered by depth then id like {@link loadTreeSearchRows}. */
	rows: TreeSearchRow[];
	byId: Map<string, TreeSearchRow>;
	/** Every live node reachable from a top-level node, including references roots, their children and `ai.inChat` items. */
	nodes: Map<string, TreeNode>;
	childIds: Map<string | null, Set<string>>;
}

/** How long after the last write the background rebuild waits, so a burst of edits costs one reload. */
const REBUILD_DEBOUNCE_MS = 500;

/** Above this many changed nodes, a patch would cost about as much as reloading the whole tree. */
const PATCH_LIMIT = 1000;

const snapshots = new WeakMap<Database, TreeSnapshot>();
const rebuildTimers = new WeakMap<Database, () => void>();

interface ChangeState {
	/** Bumped by commits from any other connection (another process's cache refresh). */
	dataVersion: string;
	/** Rows this connection has written, so this server's own edits. */
	changes: number;
}

function changeState(database: Database): ChangeState {
	const dataVersion = hostOf(database).changeSource.dataVersion();
	const {changes} = database.get<{changes: number}>(sql`SELECT total_changes() AS changes`);
	return {dataVersion, changes};
}

const ROW_FIELDS = [
	"id",
	"parentId",
	"priority",
	"name",
	"note",
	"createdAt",
	"modifiedAt",
	"completedAt",
	"layoutMode",
	"isMirror",
	"isBacklink",
	"fileType",
] as const satisfies readonly (keyof TreeSearchRow)[];

/** `old` when every field of `row` is unchanged, keeping caches keyed on the row object warm. */
function reuseRow(old: TreeSearchRow | undefined, row: TreeSearchRow): TreeSearchRow {
	return old !== undefined && ROW_FIELDS.every((field) => old[field] === row[field]) ? old : row;
}

function isCurrent(snapshot: TreeSnapshot, state: ChangeState): boolean {
	return snapshot.dataVersion === state.dataVersion && snapshot.changes === state.changes;
}

function addNode(snapshot: TreeSnapshot, row: TreeSqlRow): void {
	snapshot.nodes.set(row.id, {
		parentId: row.parentId,
		depth: row.depth,
		isReferencesRoot: row.isReferencesRoot === 1,
		isInChat: row.isInChat === 1,
	});
	const siblings = snapshot.childIds.get(row.parentId);
	if (siblings) {
		siblings.add(row.id);
	} else {
		snapshot.childIds.set(row.parentId, new Set([row.id]));
	}
}

function removeNode(snapshot: TreeSnapshot, id: string): void {
	const node = snapshot.nodes.get(id);
	if (node === undefined) {
		return;
	}
	snapshot.nodes.delete(id);
	snapshot.byId.delete(id);
	const siblings = snapshot.childIds.get(node.parentId);
	siblings?.delete(id);
	if (siblings?.size === 0) {
		snapshot.childIds.delete(node.parentId);
	}
}

/** `id` and every node below it in the snapshot. */
function subtreeIds(snapshot: TreeSnapshot, id: string): string[] {
	const ids = [id];
	// The array iterator sees ids pushed during the loop, so this walks the subtree breadth-first.
	for (const member of ids) {
		ids.push(...(snapshot.childIds.get(member) ?? []));
	}
	return ids;
}

function fullSnapshot(database: Database, state: ChangeState): TreeSnapshot {
	const previous = snapshots.get(database);
	const {latest, tree} = readConsistently(database, () => ({
		latest: latestSystemTime(database),
		tree: selectTreeRows(database, TOP_LEVEL_SEEDS, true),
	}));
	const snapshot: TreeSnapshot = {
		...state,
		latest,
		build: "full",
		rows: [],
		byId: new Map(),
		nodes: new Map(),
		childIds: new Map(),
	};
	for (const row of tree) {
		addNode(snapshot, row);
		if (isSearchable(row)) {
			const searchRow = reuseRow(previous?.byId.get(row.id), toSearchRow(row));
			snapshot.rows.push(searchRow);
			snapshot.byId.set(row.id, searchRow);
		}
	}
	return snapshot;
}

/** Orders rows by depth, then id, as {@link selectTreeRows} does. */
function compareRows(snapshot: TreeSnapshot, a: string, b: string): number {
	const depthA = snapshot.nodes.get(a)?.depth ?? 0;
	const depthB = snapshot.nodes.get(b)?.depth ?? 0;
	if (depthA !== depthB) {
		return depthA - depthB;
	}
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

/** The index of the first row in `rows` ordered at or after `id`. */
function rowPosition(snapshot: TreeSnapshot, rows: TreeSearchRow[], id: string): number {
	let low = 0;
	let high = rows.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (compareRows(snapshot, rows[middle]?.id ?? id, id) < 0) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

/**
 * Patch `snapshot` in place with the nodes that changed since it was read, or null when too many did.
 * A node whose parent, liveness, references-root or `ai.inChat` flag changed is a move: its old subtree leaves the snapshot
 * and its new one is reloaded. Any other changed node keeps its place, so only its row is replaced.
 */
function patchSnapshot(database: Database, snapshot: TreeSnapshot, state: ChangeState): TreeSnapshot | null {
	return readConsistently(database, () => {
		const latest = latestSystemTime(database);
		const changed = changedNodeIds(database, changesSince(snapshot.latest), PATCH_LIMIT);
		if (changed === undefined) {
			return null;
		}
		const current = new Map(
			selectTreeRows(database, seedsOf([...changed].map((id) => [id, 0])), false).map((row) => [row.id, row]),
		);
		const edited: TreeSqlRow[] = [];
		const moved: string[] = [];
		for (const id of changed) {
			const before = snapshot.nodes.get(id);
			const after = current.get(id);
			if (before === undefined && after === undefined) {
				continue;
			}
			if (
				before !== undefined &&
				after !== undefined &&
				before.parentId === after.parentId &&
				before.isReferencesRoot === (after.isReferencesRoot === 1) &&
				before.isInChat === (after.isInChat === 1)
			) {
				edited.push(after);
			} else {
				moved.push(id);
			}
		}

		const removed = new Map<string, TreeSearchRow | undefined>();
		for (const id of moved) {
			if (snapshot.nodes.has(id)) {
				for (const member of subtreeIds(snapshot, id)) {
					removed.set(member, snapshot.byId.get(member));
				}
			}
		}
		for (const id of removed.keys()) {
			removeNode(snapshot, id);
		}

		const roots: [id: string, depth: number][] = [];
		for (const id of moved) {
			const parentId = current.get(id)?.parentId;
			if (parentId === null) {
				roots.push([id, 0]);
			} else if (parentId !== undefined) {
				const parent = snapshot.nodes.get(parentId);
				if (parent !== undefined && !parent.isInChat) {
					roots.push([id, parent.depth + 1]);
				}
			}
		}
		const added: TreeSearchRow[] = [];
		for (const row of roots.length > 0 ? selectTreeRows(database, seedsOf(roots), true) : []) {
			if (snapshot.nodes.has(row.id)) {
				continue;
			}
			addNode(snapshot, row);
			if (isSearchable(row)) {
				const searchRow = reuseRow(removed.get(row.id), toSearchRow(row));
				added.push(searchRow);
				snapshot.byId.set(row.id, searchRow);
			}
		}

		const replacements: TreeSearchRow[] = [];
		for (const row of edited) {
			const old = snapshot.byId.get(row.id);
			const searchRow = old === undefined || removed.has(row.id) ? old : reuseRow(old, toSearchRow(row));
			if (searchRow !== old && searchRow !== undefined) {
				replacements.push(searchRow);
				snapshot.byId.set(row.id, searchRow);
			}
		}
		let rows = snapshot.rows;
		if (removed.size > 0) {
			rows = rows.filter((row) => !removed.has(row.id));
		} else if (replacements.length > 0) {
			rows = [...rows];
		}
		for (const row of replacements) {
			rows[rowPosition(snapshot, rows, row.id)] = row;
		}
		if (added.length > 0) {
			// `added` is already in row order, so each lands at or after the previous one's position.
			// Flatten slices rather than spreading them into push(), which overflows the stack on a large slice.
			const pieces: (TreeSearchRow | TreeSearchRow[])[] = [];
			let from = 0;
			for (const row of added) {
				const to = rowPosition(snapshot, rows, row.id);
				pieces.push(rows.slice(from, to), row);
				from = to;
			}
			pieces.push(rows.slice(from));
			rows = pieces.flat();
		}

		return {
			...snapshot,
			...state,
			latest: latest > snapshot.latest ? latest : snapshot.latest,
			build: "patch",
			rows,
		};
	});
}

/** Bring the snapshot up to date: patch it when there is one, else (or when the patch is too big) reload it. */
function clearPending(database: Database): void {
	const pending = rebuildTimers.get(database);
	if (pending !== undefined) {
		pending();
		rebuildTimers.delete(database);
	}
}

function refreshSnapshot(database: Database, state: ChangeState): TreeSnapshot {
	clearPending(database);
	const previous = snapshots.get(database);
	const snapshot =
		(previous === undefined ? null : patchSnapshot(database, previous, state)) ?? fullSnapshot(database, state);
	snapshots.set(database, snapshot);
	return snapshot;
}

/**
 * Rebuild the snapshot now unless it is already current, then warm the jump menu's per-row caches for it.
 * Called at server start and by the debounced background rebuild, so the first search is warm.
 */
export function warmTreeSnapshot(database: Database): void {
	const state = changeState(database);
	const cached = snapshots.get(database);
	const snapshot = cached === undefined || !isCurrent(cached, state) ? refreshSnapshot(database, state) : cached;
	warmSwitcher(snapshot.rows);
}

/**
 * Refresh the snapshot {@link REBUILD_DEBOUNCE_MS} after the last call, off the request path.
 * `restart: false` keeps an already pending refresh's deadline, so repeated stale reads cannot postpone it forever.
 */
export function scheduleTreeSnapshotRebuild(database: Database, {restart = true}: {restart?: boolean} = {}): void {
	const pending = rebuildTimers.get(database);
	if (pending !== undefined) {
		if (!restart) {
			return;
		}
		clearPending(database);
	}
	const {changeSource, scheduler} = hostOf(database);
	const timer = scheduler.setTimer(() => {
		rebuildTimers.delete(database);
		if (changeSource.isOpen()) {
			warmTreeSnapshot(database);
		}
	}, REBUILD_DEBOUNCE_MS);
	rebuildTimers.set(database, timer);
}

/** The current snapshot's rows without checking for writes or rebuilding, for tests. */
export function peekTreeSnapshotRows(database: Database): TreeSearchRow[] | undefined {
	return snapshots.get(database)?.rows;
}

/** Whether the current snapshot was last reloaded whole or patched, for tests. */
export function peekTreeSnapshotBuild(database: Database): TreeSnapshot["build"] | undefined {
	return snapshots.get(database)?.build;
}

/**
 * Runs `run`, then schedules a background snapshot rebuild when it changed the database (the RPC path has no HTTP method to key on).
 * Only a loaded snapshot is kept warm: a write never cold-builds the whole tree in the background, so on a freshly woken
 * Durable Object a burst of edits cannot start a build that outgrows its isolate; the first search builds it instead.
 */
export async function withTreeSnapshotRebuild<T>(database: Database, run: () => Promise<T>): Promise<T> {
	const before = changeState(database).changes;
	try {
		return await run();
	} finally {
		if (snapshots.has(database) && changeState(database).changes !== before) {
			scheduleTreeSnapshotRebuild(database);
		}
	}
}

/**
 * The snapshot a request may read. A write this server made since the snapshot refreshes it right away
 * (read-your-writes for the edited node); a write only from another connection, such as the background cache
 * refresh, serves the previous snapshot while a debounced refresh runs off the request path.
 */
function wholeTreeSnapshot(database: Database): TreeSnapshot {
	const state = changeState(database);
	const cached = snapshots.get(database);
	if (cached === undefined || cached.changes !== state.changes) {
		return refreshSnapshot(database, state);
	}
	if (cached.dataVersion !== state.dataVersion) {
		scheduleTreeSnapshotRebuild(database, {restart: false});
	}
	return cached;
}

/**
 * {@link loadTreeSearchRows} served from one whole-tree snapshot per database, patched after each write
 * (see {@link wholeTreeSnapshot} for when a request may read the previous one).
 * A subtree is the root plus the searchable snapshot rows below it, in snapshot order;
 * a root outside the snapshot (a references root, or a node cut off from Home) falls back to the SQL subtree query.
 */
export function loadTreeRows(database: Database, rootId: string | null): TreeSearchRow[] {
	const snapshot = wholeTreeSnapshot(database);
	if (rootId === null) {
		return snapshot.rows;
	}
	const root = snapshot.byId.get(rootId);
	if (root === undefined) {
		return loadTreeSearchRows(database, rootId);
	}
	const members = new Set(subtreeIds(snapshot, rootId));
	// Keep the whole-tree row order, which matches the SQL subtree query's (first-seen tag casing depends on it).
	return snapshot.rows.filter((row) => members.has(row.id));
}

/** Whether `query` asks for backlink items, which are searchable only then (upstream `JP.isSearchable`). */
export function queryNeedsBacklinks(query: string): boolean {
	return /is:backlink|in:backlink/iu.test(query);
}

const REFERENCES_SEEDS = sql`SELECT id, 0 FROM node_content WHERE system_to = ${FAR_FUTURE_DATE} AND (id IN ${LIVE_REFERENCES_ROOTS} OR parent_id IN ${LIVE_REFERENCES_ROOTS})`;

/**
 * {@link loadTreeRows} plus the references roots and backlink items under the loaded rows, for a query that
 * searches backlinks. The roots carry no text and the items are mirrors of their sources, so only the items match.
 */
export function loadTreeRowsWithBacklinks(
	database: Database,
	rootId: string | null,
	load: (database: Database, rootId: string | null) => TreeSearchRow[] = loadTreeRows,
): TreeSearchRow[] {
	const rows = load(database, rootId);
	const ids = new Set(rows.map((row) => row.id));
	const references = selectTreeRows(database, REFERENCES_SEEDS, false);
	const roots = new Set(
		references.filter((row) => row.isReferencesRoot === 1 && ids.has(row.parentId ?? "")).map((row) => row.id),
	);
	return [
		...rows,
		...references
			.filter((row) => roots.has(row.id) || roots.has(row.parentId ?? ""))
			.map((row) => toSearchRow(row)),
	];
}
