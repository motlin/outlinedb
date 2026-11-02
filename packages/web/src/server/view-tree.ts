/**
 * The outline view's tree read: which lists `POST /nodes/view` sends, decided in SQL, and every one of those lists
 * read by the same statement, each row already shaped like the REST node (metadata, mirror relationships and the
 * original's text, attachment, calendar, display metadata, child flags) through correlated subqueries.
 *
 * A recursive walk visits the rows a client renders in document order: the root's children, then depth-first the
 * children of every expanded row, stopping at the row budget. The walk decides expansion the way the client does
 * (`expansionId` in `mirror-path.ts`): a row's key is its id outside any mirror and the instance key inside one, where
 * an instance is the outermost mirror root plus the first four characters of each row on the way down. The walk is
 * nested in the shaped query's criteria, so the ids it produces are never bound back.
 *
 * The listed rows' Backlinks sections are one more statement nesting the same walk: every backlink item under a list
 * parent's references root, shaped with its source's text, completion, child flags and ancestor crumbs.
 */
import {currentVersion, mirrorOriginalText, relationalRowId} from "@outlinedb/shared/cache";
import {mirrors, nodeContent, nodeTableCellSizes} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {Node} from "@outlinedb/shared/types";
import {and, eq, isNull, or, sql} from "drizzle-orm";
import {z} from "zod";
import type {SQL} from "drizzle-orm";
import {backlinksLabel} from "../backlinks-label.js";
import type {BacklinkItem, CalendarInfo, NodeAttachment, NodeResponse} from "../node-types.js";
import {addNamedCalendarDays, calendarInfoOfRow} from "./calendar-day.js";
import type {ServerContext} from "./context.js";
import {displayMetadataFields, nodeToRestDto} from "./ops/nodes-shared.js";

/** Which rows are expanded: the request's ids, the account's stored keys, or none. */
export type ViewExpansion =
	|
	  {
			kind: "ids";
			ids: readonly string[];
	  }
	|
	  {
			kind: "stored";
	  }
	|
	  {
			kind: "none";
	  };

export interface ViewTreeQuery
{
	/** The view root (resolved, possibly a mirror), or null for Home. */
	rootId: string | null;
	expansion: ViewExpansion;
	/** The visible-row budget. */
	limit: number;
	showCompleted: boolean;
}

/** The current-version marker inlined as a literal, so the walk binds only the request's own values. */
const LIVE = sql.raw(`'${FAR_FUTURE_DATE}'`);

const REFERENCES_ROOTS = sql`(SELECT node_id FROM references_roots WHERE system_to = ${LIVE})`;
const IN_CHAT = sql`(SELECT node_id FROM ai_metadata WHERE in_chat = 1 AND system_to = ${LIVE})`;

/** Added to priorities and creation times so negative values keep their order in a fixed-width sort key. */
const SORT_OFFSET = sql.raw("1000000000000000000");

/**
 * One row's slice of the walk's sort key: priority, then creation time (missing metadata as 0), then id, as the
 * lists are sorted. Fixed width up to the id, and the trailing space sorts below every id character, so a parent's
 * key followed by any child's sorts before its next sibling's: ordering by the concatenated key is document order.
 */
const SORT_SLICE = sql`printf('%020d%020d%s ', coalesce(m.priority, 0) + ${SORT_OFFSET}, coalesce(m.created_at, 0) + ${SORT_OFFSET}, c.id)`;

/** A walk row's effective completion: a mirror is completed exactly when its current original is. */
const WALK_COMPLETED = sql`CASE WHEN o.original_id IS NULL THEN m.completed_at ELSE (SELECT om.completed_at FROM node_content oc JOIN node_metadata om ON om.node_id = oc.id AND om.system_to = ${LIVE} WHERE oc.id = o.original_id AND oc.system_to = ${LIVE}) END`;

/** The expansion key of walk row `c` rendered in the instance (`root`, `path`), null outside any mirror. */
function expansionKey(expansion: ViewExpansion, root: SQL, path: SQL): SQL
{
	return expansion.kind === "stored"
		? sql`CASE WHEN ${root} IS NULL THEN substr(c.id, 1, 8) ELSE 'v_' || substr(c.id, 1, 4) || substr(${root}, 1, 4) || ${path} END`
		: sql`CASE WHEN ${root} IS NULL THEN c.id ELSE 'virtual_' || c.id || '_' || ${root} || '_' || ${path} END`;
}

