/**
 * Replays the relationship part of `/push_and_poll` transaction-log ops onto
 * the bitemporal edge tables (`mirrors`, `references_roots`), so the cache
 * stays current with upstream without a whole-tree read. A backlink item is a
 * mirror of its source under a references root, so `backlink` patches replay
 * as that mirror.
 *
 * Only metadata is replayed: `bulk_create` trees (each new node's own
 * `mirror.originalId`, `backlink` and `isReferencesRoot`), `edit` metadata
 * patches, and `delete`s, which end the rows each node of the deleted subtree
 * owns as a mirror or references root. Patches follow upstream's semantics with two deliberate
 * differences, both from the 2026-10-29 probes (P1, P2b):
 * - a leaf `add` needs no parent object (the server creates missing parents);
 * - an object-valued `add` of `mirror`, `mirror.mirrorRootIds` or
 *   `mirror.backlinkMirrorRootIds` merges, because the public REST mirror
 *   endpoint logs a whole-map `add` holding only the new id while the server
 *   keeps the existing ones.
 * Removes apply literally.
 */

import {and, eq, inArray, or} from "drizzle-orm";
import {z} from "zod";
import {mirrors, nodeContent, referencesRoots} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {collectItemRelationships, currentBacklinkItems, emptyItemRelationships} from "./item-relationships.js";
import type {UnitOfWork} from "./node-composite.js";
import {closeCurrentVersions, joinKey} from "./temporal-merge.js";

/** A logged op, as `PushAndPoll` reports it. */
export interface LoggedOp {
	type: string;
	data: Record<string, unknown>;
	/** The transaction's client timestamp: seconds since the account's join date. */
	client_timestamp?: number;
}

interface LoggedTree {
	id: string;
	metadata?: unknown;
	ch?: LoggedTree[] | undefined;
}

const LoggedTreeSchema: z.ZodType<LoggedTree> = z.lazy(() =>
	z.object({id: z.string(), metadata: z.unknown().optional(), ch: z.array(LoggedTreeSchema).optional()}).loose(),
);

const BulkCreateSchema = z
	.object({
		project_trees: z.union([
			z.string().transform((json, context): unknown => {
				try {
					return JSON.parse(json);
				} catch {
					context.addIssue({code: "custom", message: "project_trees is not JSON"});
					return z.NEVER;
				}
			}),
			z.array(z.unknown()),
		]),
	})
	.loose();

const EditSchema = z
	.object({
		projectid: z.string(),
		metadataPatches: z
			.array(
				z
					.object({
						op: z.string(),
						path: z.array(z.union([z.string(), z.number()]).transform(String)),
						value: z.unknown().optional(),
					})
					.loose(),
			)
			.optional(),
	})
	.loose();

const DeleteSchema = z.object({projectid: z.string()}).loose();

type Patch = NonNullable<z.output<typeof EditSchema>["metadataPatches"]>[number];

interface MirrorRow {
	mirrorId: string;
	originalId: string;
}

const mirrorKey = (row: MirrorRow): string => joinKey(row.mirrorId, row.originalId);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Durable Object SQLite binds at most 100 parameters; two `IN` lists of this size stay under it. */
const ID_BATCH_SIZE = 40;

/** The current edge rows of the nodes an op batch touches, edited in memory and diffed back once. */
class EdgeModel {
	readonly mirrors = new Map<string, MirrorRow>();
	/** The mirrors that are backlink items, which a whole `backlinkMirrorRootIds` remove ends. */
	readonly backlinkItems = new Set<string>();
	readonly roots = new Set<string>();

	addMirror(mirrorId: string, originalId: string): void {
		const row = {mirrorId, originalId};
		this.mirrors.set(mirrorKey(row), row);
	}

	removeMirrors(matches: (row: MirrorRow) => boolean): void {
		for (const [key, row] of this.mirrors) {
			if (matches(row)) {
				this.mirrors.delete(key);
			}
		}
	}

