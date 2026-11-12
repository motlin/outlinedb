/**
 * Replays the node ops of `/push_and_poll` transaction logs onto `node_content` and `node_metadata`, so a change made
 * by another client lands in the cache (and so in the nodes change feed) without a tree read:
 * - `move` and `bulk_move` set parents and priorities. Upstream's index semantics (internal-api.md): a `move`'s
 *   `priority` is the slot after the node leaves its old place, and a `bulk_move`'s is the count of non-moved siblings
 *   before the block.
 * - `edit` sets the name and note (`description`) when it carries them.
 * - `bulk_create` inserts its `project_trees` at `starting_priority`, children included.
 * - `complete` and `uncomplete` set and clear `completedAt`.
 * - `delete` ends the node's whole subtree, composites included.
 *
 * Moves replay for every transaction. The content ops replay only for other clients' transactions: our own creates,
 * edits, completes and deletes are written through when they are pushed, so replaying them as well would version
 * those rows twice.
 *
 * The ops are applied in order to an in-memory model of the touched nodes and parents' child lists, and each changed
 * row is versioned once at the end, so several ops on one node in a batch never write a node twice in one unit of
 * work. An op on a node missing from the cache is skipped, and so is a `bulk_create` under a parent missing from it:
 * the log never carries enough to place them.
 */

import {and, asc, eq, isNull, sql} from "drizzle-orm";
import {z} from "zod";
import {nodeContent, nodeMetadata} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {uuidToShortId} from "../workflowy/constants.js";
import {readWorkflowyEpoch} from "./account-store.js";
import {normalizeLayoutMode, systemFromToDate} from "./cache-temporal.js";
import type {LoggedOp} from "./relationship-log.js";
import type {UnitOfWork} from "./node-composite.js";
import {withdrawNodeComposites} from "./node-composite.js";
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

interface CreatedTree
{
	id: string;
	nm?: string | undefined;
	no?: string | undefined;
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
				nm: z.string().optional(),
				no: z.string().optional(),
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
}

/** A node the batch creates, written as fresh rows. */
interface CreatedNode
{
	name: string | null;
	note: string | null;
	createdAt: Date;
	completedAt: Date | null;
	layoutMode: string | null;
}

const noteOrNull = (note: string | undefined): string | null => (note === undefined || note === "" ? null : note);

function layoutModeOf(metadata: unknown): string | null
{
	if (typeof metadata !== "object" || metadata === null || !("layoutMode" in metadata))
	{
		return null;
	}
	const {layoutMode} = metadata;
	return normalizeLayoutMode(typeof layoutMode === "string" ? layoutMode : null);
}

/** The live nodes and child lists a batch touches, loaded on first use and edited in memory. */
class TreeModel
{
	/** Each cached node's parent before the batch. */
	readonly startParents = new Map<string, string | null>();
	readonly parents = new Map<string, string | null>();
	readonly children = new Map<
		string,
		{
			parentId: string | null;
			ids: string[];
		}
	>();
	readonly changes = new Map<string, NodeChange>();
	readonly created = new Map<string, CreatedNode>();
	/** The cached nodes the batch deletes. */
	readonly deleted = new Set<string>();