/**
 * Whether `key` is expanded. The request's ids are one JSON parameter, materialized once per statement into an
 * indexed list; the account's stored keys are probed through `expanded_nodes`' own `(short_key, system_to)` index.
 */
function isExpandedSql(expansion: ViewExpansion, key: SQL): SQL
{
	if (expansion.kind === "ids")
	{
		return sql`${key} IN (SELECT k FROM expanded)`;
	}
	return expansion.kind === "stored"
		? sql`EXISTS (SELECT 1 FROM expanded_nodes e WHERE e.short_key = ${key} AND e.system_to = ${LIVE})`
		: sql`0`;
}

/**
 * The parents whose lists the view sends: the root's list parent (its original when a mirror; null for Home, whose
 * children the caller matches by `parent_id IS NULL`) and every expanded row the walk reaches within the budget.
 *
 * The walk starts from one constant row standing for the root, always expanded, so the request's expansion set is
 * referenced (and indexed) once; that row takes one place in the `LIMIT`.
 */
function listParents({rootId, expansion, limit, showCompleted}: ViewTreeQuery): SQL
{
	const rootParent =
		rootId === null
			? sql`NULL`
			: sql`coalesce((SELECT mi.original_id FROM mirrors mi JOIN node_content rc ON rc.id = mi.mirror_id AND rc.system_to = ${LIVE} WHERE mi.mirror_id = ${rootId} AND mi.system_to = ${LIVE} LIMIT 1), ${rootId})`;
	const expandedIds =
		expansion.kind === "ids"
			? sql`expanded(k) AS MATERIALIZED (SELECT value FROM json_each(${JSON.stringify(expansion.ids)})),`
			: sql``;
	return sql`WITH RECURSIVE
		${expandedIds}
		walk(kids_parent, kids_root, kids_path, sortkey, expanded) AS (
			SELECT ${rootParent}, NULL, NULL, '', 1
			UNION ALL
			SELECT coalesce(o.original_id, c.id),
				coalesce(w.kids_root, CASE WHEN o.original_id IS NOT NULL THEN c.id END),
				CASE WHEN w.kids_root IS NOT NULL THEN w.kids_path || substr(c.id, 1, 4)
					WHEN o.original_id IS NOT NULL THEN substr(c.id, 1, 4) END,
				w.sortkey || ${SORT_SLICE},
				${isExpandedSql(expansion, expansionKey(expansion, sql`w.kids_root`, sql`w.kids_path`))}
			FROM walk w
			JOIN node_content c ON c.parent_id IS w.kids_parent AND c.system_to = ${LIVE}
			LEFT JOIN node_metadata m ON m.node_id = c.id AND m.system_to = ${LIVE}
			LEFT JOIN mirrors o ON o.mirror_id = c.id AND o.system_to = ${LIVE}
			WHERE w.expanded AND c.id NOT IN ${REFERENCES_ROOTS} AND c.id NOT IN ${IN_CHAT}${
				showCompleted ? sql`` : sql` AND (${WALK_COMPLETED}) IS NULL`
			}
			ORDER BY 4
			LIMIT ${limit + 1}
		)
		SELECT kids_parent FROM walk WHERE expanded`;
}

/** SQL for the effective completion of the node whose id is `id` (see `effectiveCompletedAt`). */
function completedOf(id: SQL): SQL
{
	return sql`CASE WHEN EXISTS (SELECT 1 FROM mirrors xm WHERE xm.mirror_id = ${id} AND xm.system_to = ${LIVE})
		THEN (SELECT xom.completed_at FROM mirrors xmi JOIN node_metadata xom ON xom.node_id = xmi.original_id AND xom.system_to = ${LIVE} WHERE xmi.mirror_id = ${id} AND xmi.system_to = ${LIVE} LIMIT 1)
		ELSE (SELECT xow.completed_at FROM node_metadata xow WHERE xow.node_id = ${id} AND xow.system_to = ${LIVE}) END`;
}