	/** A backlink item mirrors exactly its source. */
	setBacklink(nodeId: string, sourceId: string): void {
		this.removeMirrors((row) => row.mirrorId === nodeId);
		this.addMirror(nodeId, sourceId);
		this.backlinkItems.add(nodeId);
	}
}

/** Parent to children of the nodes `ops` create, so a delete in the same batch reaches them. */
function createdChildren(ops: readonly LoggedOp[]): Map<string, string[]> {
	const children = new Map<string, string[]>();
	const link = (parentId: string, trees: LoggedTree[]): void => {
		for (const tree of trees) {
			children.set(parentId, [...(children.get(parentId) ?? []), tree.id]);
			link(tree.id, tree.ch ?? []);
		}
	};
	for (const op of ops) {
		const parentId = op.type === "bulk_create" ? op.data.parentid : undefined;
		if (typeof parentId === "string") {
			link(parentId, createdTrees(op));
		}
	}
	return children;
}

/** Each deleted node with its cached and same-batch descendants, by the deleted node's id. */
function deletedSubtrees(unitOfWork: UnitOfWork, ops: readonly LoggedOp[]): Map<string, string[]> {
	const created = createdChildren(ops);
	const subtrees = new Map<string, string[]>();
	for (const op of ops) {
		const deleted = op.type === "delete" ? DeleteSchema.safeParse(op.data) : undefined;
		if (deleted?.success === true && !subtrees.has(deleted.data.projectid)) {
			subtrees.set(deleted.data.projectid, subtreeIds(unitOfWork, deleted.data.projectid, created));
		}
	}
	return subtrees;
}

