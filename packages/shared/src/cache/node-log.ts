/**
 * Replays the node ops of `/push_and_poll` transaction logs onto `node_content` and `node_metadata`, so a change made
 * by another client lands in the cache (and so in the nodes change feed) without a tree read:
 * - `move` and `bulk_move` set parents and sibling order. Upstream's index semantics (internal-api.md): a `move`'s
 *   `priority` is the slot after the node leaves its old place, and a `bulk_move`'s is the count of non-moved siblings
 *   before the block.
 * - `edit` sets the name and note (`description`) when it carries them.
 * - `bulk_create` inserts its `project_trees` at `starting_priority`, children included.
 * - `complete` and `uncomplete` set and clear `completedAt`.
 * - `delete` ends the node's whole subtree, composites included.
 * - `undelete` brings the node back with its subtree as it was just before its delete, composites and mirror rows
 *   included, at `parentid` and `priority`. A node deleted earlier in the same batch comes back as the batch left it.
 * - Every other client's `edit` (metadata-only included), `complete` and `uncomplete` stamps the node's `modifiedAt`
 *   with the op's time, its `move` and `bulk_move` stamp each moved node and the destination parent, and its
 *   `undelete` stamps every restored node and keeps its `createdAt`, as workflowy.com does (.llm/plans/2026-11-10-write-timestamps-audit.md). A stamp never moves `modifiedAt` back.
 *
 * Moves replay for every transaction. The content ops replay only for other clients' transactions: our own creates,
 * edits, completes and deletes are written through when they are pushed, so replaying them as well would version
 * those rows twice.
 *
 * The ops are applied in order to an in-memory model of the touched nodes and parents' child lists, and each changed
 * row is versioned once at the end, so several ops on one node in a batch never write a node twice in one unit of
 * work. An op on a node missing from the cache is skipped, and so is a `bulk_create` under a parent missing from it:
 * the log never carries enough to place them.
 *
 * Mirror mode's pending outbox rows win over the log, field by field: a move of a node whose placement is pending, and
 * an edit, complete or uncomplete of a field whose aspect is pending, are dropped, so the next drain sends ours. A node
 * with a pending create is ours alone. An undelete of a node whose delete is pending is dropped, and so is one under a
 * parent missing from the cache. A delete still wins: the node's subtree ends, every pending row of it closes,
 * and the replay reports the nodes that had pending edits.
 */

import {and, asc, desc, eq, gt, isNull, lte, ne, sql} from "drizzle-orm";
import {z} from "zod";
import {mirrors, nodeContent, nodeMetadata, outbox} from "../db/schema.js";
import type {NodeMetadataType} from "../db/schema.js";
import {FAR_FUTURE_DATE, parseTemporalTimestamp, temporalTimestampJustBefore} from "../temporal/index.js";
import {uuidToShortId} from "../workflowy/constants.js";
import {readWorkflowyEpoch} from "./account-store.js";
import {normalizeLayoutMode} from "./cache-temporal.js";
import type {LoggedOp} from "./relationship-log.js";
import type {UnitOfWork} from "./node-composite.js";
import {inIds} from "./in-ids.js";
import {writeInternalMetadata} from "./internal-metadata.js";
import type {InternalMetadata} from "./internal-metadata.js";
import {DEFAULT_ORDER_KEY, orderKeysFor} from "./order-key.js";
import {pendingAspects} from "./outbox.js";
import type {OutboxAspect} from "./outbox.js";
import {withdrawNodeComposites} from "./node-composite.js";
import {readSubtreeAt} from "./subtree-history.js";
import {closeCurrentVersions} from "./temporal-merge.js";

/** The internal API's id for the tree root, Home in the cache. */
const ROOT_PROJECT_ID = "None";

const MoveSchema = z
	.object(
		{
			projectid: z.string(),
			parentid: z.string(),
			priority: z.coerce.number(),
		},
	)
	.loose();