/**
 * The child flags of the row `id` (its original's children when a mirror), as `childFlags` counts them: current
 * children that are neither references roots nor `ai.inChat` items, plus a references root holding a backlink item
 * from a current source, which counts as uncompleted while that source is.
 */
function childFlagSql(id: SQL, uncompletedOnly: boolean): SQL
{
	const parent = sql`coalesce((SELECT fm.original_id FROM mirrors fm WHERE fm.mirror_id = ${id} AND fm.system_to = ${LIVE} LIMIT 1), ${id})`;
	return sql`(EXISTS (SELECT 1 FROM node_content k WHERE k.parent_id = ${parent} AND k.system_to = ${LIVE}
			AND k.id NOT IN ${REFERENCES_ROOTS} AND k.id NOT IN ${IN_CHAT}${
				uncompletedOnly ? sql` AND (${completedOf(sql`k.id`)}) IS NULL` : sql``
			})
		OR EXISTS (SELECT 1 FROM node_content r
			JOIN references_roots rr ON rr.node_id = r.id AND rr.system_to = ${LIVE}
			JOIN node_content i ON i.parent_id = r.id AND i.system_to = ${LIVE}
			JOIN mirrors bm ON bm.mirror_id = i.id AND bm.system_to = ${LIVE}
			JOIN node_content s ON s.id = bm.original_id AND s.system_to = ${LIVE}
			WHERE r.parent_id = ${parent} AND r.system_to = ${LIVE}${
				uncompletedOnly ? sql` AND (${completedOf(sql`s.id`)}) IS NULL` : sql``
			}))`;
}

/**
 * The current original's stored completion (Unix seconds) when `id` is a mirror, null when that original is not
 * cached. Raw: drizzle applies no column decoder to a relational read's extras.
 */
function originalCompletedAt(id: SQL): SQL<number | null>
{
	return sql<
		number | null
	>`(SELECT om.completed_at FROM mirrors mi JOIN node_content oc ON oc.id = mi.original_id AND oc.system_to = ${LIVE} JOIN node_metadata om ON om.node_id = oc.id AND om.system_to = ${LIVE} WHERE mi.mirror_id = ${id} AND mi.system_to = ${LIVE} LIMIT 1)`;
}

/**
 * Every list the view sends plus the root's own row, in one statement: the current children of each list parent
 * {@link listParents} names (Home's for a null root), shaped for the REST node.
 */
function selectViewRows(ctx: ServerContext, query: ViewTreeQuery)
{
	return ctx.db.query.nodeContent
		.findMany(
			{
				where: and(
					currentVersion(nodeContent),
					or(
						query.rootId === null ? isNull(nodeContent.parentId) : eq(nodeContent.id, query.rootId),
						sql`${nodeContent.parentId} IN (${listParents(query)})`,
					),
				),
				with:
				{
					metadata: true,
					mirrorsAsOriginal:
					{
						where: currentVersion(mirrors),
						columns:
						{
							mirrorId: true,
						},
					},
					mirrorsAsCopy:
					{
						where: currentVersion(mirrors),
						columns:
						{
							originalId: true,
						},
					},
					aiMetadata:
					{
						columns:
						{
							inChat: true,
						},
					},
					s3File: true,
					referencesRoot:
					{
						columns:
						{
							nodeId: true,
						},
					},
					calendar: true,
					displayMetadata: true,
					tableCellSizes:
					{
						where: currentVersion(nodeTableCellSizes),
						columns:
						{
							cellId: true,
							size: true,
						},
					},
				},
				extras:
				{
					originalName: mirrorOriginalText(relationalRowId, "name").as("original_name"),
					originalNote: mirrorOriginalText(relationalRowId, "note").as("original_note"),
					originalCompletedAt: originalCompletedAt(relationalRowId).as("original_completed_at"),
					hasChildren: childFlagSql(relationalRowId, false).as("has_children"),
					hasUncompletedChildren: childFlagSql(relationalRowId, true).as("has_uncompleted_children"),
				},
			},
		)
		.sync();
}

type ViewRow = ReturnType<typeof selectViewRows>[number];

/**
 * Drizzle types a `one()` relation on non-null columns as always present, but a node can lack the current related
 * row, so the relation is really nullable.
 */
function nullable<T>(value: T): T | null
{
	return value;
}

