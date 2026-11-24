import {and, desc, eq, gte, lte, ne, sql} from "drizzle-orm";
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
	private classified(cutoff: number)
	{
		const db = this.db;
		// Plain columns only: Drizzle names a CTE's aliased field without its CTE, which is ambiguous across the joins.
		const content = () =>
			db
				.select(
					{
						id: nodeContent.id,
						parentId: nodeContent.parentId,
						name: nodeContent.name,
						note: nodeContent.note,
						systemFrom: nodeContent.systemFrom,
						systemTo: nodeContent.systemTo,
					},
				)
				.from(nodeContent);
		const meta = () =>
			db
				.select(
					{
						nodeId: nodeMetadata.nodeId,
						completedAt: nodeMetadata.completedAt,
						systemFrom: nodeMetadata.systemFrom,
						systemTo: nodeMetadata.systemTo,
					},
				)
				.from(nodeMetadata);
		const oldContent = db.$with("old_content").as(content().where(this.closedAtCutoff(nodeContent, cutoff)));
		const newContent = db.$with("new_content").as(content().where(this.liveSinceCutoff(nodeContent, cutoff)));
		const oldMeta = db.$with("old_meta").as(meta().where(this.closedAtCutoff(nodeMetadata, cutoff)));
		const newMeta = db.$with("new_meta").as(meta().where(this.liveSinceCutoff(nodeMetadata, cutoff)));
		const mirrorIds = db.$with("mirror_ids").as(
			db
				.selectDistinct(
					{
						mirrorId: mirrors.mirrorId,
					},
				)
				.from(mirrors)
				.where(gte(mirrors.systemTo, cutoff)),
		);
		const ids = db.$with("ids").as(
			db
				.select(
					{
						id: oldContent.id,
					},
				)
				.from(oldContent)
				.union(
					db
						.select(
							{
								id: newContent.id,
							},
						)
						.from(newContent),
				)
				.union(
					db
						.select(
							{
								id: oldMeta.nodeId,
							},
						)
						.from(oldMeta),
				)
				.union(
					db
						.select(
							{
								id: newMeta.nodeId,
							},
						)
						.from(newMeta),
				),
		);
		const bothContent = sql`${oldContent.id} IS NOT NULL AND ${newContent.id} IS NOT NULL`;
		const compared = db.$with("compared").as(
			db
				.select(
					{
						id: ids.id,
						isNew: sql<number>`${oldContent.id} IS NULL AND ${oldMeta.nodeId} IS NULL`.as("is_new"),
						isDeleted: sql<number>`${newContent.id} IS NULL AND ${newMeta.nodeId} IS NULL`.as("is_deleted"),
						hasOldContent: sql<number>`${oldContent.id} IS NOT NULL`.as("has_old_content"),
						nameChanged: sql<number>`${bothContent} AND ${mirrorIds.mirrorId} IS NULL
							AND ${oldContent.name} IS NOT ${newContent.name}`.as("name_changed"),
						noteChanged: sql<number>`${bothContent} AND ${mirrorIds.mirrorId} IS NULL
							AND ${oldContent.note} IS NOT ${newContent.note}`.as("note_changed"),
						parentChanged: sql<number>`${bothContent}
							AND ${oldContent.parentId} IS NOT ${newContent.parentId}`.as("parent_changed"),
						completionChanged: sql<number>`${oldMeta.nodeId} IS NOT NULL AND ${newMeta.nodeId} IS NOT NULL
							AND (${oldMeta.completedAt} IS NULL) <> (${newMeta.completedAt} IS NULL)`.as(
							"completion_changed",
						),
						nowCompleted: sql<number>`${newMeta.completedAt} IS NOT NULL`.as("now_completed"),
						oldParentId: sql<string | null>`${oldContent.parentId}`.as("old_parent_id"),
						at: sql<number>`max(
							coalesce(${oldContent.systemTo}, 0), coalesce(${newContent.systemFrom}, 0),
							coalesce(${oldMeta.systemTo}, 0), coalesce(${newMeta.systemFrom}, 0)
						)`.as("at"),
					},
				)
				.from(ids)
				.leftJoin(oldContent, eq(oldContent.id, ids.id))
				.leftJoin(newContent, eq(newContent.id, ids.id))
				.leftJoin(oldMeta, eq(oldMeta.nodeId, ids.id))
				.leftJoin(newMeta, eq(newMeta.nodeId, ids.id))
				.leftJoin(mirrorIds, eq(mirrorIds.mirrorId, ids.id)),
		);
		return db
			.with(oldContent, newContent, oldMeta, newMeta, mirrorIds, ids, compared)
			.select()
			.from(compared)
			.where(
				sql`${compared.isNew} OR ${compared.isDeleted} OR ${compared.nameChanged} OR ${compared.noteChanged}
					OR ${compared.parentChanged} OR ${compared.completionChanged}`,
			)
			.as("classified");
	}

	private summarize(classified: ReturnType<ChangeDetector["classified"]>): ChangeSummary &
	{
		total: number;
	}
	{
		const notNewOrDeleted = sql`NOT ${classified.isNew} AND NOT ${classified.isDeleted}`;
		const row = this.db
			.select(
				{
					total: sql<number>`count(*)`,
					added: sql<number | null>`sum(${classified.isNew})`,
					deleted: sql<number | null>`sum(${classified.isDeleted})`,
					changed: sql<
						number | null
					>`sum(${notNewOrDeleted} AND (${classified.nameChanged} OR ${classified.noteChanged}))`,
					moved: sql<number | null>`sum(${notNewOrDeleted} AND ${classified.parentChanged})`,
					completed: sql<
						number | null
					>`sum(${notNewOrDeleted} AND ${classified.completionChanged} AND ${classified.nowCompleted})`,
					uncompleted: sql<
						number | null
					>`sum(${notNewOrDeleted} AND ${classified.completionChanged} AND NOT ${classified.nowCompleted})`,
				},
			)
			.from(classified)
			.get();
		return {
			added: row?.added ?? 0,
			deleted: row?.deleted ?? 0,
			changed: row?.changed ?? 0,
			moved: row?.moved ?? 0,
			completed: row?.completed ?? 0,
			uncompleted: row?.uncompleted ?? 0,
			total: row?.total ?? 0,
		};
	}

	/** The newest `limit` changes (all of them without one), ties by id. */
	private list(classified: ReturnType<ChangeDetector["classified"]>, limit: number | undefined): Classified[]
	{
		const newestFirst = this.db.select().from(classified).orderBy(desc(classified.at), classified.id);
		const rows = (limit === undefined ? newestFirst : newestFirst.limit(limit)).all();
		return rows.map((row) => (
		{
			id: row.id,
			isNew: row.isNew === 1,
			isDeleted: row.isDeleted === 1,
			hasOldContent: row.hasOldContent === 1,
			nameChanged: row.nameChanged === 1,
			noteChanged: row.noteChanged === 1,
			parentChanged: row.parentChanged === 1,
			completionChanged: row.completionChanged === 1,
			oldParentId: row.oldParentId,
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