function jsonOf<T extends z.ZodType>(schema: T)
{
	return z.string().transform((value, context): z.output<T> =>
	{
		let parsed: unknown;
		try
		{
			parsed = JSON.parse(value);
		}
		catch
		{
			parsed = undefined;
		}
		const result = schema.safeParse(parsed);
		if (!result.success)
		{
			context.addIssue(
				{
					code: "custom",
					message: "not the expected JSON",
				},
			);
			return z.NEVER;
		}
		return result.data;
	});
}

const BulkMoveSchema = z
	.object(
		{
			projectids_json: jsonOf(z.array(z.string())),
			parentid: z.string(),
			priority: z.coerce.number(),
		},
	)
	.loose();

const EditSchema = z
	.object(
		{
			projectid: z.string(),
			name: z.string().optional(),
			description: z.string().optional(),
		},
	)
	.loose();

const ProjectIdSchema = z
	.object(
		{
			projectid: z.string(),
		},
	)
	.loose();

const UndeleteSchema = z
	.object(
		{
			projectid: z.string(),
			parentid: z.string(),
			priority: z.coerce.number(),
		},
	)
	.loose();

interface CreatedTree
{
	id: string;
	nm?: string | null | undefined;
	/** Null in the trees a node created through the public REST API logs. */
	no?: string | null | undefined;
	ct?: number | undefined;
	cp?: number | undefined;
	metadata?: unknown;
	ch?: CreatedTree[] | undefined;
}

const CreatedTreeSchema: z.ZodType<CreatedTree> = z.lazy(() =>
	z
		.object(
			{
				id: z.string(),
				nm: z.string().nullish(),
				no: z.string().nullish(),
				ct: z.number().optional(),
				cp: z.number().optional(),
				metadata: z.unknown().optional(),
				ch: z.array(CreatedTreeSchema).optional(),
			},
		)
		.loose(),
);

const BulkCreateSchema = z
	.object(
		{
			parentid: z.string(),
			starting_priority: z.coerce.number(),
			project_trees: z.union([jsonOf(z.array(CreatedTreeSchema)), z.array(CreatedTreeSchema)]),
		},
	)
	.loose();

const toParent = (id: string): string | null => (id === ROOT_PROJECT_ID ? null : id);

interface Move
{
	ids: string[];
	parentId: string | null;
	index: number;
}

function parseMove(op: LoggedOp): Move | undefined
{
	if (op.type === "move")
	{
		const move = MoveSchema.safeParse(op.data);
		return move.success
			?
				{
					ids: [move.data.projectid],
					parentId: toParent(move.data.parentid),
					index: move.data.priority,
				}
			: undefined;
	}
	if (op.type === "bulk_move")
	{
		const move = BulkMoveSchema.safeParse(op.data);
		return move.success
			?
				{
					ids: move.data.projectids_json,
					parentId: toParent(move.data.parentid),
					index: move.data.priority,
				}
			: undefined;
	}
	return undefined;
}

const SCHEMAS: Readonly<Record<string, z.ZodType>> =
{
	move: MoveSchema,
	bulk_move: BulkMoveSchema,
	edit: EditSchema,
	bulk_create: BulkCreateSchema,
	complete: ProjectIdSchema,
	uncomplete: ProjectIdSchema,
	delete: ProjectIdSchema,
	undelete: UndeleteSchema,
};

/** Whether the node replay can read `op`: every op type it replays must parse; other ops are not its concern. */
export function isNodeReplayable(op: LoggedOp): boolean
{
	const schema = SCHEMAS[op.type];
	return schema === undefined || schema.safeParse(op.data).success;
}

const parentKey = (parentId: string | null): string => parentId ?? "";

/** What the batch sets on a node's content and metadata; an absent key leaves the cached value. */
interface NodeChange
{
	name?: string | null;
	note?: string | null;
	completedAt?: Date | null;
	modifiedAt?: Date;
}

/** A node the batch creates, written as fresh rows. */
interface CreatedNode
{
	name: string | null;
	note: string | null;
	createdAt: Date;
	completedAt: Date | null;
	layoutMode: string | null;
	/** Set when a later op in the batch edits the node; else its `createdAt`. */
	modifiedAt?: Date;
}