/** The row as the canonical node: a mirror takes its original's id, text and completion. */
function nodeOf(row: ViewRow): Node
{
	const originalId = row.mirrorsAsCopy[0]?.originalId ?? null;
	const metadata = nullable(row.metadata);
	return {
		id: row.id,
		shortId: metadata?.shortId ?? null,
		parentId: row.parentId,
		name: originalId === null ? row.name : row.originalName,
		note: originalId === null ? row.note : row.originalNote,
		priority: metadata?.priority ?? 0,
		layoutMode: metadata?.layoutMode ?? null,
		createdAt: metadata?.createdAt ?? null,
		modifiedAt: metadata?.modifiedAt ?? null,
		completedAt:
			originalId === null
				? (metadata?.completedAt ?? null)
				: row.originalCompletedAt === null
					? null
					: new Date(row.originalCompletedAt * 1000),
		collapsed: false,
		mirror:
		{
			isMirror: originalId !== null,
			originalNodeId: originalId,
		},
		systemFrom: row.systemFrom,
		systemTo: row.systemTo,
	};
}

function attachmentOf(row: ViewRow): NodeAttachment | null
{
	const file = nullable(row.s3File);
	return file === null
		? null
		:
			{
				fileName: file.fileName,
				fileType: file.fileType,
				objectFolder: file.objectFolder,
				imageOriginalWidth: file.imageOriginalWidth,
				imageOriginalHeight: file.imageOriginalHeight,
				imageOriginalPixels: file.imageOriginalPixels,
				isAnimatedGif: file.isAnimatedGif === 1,
				isDeleted: file.isDeleted === 1,
			};
}