function subtreeIds(unitOfWork: UnitOfWork, rootId: string, created: Map<string, string[]>): string[] {
	const seen = new Set([rootId]);
	let level = [rootId];
	while (level.length > 0) {
		const next: string[] = [];
		const visit = (id: string): void => {
			if (!seen.has(id)) {
				seen.add(id);
				next.push(id);
			}
		};
		for (let start = 0; start < level.length; start += ID_BATCH_SIZE) {
			const batch = level.slice(start, start + ID_BATCH_SIZE);
			for (const row of unitOfWork.tx
				.select({id: nodeContent.id})
				.from(nodeContent)
				.where(and(inArray(nodeContent.parentId, batch), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
				.all()) {
				visit(row.id);
			}
		}
		for (const id of level) {
			for (const child of created.get(id) ?? []) {
				visit(child);
			}
		}
		level = next;
	}
	return [...seen];
}

function touchedIds(ops: readonly LoggedOp[], subtrees: Map<string, string[]>): Set<string> {
	const ids = new Set<string>([...subtrees.values()].flat());
	const visit = (trees: LoggedTree[]): void => {
		for (const tree of trees) {
			ids.add(tree.id);
			visit(tree.ch ?? []);
		}
	};
	for (const op of ops) {
		if (op.type === "bulk_create") {
			visit(createdTrees(op));
		} else if (op.type === "edit") {
			const edit = parseEdit(op);
			if (edit !== undefined && (edit.metadataPatches?.length ?? 0) > 0) {
				ids.add(edit.projectid);
			}
		}
	}
	return ids;
}

function parseCreatedTrees(op: LoggedOp): LoggedTree[] | undefined {
	const parsed = BulkCreateSchema.safeParse(op.data);
	if (!parsed.success) {
		return undefined;
	}
	const trees = z.array(LoggedTreeSchema).safeParse(parsed.data.project_trees);
	return trees.success ? trees.data : undefined;
}

function createdTrees(op: LoggedOp): LoggedTree[] {
	return parseCreatedTrees(op) ?? [];
}

function parseEdit(op: LoggedOp): z.output<typeof EditSchema> | undefined {
	const edit = EditSchema.safeParse(op.data);
	return edit.success ? edit.data : undefined;
}

/**
 * Whether the replay can read `op`'s relationship data: a `bulk_create`'s
 * `project_trees`, an `edit` carrying `metadataPatches` or a `delete`'s
 * `projectid`. Other ops carry
 * none, so they always are.
 */
export function isReplayable(op: LoggedOp): boolean {
	if (op.type === "bulk_create") {
		return !Object.hasOwn(op.data, "project_trees") || parseCreatedTrees(op) !== undefined;
	}
	if (op.type === "edit") {
		return !Object.hasOwn(op.data, "metadataPatches") || parseEdit(op) !== undefined;
	}
	if (op.type === "delete") {
		return DeleteSchema.safeParse(op.data).success;
	}
	return true;
}

function loadModel(unitOfWork: UnitOfWork, ids: readonly string[]): EdgeModel {
	const {tx} = unitOfWork;
	const model = new EdgeModel();
	for (let start = 0; start < ids.length; start += ID_BATCH_SIZE) {
		const batch = ids.slice(start, start + ID_BATCH_SIZE);
		const touches = or(inArray(mirrors.mirrorId, batch), inArray(mirrors.originalId, batch));
		for (const row of tx
			.select({mirrorId: mirrors.mirrorId, originalId: mirrors.originalId})
			.from(mirrors)
			.where(and(touches, eq(mirrors.systemTo, FAR_FUTURE_DATE)))
			.all()) {
			model.addMirror(row.mirrorId, row.originalId);
		}
		for (const item of currentBacklinkItems(tx, touches)) {
			model.backlinkItems.add(item.nodeId);
		}
		for (const row of tx
			.select({nodeId: referencesRoots.nodeId})
			.from(referencesRoots)
			.where(and(inArray(referencesRoots.nodeId, batch), eq(referencesRoots.systemTo, FAR_FUTURE_DATE)))
			.all()) {
			model.roots.add(row.nodeId);
		}
	}
	return model;
}

/** A created node's own rows; a copied `mirrorRootIds` describes the copied node, so it is left out. */
function applyBulkCreate(model: EdgeModel, op: LoggedOp): void {
	const created = new Set<string>();
	const relationships = emptyItemRelationships();
	const visit = (trees: LoggedTree[]): void => {
		for (const tree of trees) {
			created.add(tree.id);
			collectItemRelationships(relationships, tree.id, tree.metadata);
			if (isRecord(tree.metadata) && isRecord(tree.metadata.backlink)) {
				model.backlinkItems.add(tree.id);
			}
			visit(tree.ch ?? []);
		}
	};
	visit(createdTrees(op));
	for (const row of relationships.mirrors.filter((mirror) => created.has(mirror.mirrorId))) {
		model.addMirror(row.mirrorId, row.originalId);
	}
	for (const {nodeId} of relationships.referencesRoots) {
		model.roots.add(nodeId);
	}
}

const ROOT_MAPS = new Set(["mirrorRootIds", "backlinkMirrorRootIds"]);

function applyMirrorPatch(model: EdgeModel, nodeId: string, {op, path, value}: Patch): void {
	const [, field, leaf] = path;
	if (field === undefined) {
		if (op === "add") {
			const relationships = emptyItemRelationships();
			collectItemRelationships(relationships, nodeId, {mirror: value});
			for (const row of relationships.mirrors) {
				model.addMirror(row.mirrorId, row.originalId);
			}
		} else if (op === "remove") {
			model.removeMirrors((row) => row.originalId === nodeId || row.mirrorId === nodeId);
		}
		return;
	}
	if (field === "originalId" && path.length === 2) {
		model.removeMirrors((row) => row.mirrorId === nodeId);
		if (op === "add" && typeof value === "string" && value !== "") {
			model.addMirror(nodeId, value);
		}
		return;
	}
	if (!ROOT_MAPS.has(field)) {
		return;
	}
	if (leaf !== undefined) {
		if (op === "add") {
			model.addMirror(leaf, nodeId);
		} else if (op === "remove") {
			model.removeMirrors((row) => row.mirrorId === leaf && row.originalId === nodeId);
		}
		return;
	}
	if (op === "add" && isRecord(value)) {
		for (const mirrorId of Object.keys(value)) {
			model.addMirror(mirrorId, nodeId);
		}
	} else if (op === "remove") {
		const backlinkMap = field === "backlinkMirrorRootIds";
		model.removeMirrors(
			(row) => row.originalId === nodeId && model.backlinkItems.has(row.mirrorId) === backlinkMap,
		);
	}
}

function applyEdit(model: EdgeModel, op: LoggedOp): void {
	const edit = parseEdit(op);
	if (edit === undefined) {
		return;
	}
	const nodeId = edit.projectid;
	for (const patch of edit.metadataPatches ?? []) {
		const [head] = patch.path;
		if (head === "mirror") {
			applyMirrorPatch(model, nodeId, patch);
		} else if (head === "backlink" && patch.path.length === 1) {
			const {value} = patch;
			if (patch.op === "add" && isRecord(value) && typeof value.sourceID === "string" && value.sourceID !== "") {
				model.setBacklink(nodeId, value.sourceID);
			} else if (patch.op === "remove") {
				model.backlinkItems.delete(nodeId);
			}
		} else if (head === "isReferencesRoot" && patch.path.length === 1) {
			if (patch.op === "add" && patch.value === true) {
				model.roots.add(nodeId);
			} else {
				model.roots.delete(nodeId);
			}
		}
	}
}

/** End every row a node of the deleted subtree owns; rows of mirrors elsewhere pointing into it stay. */
function applyDelete(model: EdgeModel, subtree: readonly string[]): void {
	const ids = new Set(subtree);
	model.removeMirrors((row) => ids.has(row.mirrorId));
	for (const id of ids) {
		model.backlinkItems.delete(id);
		model.roots.delete(id);
	}
}

function writeDiff(unitOfWork: UnitOfWork, before: EdgeModel, after: EdgeModel): void {
	const {tx, systemTime} = unitOfWork;
	const current = {systemFrom: systemTime, systemTo: FAR_FUTURE_DATE};
	for (const [key, row] of before.mirrors) {
		if (!after.mirrors.has(key)) {
			closeCurrentVersions(
				tx,
				mirrors,
				systemTime,
				and(eq(mirrors.mirrorId, row.mirrorId), eq(mirrors.originalId, row.originalId)),
			);
		}
	}
	for (const [key, row] of after.mirrors) {
		if (!before.mirrors.has(key)) {
			tx.insert(mirrors)
				.values({...row, ...current})
				.run();
		}
	}
	for (const nodeId of before.roots) {
		if (!after.roots.has(nodeId)) {
			closeCurrentVersions(tx, referencesRoots, systemTime, eq(referencesRoots.nodeId, nodeId));
		}
	}
	for (const nodeId of after.roots) {
		if (!before.roots.has(nodeId)) {
			tx.insert(referencesRoots)
				.values({nodeId, ...current})
				.run();
		}
	}
}

/**
 * Apply `ops`, in order, to the edge rows of the nodes they touch, in the
 * caller's unit of work. Each key ends or starts at most once, so an `add`
 * followed by a `remove` of the same row in one batch leaves no trace.
 */
export function applyRelationshipOps(unitOfWork: UnitOfWork, ops: readonly LoggedOp[]): void {
	const subtrees = deletedSubtrees(unitOfWork, ops);
	const ids = [...touchedIds(ops, subtrees)];
	if (ids.length === 0) {
		return;
	}
	const before = loadModel(unitOfWork, ids);
	const after = loadModel(unitOfWork, ids);
	for (const op of ops) {
		if (op.type === "bulk_create") {
			applyBulkCreate(after, op);
		} else if (op.type === "edit") {
			applyEdit(after, op);
		} else if (op.type === "delete") {
			const deleted = DeleteSchema.safeParse(op.data);
			if (deleted.success) {
				applyDelete(after, subtrees.get(deleted.data.projectid) ?? []);
			}
		}
	}
	writeDiff(unitOfWork, before, after);
}