const noteOrNull = (note: string | null | undefined): string | null =>
	note === undefined || note === null || note === "" ? null : note;

function layoutModeOf(metadata: unknown): string | null
{
	if (typeof metadata !== "object" || metadata === null || !("layoutMode" in metadata))
	{
		return null;
	}
	const {layoutMode} = metadata;
	return normalizeLayoutMode(typeof layoutMode === "string" ? layoutMode : null);
}

type ContentRow = typeof nodeContent.$inferSelect;

/** A deleted node the batch brings back from history, written as fresh versions of its rows just before the delete. */
interface RestoredNode
{
	content: ContentRow;
	metadata: NodeMetadataType | undefined;
	internal: InternalMetadata | undefined;
	/** The system time the rows are read at, just before the delete. */
	asOf: number;
}

interface ChildList
{
	parentId: string | null;
	ids: string[];
	/** The order key of each child the list held when it was loaded. */
	loadedKeys: Map<string, string | null>;
}

/** What a delete in the batch dropped from the model for one node, so a later undelete can put it back. */
interface Stash
{
	children: ChildList;
	change: NodeChange | undefined;
	created: CreatedNode | undefined;
	restored: RestoredNode | undefined;
}

const clampIndex = (index: number, length: number): number => Math.min(Math.max(index, 0), length);

/** The live nodes and child lists a batch touches, loaded on first use and edited in memory. */
class TreeModel
{
	/** Each cached node's parent before the batch. */
	readonly startParents = new Map<string, string | null>();
	readonly parents = new Map<string, string | null>();
	readonly children = new Map<string, ChildList>();
	readonly changes = new Map<string, NodeChange>();
	readonly created = new Map<string, CreatedNode>();
	readonly restored = new Map<string, RestoredNode>();
	/** The cached nodes the batch deletes. */
	readonly deleted = new Set<string>();
	/** Every node a delete in the batch dropped, by id. */
	private readonly stashed = new Map<string, Stash>();

	constructor(
		private readonly unitOfWork: UnitOfWork,
		/** Unix seconds of a Workflowy client timestamp. */
		readonly toUnixSec: (clientTimestamp: number | undefined) => number,
		/** The pending outbox aspects of the nodes the ops name. */
		private readonly pending: ReadonlyMap<string, ReadonlySet<OutboxAspect>>,
	)
	{
	}

	/** Whether the node's local `aspect` is ahead of workflowy.com, so the log must not overwrite it. */
	private localWins(id: string, aspect: OutboxAspect): boolean
	{
		const aspects = this.pending.get(id);
		return aspects !== undefined && (aspects.has(aspect) || aspects.has("create"));
	}