/** Siblings by priority, then creation time (missing metadata as 0), then id: the walk's order. */
function compareSiblings(a: Node, b: Node): number
{
	if (a.priority !== b.priority)
	{
		return a.priority - b.priority;
	}
	const createdA = a.createdAt?.getTime() ?? 0;
	const createdB = b.createdAt?.getTime() ?? 0;
	if (createdA !== createdB)
	{
		return createdA - createdB;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The view's tree as read by {@link readViewTree}. */
export interface ViewTree
{
	/** The root's own node, or undefined for Home or an uncached root. */
	root: Node | undefined;
	/** The root's calendar role, when it has one. */
	rootCalendar: CalendarInfo | undefined;
	/** The node whose children the root lists: its original when a mirror; null for Home. */
	rootListParent: string | null;
	/** Each list parent's children as REST nodes, in sibling order; a parent the view did not read has none. */
	childrenOf: (parentId: string | null) => NodeResponse[];
	/** The current references root under each list parent that has one. */
	referencesRootOf: ReadonlyMap<string, string>;
}

/**
 * Read the view's tree in one statement (see the module comment). The rows' calendar roles need one more lookup
 * only when a row's name is a date and the account's calendar metadata is not cached.
 */
export function readViewTree(ctx: ServerContext, query: ViewTreeQuery): ViewTree
{
	const rows = selectViewRows(ctx, query);
	const rootRow = query.rootId === null ? undefined : rows.find((row) => row.id === query.rootId);
	const byParent = new Map<
		string | null,
		{
			row: ViewRow;
			node: Node;
		}[]
	>();
	const referencesRootOf = new Map<string, string>();
	// The root row is read for its own fields and lands in its parent's group too, which only a view that also read
	// that parent's whole list ever asks for.
	for (const row of rows)
	{
		if (nullable(row.referencesRoot) !== null)
		{
			if (row.parentId !== null && !referencesRootOf.has(row.parentId))
			{
				referencesRootOf.set(row.parentId, row.id);
			}
			continue;
		}
		if ((nullable(row.aiMetadata)?.inChat ?? 0) !== 0)
		{
			continue;
		}
		const siblings = byParent.get(row.parentId) ?? [];
		siblings.push(
			{
				row,
				node: nodeOf(row),
			},
		);
		byParent.set(row.parentId, siblings);
	}
	const root = rootRow === undefined ? undefined : nodeOf(rootRow);
	const calendar = new Map<string, CalendarInfo>();
	const shaped = [...byParent.values()].flat();
	const all =
		rootRow === undefined || root === undefined || shaped.some(({row}) => row === rootRow)
			? shaped
			: [
					...shaped,
					{
						row: rootRow,
						node: root,
					},
				];
	for (const {row} of all)
	{
		const stored = nullable(row.calendar);
		if (stored !== null)
		{
			calendar.set(row.id, calendarInfoOfRow(stored, nullable(row.displayMetadata)?.restorableUniqueNode === 1));
		}
	}
	addNamedCalendarDays(
		{
			db: ctx.db,
			cache: ctx.cacheService,
		},
		all.map(({node}) => node),
		calendar,
	);
	const lists = new Map<string | null, NodeResponse[]>();
	for (const [parentId, siblings] of byParent)
	{
		lists.set(
			parentId,
			siblings
				.toSorted((a, b) => compareSiblings(a.node, b.node))
				.map(({row, node}) =>
					nodeToRestDto(
						node,
						{
							hasMirrors: !node.mirror.isMirror && row.mirrorsAsOriginal.length > 0,
							hasChildren: Boolean(row.hasChildren),
							hasUncompletedChildren: Boolean(row.hasUncompletedChildren),
							name: node.name,
							note: node.note,
							attachment: attachmentOf(row),
							metadata: displayMetadataFields(nullable(row.displayMetadata), row.tableCellSizes),
							calendar: calendar.get(row.id),
						},
					),
				),
		);
	}
	return {
		root,
		rootCalendar: root === undefined ? undefined : calendar.get(root.id),
		rootListParent: query.rootId === null ? null : (root?.mirror.originalNodeId ?? query.rootId),
		childrenOf: (parentId) => lists.get(parentId) ?? [],
		referencesRootOf,
	};
}

/** The parents whose lists the view sends (see {@link listParents}), as a parenthesized subquery for an `IN`. */
export function viewListParents(query: ViewTreeQuery): SQL
{
	return sql`(${listParents(query)})`;
}

/** The source of the backlink item `id`: its current mirror row's original. */
function backlinkSource(id: SQL): SQL<string | null>
{
	return sql<
		string | null
	>`(SELECT bs.original_id FROM mirrors bs WHERE bs.mirror_id = ${id} AND bs.system_to = ${LIVE} LIMIT 1)`;
}

/**
 * The ancestors of the node `id` (not itself), as one JSON array of `{id, name, depth, backlinks}`: a current
 * ancestor chain walked up `parent_id` whatever its depth, stopping at a missing parent or a cycle. `name` is a
 * mirror's original's; `backlinks` is a references root's backlink item count (null for any other node), counting
 * only items whose source is current.
 */
function ancestorCrumbsSql(id: SQL): SQL<string>
{
	const name = sql`CASE WHEN EXISTS (SELECT 1 FROM mirrors am WHERE am.mirror_id = a.id AND am.system_to = ${LIVE}) THEN ${mirrorOriginalText(sql`a.id`, "name")} ELSE a.name END`;
	return sql<string>`(WITH RECURSIVE up(id, parent_id, name, depth, seen) AS (
			SELECT a.id, a.parent_id, a.name, 0, '/' || a.id || '/' FROM node_content a WHERE a.id = ${id} AND a.system_to = ${LIVE}
			UNION ALL
			SELECT a.id, a.parent_id, ${name}, up.depth + 1, up.seen || a.id || '/'
			FROM up JOIN node_content a ON a.id = up.parent_id AND a.system_to = ${LIVE}
			WHERE instr(up.seen, '/' || a.id || '/') = 0
		)
		SELECT json_group_array(json_object('id', up.id, 'name', up.name, 'depth', up.depth, 'backlinks',
			CASE WHEN up.id IN ${REFERENCES_ROOTS} THEN (SELECT count(*) FROM node_content ci
				JOIN mirrors cm ON cm.mirror_id = ci.id AND cm.system_to = ${LIVE}
				JOIN node_content co ON co.id = cm.original_id AND co.system_to = ${LIVE}
				WHERE ci.parent_id = up.id AND ci.system_to = ${LIVE}) END))
		FROM up WHERE up.depth > 0)`;
}

/**
 * The backlink items under the references roots of `targets` (a parenthesized subquery or list of node ids), in one
 * statement: each current item whose source is current, shaped with its source's text, completion, child flags and
 * ancestor crumbs through correlated subqueries.
 */
function selectBacklinkItems(ctx: ServerContext, targets: SQL)
{
	const source = backlinkSource(relationalRowId);
	return ctx.db.query.nodeContent
		.findMany(
			{
				where: and(
					currentVersion(nodeContent),
					sql`${nodeContent.parentId} IN (SELECT r.id FROM node_content r WHERE r.parent_id IN ${targets} AND r.system_to = ${LIVE} AND r.id IN ${REFERENCES_ROOTS})`,
					sql`EXISTS (SELECT 1 FROM mirrors im JOIN node_content s ON s.id = im.original_id AND s.system_to = ${LIVE} WHERE im.mirror_id = ${relationalRowId} AND im.system_to = ${LIVE})`,
				),
				with:
				{
					metadata: true,
				},
				extras:
				{
					sourceId: source.as("source_id"),
					sourceName: mirrorOriginalText(relationalRowId, "name").as("source_name"),
					sourceNote: mirrorOriginalText(relationalRowId, "note").as("source_note"),
					sourceCompletedAt: originalCompletedAt(relationalRowId).as("source_completed_at"),
					sourceHasChildren: childFlagSql(source, false).as("source_has_children"),
					sourceHasUncompletedChildren: childFlagSql(source, true).as("source_has_uncompleted_children"),
					crumbs: ancestorCrumbsSql(source).as("crumbs"),
				},
			},
		)
		.sync();
}

/** The JSON array {@link ancestorCrumbsSql} returns. */
const CrumbRowsSchema = z.array(
	z.object(
		{
			id: z.string(),
			name: z.string().nullable(),
			depth: z.number(),
			backlinks: z.number().nullable(),
		},
	),
);

/**
 * The Backlinks items of every references root under `targets` (see {@link selectBacklinkItems}), keyed by the
 * references root, in sibling order. Each item is a mirror row of its source: the source's text, completion and child
 * flags, with the source's ancestors from the top down as crumbs (a references root shown by its label).
 */
export function readBacklinkItems(ctx: ServerContext, targets: SQL): Map<string, BacklinkItem[]>
{
	const byRoot = new Map<
		string,
		{
			node: Node;
			item: BacklinkItem;
		}[]
	>();
	for (const row of selectBacklinkItems(ctx, targets))
	{
		const {sourceId, parentId} = row;
		if (sourceId === null || parentId === null)
		{
			continue;
		}
		const metadata = nullable(row.metadata);
		const node: Node =
		{
			id: row.id,
			shortId: metadata?.shortId ?? null,
			parentId,
			name: row.sourceName,
			note: row.sourceNote,
			priority: metadata?.priority ?? 0,
			layoutMode: metadata?.layoutMode ?? null,
			createdAt: metadata?.createdAt ?? null,
			modifiedAt: metadata?.modifiedAt ?? null,
			completedAt: row.sourceCompletedAt === null ? null : new Date(row.sourceCompletedAt * 1000),
			collapsed: false,
			mirror:
			{
				isMirror: true,
				originalNodeId: sourceId,
			},
			systemFrom: row.systemFrom,
			systemTo: row.systemTo,
		};
		const crumbs = CrumbRowsSchema.parse(JSON.parse(row.crumbs))
			.toSorted((a, b) => b.depth - a.depth)
			.map((crumb) => (
			{
				id: crumb.id,
				name: crumb.backlinks === null ? (crumb.name ?? "") : backlinksLabel(crumb.backlinks),
			}));
		const items = byRoot.get(parentId) ?? [];
		items.push(
			{
				node,
				item:
				{
					node: nodeToRestDto(
						node,
						{
							hasChildren: Boolean(row.sourceHasChildren),
							hasUncompletedChildren: Boolean(row.sourceHasUncompletedChildren),
							name: node.name,
							note: node.note,
						},
					),
					sourceId,
					crumbs,
				},
			},
		);
		byRoot.set(parentId, items);
	}
	return new Map(
		[...byRoot].map(([rootId, items]) => [
			rootId,
			items.toSorted((a, b) => compareSiblings(a.node, b.node)).map(({item}) => item),
		]),
	);
}
