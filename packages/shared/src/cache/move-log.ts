/**
 * Replays the `move` and `bulk_move` ops of `/push_and_poll` transaction logs onto `node_content` parents and
 * `node_metadata` priorities, so a move made by another client lands in the cache (and so in the nodes change feed)
 * without a tree read. Upstream's index semantics (internal-api.md): a `move`'s `priority` is the slot after the node
 * leaves its old place, and a `bulk_move`'s is the count of non-moved siblings before the block.
 *
 * The ops are applied in order to an in-memory model of the touched parents' child lists, and each changed row is
 * versioned once at the end, so several moves of one node in a batch never write a node twice in one unit of work.
 * A moved node missing from the cache is skipped: the log carries no name or note to create it from.
 */

import {and, asc, eq, isNull, sql} from "drizzle-orm";
import {z} from "zod";
import {nodeContent, nodeMetadata} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import type {LoggedOp} from "./relationship-log.js";
import type {UnitOfWork} from "./node-composite.js";
import {closeCurrentVersions} from "./temporal-merge.js";

/** The internal API's id for the tree root, Home in the cache. */
const ROOT_PROJECT_ID = "None";

const MoveSchema = z.object({projectid: z.string(), parentid: z.string(), priority: z.coerce.number()}).loose();

const BulkMoveSchema = z
	.object({
		projectids_json: z.string().transform((value, context): string[] => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				parsed = undefined;
			}
			const ids = z.array(z.string()).safeParse(parsed);
			if (!ids.success) {
				context.addIssue({code: "custom", message: "projectids_json is not a JSON string array"});
				return z.NEVER;
			}
			return ids.data;
		}),
		parentid: z.string(),
		priority: z.coerce.number(),
	})
	.loose();

interface Move {
	ids: string[];
	parentId: string | null;
	index: number;
}

const toParent = (id: string): string | null => (id === ROOT_PROJECT_ID ? null : id);

function parseMove(op: LoggedOp): Move | undefined {
	if (op.type === "move") {
		const move = MoveSchema.safeParse(op.data);
		return move.success
			? {ids: [move.data.projectid], parentId: toParent(move.data.parentid), index: move.data.priority}
			: undefined;
	}
	if (op.type === "bulk_move") {
		const move = BulkMoveSchema.safeParse(op.data);
		return move.success
			? {ids: move.data.projectids_json, parentId: toParent(move.data.parentid), index: move.data.priority}
			: undefined;
	}
	return undefined;
}

/** Whether the move replay can read `op`: every `move` and `bulk_move` must parse; other ops are not its concern. */
export function isMoveReplayable(op: LoggedOp): boolean {
	return (op.type !== "move" && op.type !== "bulk_move") || parseMove(op) !== undefined;
}

const parentKey = (parentId: string | null): string => parentId ?? "";

/** The live child lists of the parents a batch touches, loaded on first use and edited in memory. */
class TreeModel {
	/** Each moved node's parent before the batch. */
	readonly startParents = new Map<string, string | null>();
	readonly parents = new Map<string, string | null>();
	readonly children = new Map<string, {parentId: string | null; ids: string[]}>();

	constructor(private readonly unitOfWork: UnitOfWork) {}

	/** The node's current parent, or undefined when it is not cached. */
	parentOf(id: string): string | null | undefined {
		if (this.parents.has(id)) {
			return this.parents.get(id);
		}
		const row = this.unitOfWork.tx
			.select({parentId: nodeContent.parentId})
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get();
		if (row === undefined) {
			return undefined;
		}
		this.parents.set(id, row.parentId);
		this.startParents.set(id, row.parentId);
		return row.parentId;
	}

	childrenOf(parentId: string | null): string[] {
		const key = parentKey(parentId);
		const loaded = this.children.get(key);
		if (loaded !== undefined) {
			return loaded.ids;
		}
		const ids = this.unitOfWork.tx
			.select({id: nodeContent.id})
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
		this.children.set(key, {parentId, ids});
		return ids;
	}

	apply({ids, parentId, index}: Move): void {
		const moving = ids.filter((id) => this.parentOf(id) !== undefined);
		if (moving.length === 0) {
			return;
		}
		for (const id of moving) {
			const from = this.childrenOf(this.parentOf(id) ?? null);
			const at = from.indexOf(id);
			if (at !== -1) {
				from.splice(at, 1);
			}
		}
		const to = this.childrenOf(parentId);
		to.splice(Math.min(Math.max(index, 0), to.length), 0, ...moving);
		for (const id of moving) {
			this.parents.set(id, parentId);
		}
	}
}

/** Version a moved node's new parent and every sibling whose slot changed, once each. */
function writeModel(unitOfWork: UnitOfWork, model: TreeModel): void {
	const {tx, systemTime} = unitOfWork;
	for (const [id, startParent] of model.startParents) {
		const parentId = model.parents.get(id) ?? null;
		if (parentId === startParent) {
			continue;
		}
		const row = tx
			.select()
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get();
		if (row === undefined) {
			continue;
		}
		closeCurrentVersions(tx, nodeContent, systemTime, eq(nodeContent.id, id));
		tx.insert(nodeContent)
			.values({...row, parentId, systemFrom: systemTime, systemTo: FAR_FUTURE_DATE})
			.run();
	}
	for (const {ids} of model.children.values()) {
		for (const [priority, id] of ids.entries()) {
			const row = tx
				.select()
				.from(nodeMetadata)
				.where(and(eq(nodeMetadata.nodeId, id), eq(nodeMetadata.systemTo, FAR_FUTURE_DATE)))
				.get();
			if (row === undefined || row.priority === priority) {
				continue;
			}
			closeCurrentVersions(tx, nodeMetadata, systemTime, eq(nodeMetadata.nodeId, id));
			tx.insert(nodeMetadata)
				.values({...row, priority, systemFrom: systemTime, systemTo: FAR_FUTURE_DATE})
				.run();
		}
	}
}

/** Apply the `move` and `bulk_move` ops of `ops`, in order, to the cached tree, in the caller's unit of work. */
export function applyMoveOps(unitOfWork: UnitOfWork, ops: readonly LoggedOp[]): void {
	const moves = ops.map(parseMove).filter((move) => move !== undefined);
	if (moves.length === 0) {
		return;
	}
	const model = new TreeModel(unitOfWork);
	for (const move of moves) {
		model.apply(move);
	}
	writeModel(unitOfWork, model);
}
