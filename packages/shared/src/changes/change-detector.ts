import {and, eq, gte, lte, ne, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {inIds} from "../cache/in-ids.js";
import {mirrors, nodeContent, nodeMetadata} from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "../temporal/constants.js";

export interface NodeChange
{
	id: string;
	isNew: boolean;
	isDeleted: boolean;
	contentChanged: boolean;
	parentChanged: boolean;
	completionChanged: boolean;
	noteChanged: boolean;
	oldName: string | null;
	oldNote: string | null;
	oldParentId: string | null;
	oldCompletedAt: Date | null;
	currentName: string | null;
	currentNote: string | null;
	currentParentId: string | null;
	currentCompletedAt: Date | null;
	parentId: string | null;
}

export interface ChangeTreeNode
{
	id: string;
	name: string | null;
	isContext: boolean;
	change: NodeChange | null;
	children: ChangeTreeNode[];
}

export interface ChangeSummary
{
	added: number;
	deleted: number;
	changed: number;
	moved: number;
	completed: number;
	uncompleted: number;
}

export interface ChangeDetectionResult
{
	changes: NodeChange[];
	tree: ChangeTreeNode[];
	summary: ChangeSummary;
	/** Whether `changes` (and `tree`) leave out older changes that `summary` still counts. */
	truncated: boolean;
	cutoffDate: Date;
}

interface Text
{
	name: string | null;
	note: string | null;
}

const NO_TEXT: Text =
{
	name: null,
	note: null,
};

/** `row` with its name and note replaced by `text`, when given. */
function withText<T extends Text>(row: T | undefined, text: Text | undefined): T | undefined
{
	return row === undefined || text === undefined
		? row
		:
			{
				...row,
				name: text.name,
				note: text.note,
			};
}

export function getChangeLabels(change: NodeChange): string[]
{
	const labels: string[] = [];

	if (change.isNew)
	{
		labels.push("Added");
		return labels;
	}

	if (change.isDeleted)
	{
		labels.push("Deleted");
		return labels;
	}

	if (change.completionChanged)
	{
		labels.push(change.currentCompletedAt ? "Completed" : "Uncompleted");
	}

	if (change.contentChanged && change.parentChanged)
	{
		labels.push("Changed and moved");
	}
	else if (change.contentChanged)
	{
		labels.push("Changed");
	}
	else if (change.parentChanged)
	{
		labels.push("Moved");
	}

	if (change.noteChanged && !change.contentChanged)
	{
		labels.push("Note edited");
	}

	return labels;
}

/** One node's change as SQL classifies it; text and completion dates are loaded only for the changes listed. */
interface Classified
{
	id: string;
	isNew: boolean;
	isDeleted: boolean;
	hasOldContent: boolean;
	nameChanged: boolean;
	noteChanged: boolean;
	parentChanged: boolean;
	completionChanged: boolean;
	oldParentId: string | null;
}

interface TextRow
{
	id: string;
	name: string | null;
	note: string | null;
	parentId: string | null;
}

export interface DetectChangesOptions
{
	/** List at most this many changes, newest first; the summary still counts them all. */
	limit?: number;
}

export class ChangeDetector
{
	constructor(private readonly db: AppDatabase)
	{
	}

	/**
	 * Changes since `cutoffDate`, newest first. SQL classifies and counts every
	 * change, and only the listed ones reach JavaScript with their text, so a
	 * window covering a whole seed (every node "added") stays within a Durable
	 * Object's 128 MB of memory and its 2 MB cap on one bound string.
	 */
	detectChanges(cutoffDate: Date, options: DetectChangesOptions = {}): ChangeDetectionResult
	{
		const cutoff = formatTemporalTimestamp(cutoffDate);
		const classified = this.classified(cutoff);

		const {total, ...summary} = this.summarize(classified);
		const listed = this.list(classified, options.limit);
		const changes = this.hydrate(listed, cutoff);

		return {
			changes,
			tree: this.buildChangeTree(changes),
			summary,
			truncated: listed.length < total,
			cutoffDate,
		};
	}

	/**
	 * A query over every node changed since the cutoff, one row each, compared
	 * across the version live at the cutoff (since closed) and the live one
	 * (begun since). A node that was a mirror at any point since the cutoff has
	 * no text of its own, so stale text stored on it never counts as an edit.
	 */
	private classified(cutoff: number): SQL
	{
		const far = FAR_FUTURE_DATE;
		return sql`
			WITH
				old_content AS (
					SELECT id, parent_id, name, note, system_to AS at FROM node_content
					WHERE system_from <= ${cutoff} AND system_to >= ${cutoff} AND system_to <> ${far}
				),
				new_content AS (
					SELECT id, parent_id, name, note, system_from AS at FROM node_content
					WHERE system_from >= ${cutoff} AND system_to = ${far}
				),
				old_meta AS (
					SELECT node_id AS id, completed_at, system_to AS at FROM node_metadata
					WHERE system_from <= ${cutoff} AND system_to >= ${cutoff} AND system_to <> ${far}
				),
				new_meta AS (
					SELECT node_id AS id, completed_at, system_from AS at FROM node_metadata
					WHERE system_from >= ${cutoff} AND system_to = ${far}
				),
				mirror_ids AS (
					SELECT DISTINCT mirror_id AS id FROM mirrors WHERE system_to >= ${cutoff}
				),
				ids AS (
					SELECT id FROM old_content UNION SELECT id FROM new_content
					UNION SELECT id FROM old_meta UNION SELECT id FROM new_meta
				),
				compared AS (
					SELECT
						ids.id AS id,
						old_content.id IS NULL AND old_meta.id IS NULL AS is_new,
						new_content.id IS NULL AND new_meta.id IS NULL AS is_deleted,
						old_content.id IS NOT NULL AS has_old_content,
						old_content.id IS NOT NULL AND new_content.id IS NOT NULL AND mirror_ids.id IS NULL
							AND old_content.name IS NOT new_content.name AS name_changed,
						old_content.id IS NOT NULL AND new_content.id IS NOT NULL AND mirror_ids.id IS NULL
							AND old_content.note IS NOT new_content.note AS note_changed,
						old_content.id IS NOT NULL AND new_content.id IS NOT NULL
							AND old_content.parent_id IS NOT new_content.parent_id AS parent_changed,
						old_meta.id IS NOT NULL AND new_meta.id IS NOT NULL
							AND (old_meta.completed_at IS NULL) <> (new_meta.completed_at IS NULL) AS completion_changed,
						new_meta.completed_at IS NOT NULL AS now_completed,
						old_content.parent_id AS old_parent_id,
						max(
							coalesce(old_content.at, 0), coalesce(new_content.at, 0),
							coalesce(old_meta.at, 0), coalesce(new_meta.at, 0)
						) AS at
					FROM ids
					LEFT JOIN old_content ON old_content.id = ids.id
					LEFT JOIN new_content ON new_content.id = ids.id
					LEFT JOIN old_meta ON old_meta.id = ids.id
					LEFT JOIN new_meta ON new_meta.id = ids.id
					LEFT JOIN mirror_ids ON mirror_ids.id = ids.id
				)
			SELECT * FROM compared
			WHERE is_new OR is_deleted OR name_changed OR note_changed OR parent_changed OR completion_changed
		`;
	}

	private summarize(classified: SQL): ChangeSummary &
	{
		total: number;
	}
	{
		const row = this.db.get<Record<string, number | null>>(
			sql`
				SELECT
					count(*) AS total,
					sum(is_new) AS added,
					sum(is_deleted) AS deleted,
					sum(NOT is_new AND NOT is_deleted AND (name_changed OR note_changed)) AS changed,
					sum(NOT is_new AND NOT is_deleted AND parent_changed) AS moved,
					sum(NOT is_new AND NOT is_deleted AND completion_changed AND now_completed) AS completed,
					sum(NOT is_new AND NOT is_deleted AND completion_changed AND NOT now_completed) AS uncompleted
				FROM (${classified})
			`,
		);
		return {
			added: row.added ?? 0,
			deleted: row.deleted ?? 0,
			changed: row.changed ?? 0,
			moved: row.moved ?? 0,
			completed: row.completed ?? 0,
			uncompleted: row.uncompleted ?? 0,
			total: row.total ?? 0,
		};
	}

	/** The newest `limit` changes (all of them without one), ties by id. */
	private list(classified: SQL, limit: number | undefined): Classified[]
	{
		const rows = this.db.all<
		{
			id: string;
			is_new: number;
			is_deleted: number;
			has_old_content: number;
			name_changed: number;
			note_changed: number;
			parent_changed: number;
			completion_changed: number;
			old_parent_id: string | null;
		}>(sql`SELECT * FROM (${classified}) ORDER BY at DESC, id LIMIT ${limit ?? -1}`);
		return rows.map((row) => (
		{
			id: row.id,
			isNew: row.is_new === 1,
			isDeleted: row.is_deleted === 1,
			hasOldContent: row.has_old_content === 1,
			nameChanged: row.name_changed === 1,
			noteChanged: row.note_changed === 1,
			parentChanged: row.parent_changed === 1,
			completionChanged: row.completion_changed === 1,
			oldParentId: row.old_parent_id,
		}));
	}

	/** The version that was live at the cutoff and has since closed. */
	private closedAtCutoff(table: typeof nodeContent | typeof nodeMetadata, cutoff: number)
	{
		return and(lte(table.systemFrom, cutoff), gte(table.systemTo, cutoff), ne(table.systemTo, FAR_FUTURE_DATE));
	}

	/** The live version, when it began after the cutoff. */
	private liveSinceCutoff(table: typeof nodeContent | typeof nodeMetadata, cutoff: number)
	{
		return and(gte(table.systemFrom, cutoff), eq(table.systemTo, FAR_FUTURE_DATE));
	}

	/** The completion dates of `ids` before (closed at the cutoff) and now (begun since). */
	private queryCompletions(ids: string[], cutoff: number)
	{
		const read = (version: SQL | undefined) =>
			new Map(
				this.db
					.select(
						{
							nodeId: nodeMetadata.nodeId,
							completedAt: nodeMetadata.completedAt,
						},
					)
					.from(nodeMetadata)
					.where(and(inIds(nodeMetadata.nodeId, ids), version))
					.all()
					.map((row) => [row.nodeId, row.completedAt]),
			);
		return {
			old: read(this.closedAtCutoff(nodeMetadata, cutoff)),
			current: read(this.liveSinceCutoff(nodeMetadata, cutoff)),
		};
	}

	/** Load the text of the listed changes (a mirror's from its original) and build their full records. */
	private hydrate(listed: Classified[], cutoff: number): NodeChange[]
	{
		const ids = listed.map((change) => change.id);
		const mirrorOriginals = this.loadMirrorOriginals(ids, cutoff);
		const textIds = [...new Set([...ids, ...mirrorOriginals.values()])];
		const oldText = this.queryText(textIds, this.closedAtCutoff(nodeContent, cutoff));
		const liveText = this.queryText(textIds, eq(nodeContent.systemTo, FAR_FUTURE_DATE));
		const completions = this.queryCompletions(ids, cutoff);

		return listed.map((change) =>
		{
			// A mirror has no text of its own: it is labelled with its original's text.
			const originalId = mirrorOriginals.get(change.id);
			const currentOriginal = originalId === undefined ? undefined : (liveText.get(originalId) ?? NO_TEXT);
			const oldOriginal = originalId === undefined ? undefined : (oldText.get(originalId) ?? currentOriginal);
			const oldC = change.hasOldContent ? withText(oldText.get(change.id), oldOriginal) : undefined;
			const current = change.isDeleted ? undefined : withText(liveText.get(change.id), currentOriginal);
			const currentParentId = current?.parentId ?? null;

			return {
				id: change.id,
				isNew: change.isNew,
				isDeleted: change.isDeleted,
				contentChanged: change.nameChanged,
				parentChanged: change.parentChanged,
				completionChanged: change.completionChanged,
				noteChanged: change.noteChanged,
				oldName: oldC?.name ?? null,
				oldNote: oldC?.note ?? null,
				oldParentId: change.oldParentId,
				oldCompletedAt: completions.old.get(change.id) ?? null,
				currentName: current?.name ?? null,
				currentNote: current?.note ?? null,
				currentParentId,
				currentCompletedAt: completions.current.get(change.id) ?? null,
				parentId: change.isDeleted ? change.oldParentId : currentParentId,
			};
		});
	}

	private queryText(ids: string[], version: SQL | undefined): Map<string, TextRow>
	{
		const rows = this.db
			.select(
				{
					id: nodeContent.id,
					name: nodeContent.name,
					note: nodeContent.note,
					parentId: nodeContent.parentId,
				},
			)
			.from(nodeContent)
			.where(and(inIds(nodeContent.id, ids), version))
			.all();
		return new Map(rows.map((row) => [row.id, row]));
	}

	/**
	 * Map each of `nodeIds` that was a mirror at any point since the cutoff to
	 * its original's id, preferring the current relationship.
	 */
	private loadMirrorOriginals(nodeIds: string[], cutoff: number): Map<string, string>
	{
		const rows = this.db
			.select(
				{
					mirrorId: mirrors.mirrorId,
					originalId: mirrors.originalId,
				},
			)
			.from(mirrors)
			.where(and(inIds(mirrors.mirrorId, nodeIds), gte(mirrors.systemTo, cutoff)))
			.orderBy(mirrors.systemTo)
			.all();
		const originals = new Map<string, string>();
		for (const row of rows)
		{
			originals.set(row.mirrorId, row.originalId);
		}
		return originals;
	}

	buildChangeTree(changes: NodeChange[]): ChangeTreeNode[]
	{
		const changeMap = new Map(changes.map((c) => [c.id, c]));

		const nodeInfoMap = new Map<
			string,
			{
				name: string | null;
				parentId: string | null;
			}
		>();

		for (const change of changes)
		{
			nodeInfoMap.set(
				change.id,
				{
					name: change.isDeleted ? change.oldName : change.currentName,
					parentId: change.parentId,
				},
			);
		}

		const parentIds = new Set<string>();
		for (const change of changes)
		{
			if (change.parentId)
			{
				parentIds.add(change.parentId);
			}
		}

		let currentIds = [...parentIds].filter((id) => !nodeInfoMap.has(id));

		while (currentIds.length > 0)
		{
			const nextIds: string[] = [];

			const results = this.db
				.select(
					{
						id: nodeContent.id,
						name: nodeContent.name,
						parentId: nodeContent.parentId,
					},
				)
				.from(nodeContent)
				.where(and(inIds(nodeContent.id, currentIds), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
				.all();

			for (const row of results)
			{
				if (!nodeInfoMap.has(row.id))
				{
					nodeInfoMap.set(
						row.id,
						{
							name: row.name,
							parentId: row.parentId,
						},
					);
					if (row.parentId && !nodeInfoMap.has(row.parentId))
					{
						nextIds.push(row.parentId);
					}
				}
			}

			currentIds = [...new Set(nextIds)];
		}

		const childrenMap = new Map<string | null, string[]>();
		for (const [id, info] of nodeInfoMap)
		{
			const pid = info.parentId;
			let siblings = childrenMap.get(pid);
			if (siblings === undefined)
			{
				siblings = [];
				childrenMap.set(pid, siblings);
			}
			siblings.push(id);
		}

		const buildNode = (id: string): ChangeTreeNode | null =>
		{
			const info = nodeInfoMap.get(id);
			if (!info)
			{
				return null;
			}

			const childIds = childrenMap.get(id) ?? [];
			const children = childIds
				.map((childId) => buildNode(childId))
				.filter((n): n is ChangeTreeNode => n !== null);

			const change = changeMap.get(id) ?? null;
			const isContext = change === null;

			if (isContext && children.length === 0)
			{
				return null;
			}

			return {
				id,
				name: info.name,
				isContext,
				change,
				children,
			};
		};

		const rootChildIds = childrenMap.get(null) ?? [];
		return rootChildIds.map((childId) => buildNode(childId)).filter((n): n is ChangeTreeNode => n !== null);
	}
}