	constructor(
		private readonly unitOfWork: UnitOfWork,
		/** Unix seconds of a Workflowy client timestamp. */
		readonly toUnixSec: (clientTimestamp: number | undefined) => number,
	)
	{
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
		const ids =
			parentId !== null && this.created.has(parentId)
				? []
				: this.unitOfWork.tx
						.select(
							{
								id: nodeContent.id,
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
						.orderBy(sql`${nodeMetadata.priority} IS NULL`, asc(nodeMetadata.priority), asc(nodeContent.id))
						.all()
						.map((row) => row.id);
		this.children.set(
			key,
			{
				parentId,
				ids,
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

	move({ids, parentId, index}: Move): void
	{
		const moving = ids.filter((id) => this.parentOf(id) !== undefined);
		if (moving.length === 0)
		{
			return;
		}
		for (const id of moving)
		{
			this.detach(id);
		}
		const to = this.childrenOf(parentId);
		to.splice(Math.min(Math.max(index, 0), to.length), 0, ...moving);
		for (const id of moving)
		{
			this.parents.set(id, parentId);
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
		this.changes.set(
			id,
			{
				...this.changes.get(id),
				...change,
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
		siblings.splice(Math.min(Math.max(index, 0), siblings.length), 0, ...fresh.map((tree) => tree.id));
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
			this.children.delete(nodeId);
			this.changes.delete(nodeId);
			if (this.created.delete(nodeId))
			{
				this.parents.delete(nodeId);
			}
			else
			{
				this.deleted.add(nodeId);
			}
		}
	}
}

/** The priority of every node in a loaded child list. */
function priorities(model: TreeModel): Map<string, number>
{
	const result = new Map<string, number>();
	for (const {ids} of model.children.values())
	{
		for (const [priority, id] of ids.entries())
		{
			result.set(id, priority);
		}
	}
	return result;
}

/** End the deleted nodes, insert the created ones and version every other changed row, once each. */
function writeModel(unitOfWork: UnitOfWork, model: TreeModel): void
{
	const {tx, systemTime} = unitOfWork;
	const current =
	{
		systemFrom: systemTime,
		systemTo: FAR_FUTURE_DATE,
	};
	withdrawNodeComposites(unitOfWork, [...model.deleted]);
	const slots = priorities(model);
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
					priority: slots.get(id) ?? null,
					createdAt: node.createdAt,
					modifiedAt: node.createdAt,
					completedAt: node.completedAt,
					layoutMode: node.layoutMode,
					...current,
				},
			)
			.run();
	}
	const kept = (id: string): boolean => !model.deleted.has(id) && !model.created.has(id);
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
	const metadataIds = new Set([...slots.keys(), ...model.changes.keys()].filter(kept));
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
		const completedAt = model.changes.get(id)?.completedAt;
		const next =
		{
			priority: slots.get(id) ?? row.priority,
			completedAt: completedAt === undefined ? row.completedAt : completedAt,
		};
		if (next.priority === row.priority && next.completedAt?.getTime() === row.completedAt?.getTime())
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
}

function applyOp(model: TreeModel, op: LoggedOp, opTime: number): void
{
	const projectId = ProjectIdSchema.safeParse(op.data);
	if (op.type === "edit")
	{
		const edit = EditSchema.safeParse(op.data);
		if (edit.success)
		{
			const {projectid, name, description} = edit.data;
			model.change(
				projectid,
				{
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
				completedAt: op.type === "complete" ? new Date(opTime * 1000) : null,
			},
		);
	}
	else if (op.type === "delete" && projectId.success)
	{
		model.delete(projectId.data.projectid);
	}
}

/**
 * Apply the node ops of `ops`, in order, to the cached tree, in the caller's unit of work. The ops in `ownOps` (by
 * identity) are our own pushes, whose content is already written through, so only their moves replay.
 */
export function applyNodeOps(
	unitOfWork: UnitOfWork,
	ops: readonly LoggedOp[],
	ownOps: ReadonlySet<LoggedOp> = new Set(),
): void
{
	const replayed = ops.filter(
		(op) => SCHEMAS[op.type] !== undefined && (!ownOps.has(op) || parseMove(op) !== undefined),
	);
	if (replayed.length === 0)
	{
		return;
	}
	const epoch = readWorkflowyEpoch(unitOfWork.tx);
	const systemSec = Math.floor(systemFromToDate(unitOfWork.systemTime).getTime() / 1000);
	const toUnixSec = (clientTimestamp: number | undefined): number =>
		epoch === undefined || clientTimestamp === undefined ? systemSec : epoch + clientTimestamp;
	const model = new TreeModel(unitOfWork, toUnixSec);
	for (const op of replayed)
	{
		const move = parseMove(op);
		if (move === undefined)
		{
			applyOp(model, op, toUnixSec(op.client_timestamp));
		}
		else
		{
			model.move(move);
		}
	}
	writeModel(unitOfWork, model);
}