	/** The node's current parent, or undefined when it is neither cached nor created, or is deleted. */
	parentOf(id: string): string | null | undefined
	{
		if (this.deleted.has(id))
		{
			return undefined;
		}
		if (this.parents.has(id))
		{
			return this.parents.get(id);
		}
		const row = this.unitOfWork.tx
			.select(
				{
					parentId: nodeContent.parentId,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get();
		if (row === undefined)
		{
			return undefined;
		}
		this.parents.set(id, row.parentId);
		this.startParents.set(id, row.parentId);
		return row.parentId;
	}

	childrenOf(parentId: string | null): string[]
	{
		const key = parentKey(parentId);
		const loaded = this.children.get(key);
		if (loaded !== undefined)
		{
			return loaded.ids;
		}
		const rows =
			parentId !== null && this.created.has(parentId)
				? []
				: this.unitOfWork.tx
						.select(
							{
								id: nodeContent.id,
								orderKey: nodeMetadata.orderKey,
							},
						)
						.from(nodeContent)
						.leftJoin(
							nodeMetadata,
							and(eq(nodeMetadata.nodeId, nodeContent.id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)),
						)
						.where(
							and(
								parentId === null ? isNull(nodeContent.parentId) : eq(nodeContent.parentId, parentId),
								eq(nodeContent.systemTo, FAR_FUTURE_DATE),
							),
						)
						.orderBy(
							sql`coalesce(${nodeMetadata.orderKey}, ${DEFAULT_ORDER_KEY})`,
							sql`coalesce(${nodeMetadata.createdAt}, 0)`,
							asc(nodeContent.id),
						)
						.all();
		const ids = rows.map((row) => row.id);
		this.children.set(
			key,
			{
				parentId,
				ids,
				loadedKeys: new Map(rows.map((row) => [row.id, row.orderKey])),
			},
		);
		return ids;
	}

	private detach(id: string): void
	{
		const from = this.childrenOf(this.parentOf(id) ?? null);
		const at = from.indexOf(id);
		if (at !== -1)
		{
			from.splice(at, 1);
		}
	}

	/** Apply a move; `modifiedAt`, absent for our own moves, stamps the moved nodes and the destination parent. */
	move({ids, parentId, index}: Move, modifiedAt?: Date): void
	{
		const moving = ids.filter((id) => this.parentOf(id) !== undefined && !this.localWins(id, "placement"));
		if (moving.length === 0)
		{
			return;
		}
		for (const id of moving)
		{
			this.detach(id);
		}
		const to = this.childrenOf(parentId);
		to.splice(clampIndex(index, to.length), 0, ...moving);
		for (const id of moving)
		{
			this.parents.set(id, parentId);
		}
		if (modifiedAt !== undefined)
		{
			for (const id of parentId === null ? moving : [...moving, parentId])
			{
				this.change(
					id,
					{
						modifiedAt,
					},
				);
			}
		}
	}

	/** Merge `change` into the node, cached or created this batch. */
	change(id: string, change: NodeChange): void
	{
		if (this.parentOf(id) === undefined)
		{
			return;
		}
		const created = this.created.get(id);
		if (created !== undefined)
		{
			Object.assign(created, change);
			return;
		}
		const kept: NodeChange = {};
		if (change.name !== undefined && !this.localWins(id, "name"))
		{
			kept.name = change.name;
		}
		if (change.note !== undefined && !this.localWins(id, "note"))
		{
			kept.note = change.note;
		}
		if (change.completedAt !== undefined && !this.localWins(id, "completion"))
		{
			kept.completedAt = change.completedAt;
		}
		if (change.modifiedAt !== undefined)
		{
			kept.modifiedAt = change.modifiedAt;
		}
		this.changes.set(
			id,
			{
				...this.changes.get(id),
				...kept,
			},
		);
	}

	create(parentId: string | null, index: number, trees: readonly CreatedTree[], opTime: number): void
	{
		if (parentId !== null && this.parentOf(parentId) === undefined)
		{
			return;
		}
		const fresh = trees.filter((tree) => this.parentOf(tree.id) === undefined);
		const siblings = this.childrenOf(parentId);
		siblings.splice(clampIndex(index, siblings.length), 0, ...fresh.map((tree) => tree.id));
		for (const tree of fresh)
		{
			const createdAt = tree.ct === undefined ? opTime : this.toUnixSec(tree.ct);
			this.created.set(
				tree.id,
				{
					name: tree.nm ?? null,
					note: noteOrNull(tree.no),
					createdAt: new Date(createdAt * 1000),
					completedAt: tree.cp === undefined ? null : new Date(this.toUnixSec(tree.cp) * 1000),
					layoutMode: layoutModeOf(tree.metadata),
				},
			);
			this.parents.set(tree.id, parentId);
			this.children.set(
				tree.id,
				{
					parentId: tree.id,
					ids: [],
					loadedKeys: new Map(),
				},
			);
			this.create(tree.id, 0, tree.ch ?? [], opTime);
		}
	}

	delete(id: string): void
	{
		if (this.parentOf(id) === undefined)
		{
			return;
		}
		this.detach(id);
		const subtree = [id];
		// for-of over an array visits elements pushed during the loop, so this walks every level.
		for (const nodeId of subtree)
		{
			subtree.push(...this.childrenOf(nodeId));
		}
		for (const nodeId of subtree)
		{
			const children = this.children.get(nodeId);
			if (children !== undefined)
			{
				this.stashed.set(
					nodeId,
					{
						children,
						change: this.changes.get(nodeId),
						created: this.created.get(nodeId),
						restored: this.restored.get(nodeId),
					},
				);
			}
			this.children.delete(nodeId);
			this.changes.delete(nodeId);
			if (this.created.delete(nodeId) || this.restored.delete(nodeId))
			{
				this.parents.delete(nodeId);
			}
			else
			{
				this.deleted.add(nodeId);
			}
		}
	}

	/**
	 * Bring a deleted node back with its subtree at `parentId` and `index`, stamping every restored node. A node
	 * deleted earlier in the batch comes back as the batch left it; any other comes back from history.
	 */
	undelete(id: string, parentId: string | null, index: number, modifiedAt: Date): void
	{
		if ((parentId !== null && this.parentOf(parentId) === undefined) || this.localWins(id, "delete"))
		{
			return;
		}
		const subtree = this.stashed.has(id)
			? this.revive(id)
			: this.parentOf(id) === undefined
				? this.restoreFromHistory(id, parentId)
				: [];
		if (subtree.length === 0)
		{
			return;
		}
		const siblings = this.childrenOf(parentId);
		siblings.splice(clampIndex(index, siblings.length), 0, id);
		this.parents.set(id, parentId);
		for (const nodeId of subtree)
		{
			this.change(
				nodeId,
				{
					modifiedAt,
				},
			);
		}
	}

	/** Put back what the batch's delete dropped for the subtree under `id`. Returns the subtree. */
	private revive(id: string): string[]
	{
		const subtree = [id];
		// for-of over an array visits elements pushed during the loop, so this walks every level.
		for (const nodeId of subtree)
		{
			const stash = this.stashed.get(nodeId);
			if (stash === undefined)
			{
				continue;
			}
			this.stashed.delete(nodeId);
			this.deleted.delete(nodeId);
			this.children.set(nodeId, stash.children);
			if (stash.change !== undefined)
			{
				this.changes.set(nodeId, stash.change);
			}
			if (stash.created !== undefined)
			{
				this.created.set(nodeId, stash.created);
			}
			if (stash.restored !== undefined)
			{
				this.restored.set(nodeId, stash.restored);
			}
			for (const childId of stash.children.ids)
			{
				this.parents.set(childId, nodeId);
			}
			subtree.push(...stash.children.ids);
		}
		return subtree;
	}

	/**
	 * Load the subtree under `id` as it was just before its delete, leaving out nodes live now. Returns the restored
	 * nodes, or none when the node was never cached.
	 */
	private restoreFromHistory(id: string, parentId: string | null): string[]
	{
		const {tx} = this.unitOfWork;
		const closed = tx
			.select(
				{
					systemTo: nodeContent.systemTo,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), ne(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.orderBy(desc(nodeContent.systemTo))
			.get();
		if (closed === undefined)
		{
			return [];
		}
		const asOf = temporalTimestampJustBefore(closed.systemTo);
		const subtree = readSubtreeAt(tx, id, asOf);
		const restored: string[] = [];
		const reopen = (nodeId: string, nodeParent: string | null): boolean =>
		{
			if (this.deleted.has(nodeId) || this.parentOf(nodeId) !== undefined)
			{
				return false;
			}
			const content = tx
				.select()
				.from(nodeContent)
				.where(
					and(eq(nodeContent.id, nodeId), lte(nodeContent.systemFrom, asOf), gt(nodeContent.systemTo, asOf)),
				)
				.get();
			if (content === undefined)
			{
				return false;
			}
			const metadata = tx
				.select()
				.from(nodeMetadata)
				.where(
					and(
						eq(nodeMetadata.nodeId, nodeId),
						lte(nodeMetadata.systemFrom, asOf),
						gt(nodeMetadata.systemTo, asOf),
					),
				)
				.get();
			this.restored.set(
				nodeId,
				{
					content,
					metadata,
					internal: subtree.metadata.get(nodeId),
					asOf,
				},
			);
			this.parents.set(nodeId, nodeParent);
			restored.push(nodeId);
			const ids = (subtree.children.get(nodeId) ?? []).filter((childId) => reopen(childId, nodeId));
			this.children.set(
				nodeId,
				{
					parentId: nodeId,
					ids,
					loadedKeys: new Map(
						ids.map((childId) => [childId, this.restored.get(childId)?.metadata?.orderKey ?? null]),
					),
				},
			);
			return true;
		};
		reopen(id, parentId);
		return restored;
	}
}

/**
 * The new order key of every node whose place the batch changed: each touched child list maps onto keys, so a sibling
 * still in the order it was loaded in keeps its key and only created, moved or reordered nodes get one between their
 * neighbours.
 */
function changedOrderKeys(model: TreeModel): Map<string, string>
{
	const result = new Map<string, string>();
	for (const {ids, loadedKeys} of model.children.values())
	{
		for (const [id, orderKey] of orderKeysFor(
			ids.map((childId) => (
			{
				id: childId,
				orderKey: loadedKeys.get(childId),
			})),
		))
		{
			result.set(id, orderKey);
		}
	}
	return result;
}

/**
 * Close every pending outbox row of the deleted nodes: the remote delete wins. Returns the deleted nodes that had
 * pending edits, a pending delete of their own aside, sorted.
 */
function closeDeletedPending({tx, systemTime}: UnitOfWork, deleted: readonly string[]): string[]
{
	const pending = pendingAspects(tx, deleted);
	if (pending.size === 0)
	{
		return [];
	}
	closeCurrentVersions(tx, outbox, systemTime, inIds(outbox.nodeId, [...pending.keys()]));
	return [...pending]
		.filter(([, aspects]) => [...aspects].some((aspect) => aspect !== "delete"))
		.map(([id]) => id)
		.toSorted();
}

/** Reopen the mirror rows live just before a restored node's delete that join it to a node live now. */
function reopenMirrors({tx, systemTime}: UnitOfWork, restored: ReadonlyMap<string, RestoredNode>): void
{
	const isLive = (id: string): boolean =>
		tx
			.select(
				{
					id: nodeContent.id,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get() !== undefined;
	for (const asOf of new Set([...restored.values()].map((node) => node.asOf)))
	{
		const rows = tx
			.select()
			.from(mirrors)
			.where(and(lte(mirrors.systemFrom, asOf), gt(mirrors.systemTo, asOf)))
			.all()
			.filter((row) => restored.get(row.mirrorId)?.asOf === asOf || restored.get(row.originalId)?.asOf === asOf);
		for (const row of rows)
		{
			const open = tx
				.select()
				.from(mirrors)
				.where(
					and(
						eq(mirrors.mirrorId, row.mirrorId),
						eq(mirrors.originalId, row.originalId),
						eq(mirrors.systemTo, FAR_FUTURE_DATE),
					),
				)
				.get();
			if (open === undefined && isLive(row.mirrorId) && isLive(row.originalId))
			{
				tx.insert(mirrors)
					.values(
						{
							...row,
							systemFrom: systemTime,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
			}
		}
	}
}

/** Insert fresh versions of the restored nodes' rows, with the batch's changes, then their composites. */
function writeRestored(unitOfWork: UnitOfWork, model: TreeModel, orderKeys: ReadonlyMap<string, string>): void
{
	if (model.restored.size === 0)
	{
		return;
	}
	const {tx, systemTime} = unitOfWork;
	const current =
	{
		systemFrom: systemTime,
		systemTo: FAR_FUTURE_DATE,
	};
	for (const [id, {content, metadata}] of model.restored)
	{
		const change = model.changes.get(id);
		tx.insert(nodeContent)
			.values(
				{
					...content,
					parentId: model.parents.get(id) ?? null,
					name: change?.name === undefined ? content.name : change.name,
					note: change?.note === undefined ? content.note : change.note,
					...current,
				},
			)
			.run();
		if (metadata !== undefined)
		{
			tx.insert(nodeMetadata)
				.values(
					{
						...metadata,
						orderKey: orderKeys.get(id) ?? metadata.orderKey,
						completedAt: change?.completedAt === undefined ? metadata.completedAt : change.completedAt,
						modifiedAt: change?.modifiedAt ?? metadata.modifiedAt,
						...current,
					},
				)
				.run();
		}
	}
	writeInternalMetadata(unitOfWork, new Map([...model.restored].map(([id, node]) => [id, node.internal])));
	reopenMirrors(unitOfWork, model.restored);
}

/**
 * End the deleted nodes, insert the created and restored ones and version every other changed row, once each. Returns
 * the deleted nodes that had pending edits.
 */
function writeModel(unitOfWork: UnitOfWork, model: TreeModel): string[]
{
	const {tx, systemTime} = unitOfWork;
	const current =
	{
		systemFrom: systemTime,
		systemTo: FAR_FUTURE_DATE,
	};
	const deletedWithPendingEdits = closeDeletedPending(unitOfWork, [...model.deleted]);
	withdrawNodeComposites(unitOfWork, [...model.deleted]);
	const orderKeys = changedOrderKeys(model);
	for (const [id, node] of model.created)
	{
		tx.insert(nodeContent)
			.values(
				{
					id,
					name: node.name,
					note: node.note,
					parentId: model.parents.get(id) ?? null,
					...current,
				},
			)
			.run();
		tx.insert(nodeMetadata)
			.values(
				{
					nodeId: id,
					shortId: uuidToShortId(id),
					orderKey: orderKeys.get(id) ?? null,
					createdAt: node.createdAt,
					modifiedAt: node.modifiedAt ?? node.createdAt,
					completedAt: node.completedAt,
					layoutMode: node.layoutMode,
					...current,
				},
			)
			.run();
	}
	writeRestored(unitOfWork, model, orderKeys);
	const kept = (id: string): boolean => !model.deleted.has(id) && !model.created.has(id) && !model.restored.has(id);
	const contentIds = new Set([...model.startParents.keys(), ...model.changes.keys()].filter(kept));
	for (const id of contentIds)
	{
		const row = tx
			.select()
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get();
		if (row === undefined)
		{
			continue;
		}
		const change = model.changes.get(id);
		const next =
		{
			parentId: model.parents.has(id) ? (model.parents.get(id) ?? null) : row.parentId,
			name: change?.name === undefined ? row.name : change.name,
			note: change?.note === undefined ? row.note : change.note,
		};
		if (next.parentId === row.parentId && next.name === row.name && next.note === row.note)
		{
			continue;
		}
		closeCurrentVersions(tx, nodeContent, systemTime, eq(nodeContent.id, id));
		tx.insert(nodeContent)
			.values(
				{
					...row,
					...next,
					...current,
				},
			)
			.run();
	}
	const metadataIds = new Set([...orderKeys.keys(), ...model.changes.keys()].filter(kept));
	for (const id of metadataIds)
	{
		const row = tx
			.select()
			.from(nodeMetadata)
			.where(and(eq(nodeMetadata.nodeId, id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)))
			.get();
		if (row === undefined)
		{
			continue;
		}
		const change = model.changes.get(id);
		const completedAt = change?.completedAt;
		const stamped = change?.modifiedAt;
		const next =
		{
			orderKey: orderKeys.get(id) ?? row.orderKey,
			completedAt: completedAt === undefined ? row.completedAt : completedAt,
			modifiedAt:
				stamped === undefined || (row.modifiedAt !== null && row.modifiedAt >= stamped)
					? row.modifiedAt
					: stamped,
		};
		if (
			next.orderKey === row.orderKey &&
			next.completedAt?.getTime() === row.completedAt?.getTime() &&
			next.modifiedAt?.getTime() === row.modifiedAt?.getTime()
		)
		{
			continue;
		}
		closeCurrentVersions(tx, nodeMetadata, systemTime, eq(nodeMetadata.nodeId, id));
		tx.insert(nodeMetadata)
			.values(
				{
					...row,
					...next,
					...current,
				},
			)
			.run();
	}
	return deletedWithPendingEdits;
}

/** The ids of existing nodes the ops move, edit, complete or uncomplete. */
function namedNodeIds(ops: readonly LoggedOp[]): string[]
{
	const ids = new Set<string>();
	for (const op of ops)
	{
		const move = parseMove(op);
		if (move !== undefined)
		{
			for (const id of move.ids)
			{
				ids.add(id);
			}
			continue;
		}
		const projectId = ProjectIdSchema.safeParse(op.data);
		if (projectId.success && op.type !== "delete")
		{
			ids.add(projectId.data.projectid);
		}
	}
	return [...ids];
}

function applyOp(model: TreeModel, op: LoggedOp, opTime: number): void
{
	const projectId = ProjectIdSchema.safeParse(op.data);
	const modifiedAt = new Date(opTime * 1000);
	if (op.type === "edit")
	{
		const edit = EditSchema.safeParse(op.data);
		if (edit.success)
		{
			const {projectid, name, description} = edit.data;
			model.change(
				projectid,
				{
					modifiedAt,
					...(name === undefined
						? {}
						:
							{
								name,
							}),
					...(description === undefined
						? {}
						:
							{
								note: noteOrNull(description),
							}),
				},
			);
		}
	}
	else if (op.type === "bulk_create")
	{
		const create = BulkCreateSchema.safeParse(op.data);
		if (create.success)
		{
			model.create(
				toParent(create.data.parentid),
				create.data.starting_priority,
				create.data.project_trees,
				opTime,
			);
		}
	}
	else if ((op.type === "complete" || op.type === "uncomplete") && projectId.success)
	{
		model.change(
			projectId.data.projectid,
			{
				completedAt: op.type === "complete" ? modifiedAt : null,
				modifiedAt,
			},
		);
	}
	else if (op.type === "delete" && projectId.success)
	{
		model.delete(projectId.data.projectid);
	}
	else if (op.type === "undelete")
	{
		const undelete = UndeleteSchema.safeParse(op.data);
		if (undelete.success)
		{
			model.undelete(
				undelete.data.projectid,
				toParent(undelete.data.parentid),
				undelete.data.priority,
				modifiedAt,
			);
		}
	}
}

/**
 * Apply the node ops of `ops`, in order, to the cached tree, in the caller's unit of work. The ops in `ownOps` (by
 * identity) are our own pushes, whose content is already written through, so only their moves replay. Returns the
 * nodes a remote delete ended while they had pending outbox edits, whose rows it closed.
 */
export function applyNodeOps(
	unitOfWork: UnitOfWork,
	ops: readonly LoggedOp[],
	ownOps: ReadonlySet<LoggedOp> = new Set(),
): string[]
{
	const replayed = ops.filter(
		(op) => SCHEMAS[op.type] !== undefined && (!ownOps.has(op) || parseMove(op) !== undefined),
	);
	if (replayed.length === 0)
	{
		return [];
	}
	const epoch = readWorkflowyEpoch(unitOfWork.tx);
	const systemSec = Math.floor(parseTemporalTimestamp(unitOfWork.systemTime).getTime() / 1000);
	const toUnixSec = (clientTimestamp: number | undefined): number =>
		epoch === undefined || clientTimestamp === undefined ? systemSec : epoch + clientTimestamp;
	const model = new TreeModel(unitOfWork, toUnixSec, pendingAspects(unitOfWork.tx, namedNodeIds(replayed)));
	for (const op of replayed)
	{
		const move = parseMove(op);
		if (move === undefined)
		{
			applyOp(model, op, toUnixSec(op.client_timestamp));
		}
		else
		{
			model.move(move, ownOps.has(op) ? undefined : new Date(toUnixSec(op.client_timestamp) * 1000));
		}
	}
	return writeModel(unitOfWork, model);
}
