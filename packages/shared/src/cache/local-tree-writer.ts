import {and, asc, desc, eq, isNull, lte, gt, ne, sql} from "drizzle-orm";
import {generateNKeysBetween} from "fractional-indexing";
import type {AnySQLiteColumn} from "drizzle-orm/sqlite-core";
import
{
	account,
	fileBlobs,
	mirrors,
	nodeContent,
	nodeMetadata,
	referencesRoots,
	rootPreferences,
} from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import type {LayoutWrite} from "../internal/calendar-layout-apply.js";
import {applyMetadataPatches} from "../internal/metadata-patch.js";
import type {NewTree} from "../internal/ops.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {HOME_TARGET} from "../types/targets.js";
import {uuidToShortId} from "../workflowy/constants.js";
import {internalLinkShortIds} from "../workflowy/internal-links.js";
import {AccountNotProvisionedError} from "./account-store.js";
import {currentVersion, normalizeLayoutMode} from "./cache-temporal.js";
import {inIds} from "./in-ids.js";
import {compareBinary, compareSiblingOrder, DEFAULT_ORDER_KEY} from "./order-key.js";
import {readNodeInternalMetadata, writeInternalMetadata} from "./internal-metadata.js";
import type {InternalMetadata} from "./internal-metadata.js";
import {currentBacklinkItems} from "./item-relationships.js";
import {endNodeComposites, runUnitOfWork} from "./node-composite.js";
import type {UnitOfWork} from "./node-composite.js";
import {readSubtreeAt, systemTimeJustBefore} from "./subtree-history.js";
import {closeCurrentVersions} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** A parent: a node id, or Home as `null` (or the `home` target). */
type Parent = string | null;

export interface LocalCreateInput
{
	/** The parent node id; `null` or `home` for Home. */
	parentId: Parent;
	/** 0-based slot among all current siblings, clamped to `[0, siblings]`. Omitted = the bottom. */
	index?: number;
	/** The sibling the new node follows (null: first); while it is a live sibling it decides the slot over `index`. */
	afterId?: string | null;
	/** The new node's id, such as a client-generated UUID; generated when absent. */
	id?: string;
	name: string;
	note?: string | null;
	layoutMode?: string | null;
}

export interface LocalUpdateInput
{
	name?: string;
	note?: string | null;
	layoutMode?: string | null;
	/** Other metadata writes in the same unit of work, as {@link LocalTreeWriter.setNodeMetaValues} takes them. */
	metadata?: readonly LocalMetaChange[];
}

export interface LocalMoveInput
{
	ids: string[];
	/** The target parent node id; `null` or `home` for Home. */
	parentId: Parent;
	/**
	 * Insertion slot among the target's current children, moved ones included (counted BEFORE removal): the nodes land
	 * right before the child now at `index`. Clamped to `[0, children]`. Omitted = the bottom.
	 */
	index?: number;
}

export interface LocalCreateTreesInput
{
	/** The parent node id; `null` or `home` for Home. */
	parentId: Parent;
	/** 0-based slot of the first tree among all current siblings, clamped. Omitted = the bottom. */
	index?: number;
	/** The sibling the first tree follows (null: first); while it is a live sibling it decides the slot over `index`. */
	afterId?: string | null;
	trees: readonly NewTree[];
}

export interface LocalAttachmentInput
{
	/** The parent node id; `null` or `home` for Home. */
	parentId: Parent;
	/** 0-based slot among all current siblings, clamped. Omitted = the bottom. */
	index?: number;
	/** Upstream's `metadata.s3File` shape: `fileName`, `fileType`, optional image sizes. */
	s3File: Record<string, unknown>;
	/** Where the bytes are: `localPath` is the blob store key. */
	blob:
	{
		sha256: string;
		size: number;
		contentType: string;
		localPath: string;
	};
}

/** One metadata write at an upstream key path; an undefined value removes the key. */
export interface LocalMetaChange
{
	path: readonly string[];
	value?: unknown;
}

export interface LocalRestoreInput
{
	id: string;
	/** The parent to restore under (`null` or `home` for Home); omitted = where it was deleted from. */
	parentId?: Parent;
	/** Slot under the parent, clamped; omitted = its old slot without `parentId`, else the bottom. */
	index?: number;
}

export interface LocalMirrorsInput
{
	/** The originals to mirror, in order; each must be a live node that is not itself a mirror. */
	originalIds: readonly string[];
	/** The parent node id; `null` or `home` for Home. */
	parentId: Parent;
	/** 0-based slot of the first mirror among all current siblings, clamped. Omitted = the bottom. */
	index?: number;
}

/**
 * What a delete removes, as `planSubtreeDelete` plans it from the cache: mirrors removed outright, originals kept by
 * taking the slot of one of their mirrors outside the deleted part, then the node itself (null when it is kept).
 */
export interface LocalDeletePlan
{
	mirrorIds: readonly string[];
	promotions: readonly
	{
		originalId: string;
		mirrorId: string;
	}[];
	nodeId: string | null;
}

/** What {@link LocalTreeWriter.syncBacklinks} changed. */
export interface LocalBacklinkSync
{
	/** Backlink items created: a mirror of `sourceId` at the top of `targetId`'s references root. */
	created:
	{
		id: string;
		sourceId: string;
		targetId: string;
	}[];
	/** References roots created under targets that had none. */
	referencesRoots: string[];
	/** Backlink items deleted because their source no longer links to their target. */
	deleted:
	{
		id: string;
		targetId: string;
	}[];
}

export interface LocalTreeWriterOptions
{
	/** The clock, in milliseconds; node timestamps are stored in whole seconds of it. */
	now?: () => number;
	generateId?: () => string;
}

type MetadataRow = typeof nodeMetadata.$inferSelect;
type ContentRow = typeof nodeContent.$inferSelect;
type MetadataPatch = Partial<Pick<MetadataRow, "orderKey" | "modifiedAt" | "completedAt" | "layoutMode">>;
type ContentPatch = Partial<Pick<ContentRow, "name" | "note" | "parentId">>;

function toParent(parentId: Parent): string | null
{
	return parentId === HOME_TARGET ? null : parentId;
}

function clampIndex(index: number, length: number): number
{
	return Math.min(Math.max(Math.trunc(index), 0), length);
}

function noteOrNull(note: string | null | undefined): string | null
{
	return note === undefined || note === null || note === "" ? null : note;
}

/** The slot a create lands at: right after a live `afterId`, first for a null one, else `index` clamped (bottom when omitted). */
function anchoredSlot(order: readonly string[], afterId: string | null | undefined, index: number | undefined): number
{
	if (afterId === null)
	{
		return 0;
	}
	const anchor = order.indexOf(afterId ?? "");
	return anchor === -1 ? clampIndex(index ?? order.length, order.length) : anchor + 1;
}

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Set (or, for undefined, remove) `value` at `path` inside `target`, creating objects along the way. */
function applyPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void
{
	const last = path.at(-1);
	if (last === undefined)
	{
		return;
	}
	let current = target;
	for (const key of path.slice(0, -1))
	{
		const next = current[key];
		if (isRecord(next))
		{
			const copy =
			{
				...next,
			};
			current[key] = copy;
			current = copy;
		}
		else if (value === undefined)
		{
			return;
		}
		else
		{
			const created: Record<string, unknown> = {};
			current[key] = created;
			current = created;
		}
	}
	if (value === undefined)
	{
		Reflect.deleteProperty(current, last);
	}
	else
	{
		current[last] = value;
	}
}

function samePatch(current: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>): boolean
{
	return Object.entries(patch).every(([key, value]) =>
	{
		const existing = current[key];
		return existing instanceof Date && value instanceof Date
			? existing.getTime() === value.getTime()
			: existing === value;
	});
}

/**
 * The changes one unit of work makes, collected so each row gets at most one new version: a version opened in this
 * unit and closed again in it would never have existed (and the temporal helpers refuse it).
 */
class PendingWrites
{
	private readonly content = new Map<string, ContentPatch>();
	private readonly metadata = new Map<string, MetadataPatch>();
	/** Each touched parent's children in their new order, loaded on first use. */
	private readonly orders = new Map<string | null, string[]>();
	/** Nodes inserted in this unit: their rows are updated in place, since a version may not open and close in one unit. */
	private readonly created = new Set<string>();
	/** Nodes created or moved into a slot in this unit: each gets a new order key between its new neighbours. */
	private readonly placed = new Set<string>();

	constructor(private readonly tx: TemporalTransaction)
	{
	}

	order(parentId: string | null): string[]
	{
		let order = this.orders.get(parentId);
		if (order === undefined)
		{
			order = currentChildIds(this.tx, parentId);
			this.orders.set(parentId, order);
		}
		return order;
	}

	/** A node's parent as this unit leaves it so far. */
	parentOf(id: string): string | null
	{
		const patched = this.content.get(id);
		return patched?.parentId === undefined ? (currentContent(this.tx, id)?.parentId ?? null) : patched.parentId;
	}

	/** `id` and every descendant as this unit leaves them so far, breadth-first. */
	subtree(id: string): string[]
	{
		const ids = [id];
		// for-of visits elements pushed during the loop, so this walks every level.
		for (const parentId of ids)
		{
			ids.push(...(this.orders.get(parentId) ?? currentChildIds(this.tx, parentId)));
		}
		return ids;
	}

	markCreated(id: string): void
	{
		this.created.add(id);
	}

	markPlaced(id: string): void
	{
		this.placed.add(id);
	}

	setContent(id: string, patch: ContentPatch): void
	{
		this.content.set(
			id,
			{
				...this.content.get(id),
				...patch,
			},
		);
	}

	setMetadata(id: string, patch: MetadataPatch): void
	{
		this.metadata.set(
			id,
			{
				...this.metadata.get(id),
				...patch,
			},
		);
	}

	/**
	 * Give each run of placed nodes keys between the kept siblings around it. A kept sibling whose key does not sort
	 * after the run's lower bound (a tie, which created_at and id break) joins the run, so the keys stay strictly ordered.
	 */
	private assignOrderKeys(): void
	{
		for (const order of this.orders.values())
		{
			if (!order.some((id) => this.placed.has(id)))
			{
				continue;
			}
			const keys = currentOrderKeys(this.tx, order);
			let lower: string | null = null;
			let run: string[] = [];
			const keyRun = (upper: string | null): void =>
			{
				for (const [at, orderKey] of generateNKeysBetween(lower, upper, run.length).entries())
				{
					this.setMetadata(
						run[at] ?? "",
						{
							orderKey,
						},
					);
				}
				run = [];
			};
			for (const id of order)
			{
				const key = keys.get(id) ?? DEFAULT_ORDER_KEY;
				const tied = run.length > 0 && lower !== null && compareBinary(key, lower) <= 0;
				if (this.placed.has(id) || tied)
				{
					run.push(id);
					continue;
				}
				keyRun(key);
				lower = key;
			}
			keyRun(null);
		}
	}

	/** Key the placed nodes, then write each changed row once. */
	flush(systemTime: string): void
	{
		this.assignOrderKeys();
		for (const [id, patch] of this.content)
		{
			const current = this.tx
				.select()
				.from(nodeContent)
				.where(and(eq(nodeContent.id, id), currentVersion(nodeContent)))
				.get();
			if (current === undefined || samePatch(current, patch))
			{
				continue;
			}
			if (this.created.has(id))
			{
				this.tx
					.update(nodeContent)
					.set(patch)
					.where(and(eq(nodeContent.id, id), currentVersion(nodeContent)))
					.run();
				continue;
			}
			closeCurrentVersions(this.tx, nodeContent, systemTime, eq(nodeContent.id, id));
			this.tx
				.insert(nodeContent)
				.values(
					{
						...current,
						...patch,
						systemFrom: systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		for (const [id, patch] of this.metadata)
		{
			const current = this.tx
				.select()
				.from(nodeMetadata)
				.where(and(eq(nodeMetadata.nodeId, id), currentVersion(nodeMetadata)))
				.get();
			if (current === undefined || samePatch(current, patch))
			{
				continue;
			}
			if (this.created.has(id))
			{
				this.tx
					.update(nodeMetadata)
					.set(patch)
					.where(and(eq(nodeMetadata.nodeId, id), currentVersion(nodeMetadata)))
					.run();
				continue;
			}
			closeCurrentVersions(this.tx, nodeMetadata, systemTime, eq(nodeMetadata.nodeId, id));
			this.tx
				.insert(nodeMetadata)
				.values(
					{
						...current,
						...patch,
						systemFrom: systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
	}
}

/** The current order key of each of `ids` that has one. */
function currentOrderKeys(tx: TemporalTransaction, ids: readonly string[]): Map<string, string | null>
{
	return new Map(
		tx
			.select(
				{
					nodeId: nodeMetadata.nodeId,
					orderKey: nodeMetadata.orderKey,
				},
			)
			.from(nodeMetadata)
			.where(and(inIds(nodeMetadata.nodeId, ids), currentVersion(nodeMetadata)))
			.all()
			.map(({nodeId, orderKey}) => [nodeId, orderKey]),
	);
}

/** A parent's current children ids (Home's for null) in sibling order: order key, then createdAt, then id. */
export function currentChildIds(tx: TemporalTransaction, parentId: string | null): string[]
{
	return tx
		.select(
			{
				id: nodeContent.id,
			},
		)
		.from(nodeContent)
		.leftJoin(nodeMetadata, and(eq(nodeMetadata.nodeId, nodeContent.id), currentVersion(nodeMetadata)))
		.where(
			and(
				parentId === null ? isNull(nodeContent.parentId) : eq(nodeContent.parentId, parentId),
				currentVersion(nodeContent),
			),
		)
		.orderBy(
			sql`coalesce(${nodeMetadata.orderKey}, ${DEFAULT_ORDER_KEY})`,
			sql`coalesce(${nodeMetadata.createdAt}, 0)`,
			asc(nodeContent.id),
		)
		.all()
		.map((row) => row.id);
}

/** The slot in `order` where a row with these sort fields sorts: before the first sibling that sorts after it. */
function slotFor(tx: TemporalTransaction, order: readonly string[], row: MetadataRow | undefined): number
{
	if (row === undefined)
	{
		return order.length;
	}
	const siblings = new Map(
		tx
			.select()
			.from(nodeMetadata)
			.where(and(inIds(nodeMetadata.nodeId, order), currentVersion(nodeMetadata)))
			.all()
			.map((sibling) => [sibling.nodeId, sibling]),
	);
	const slot = order.findIndex(
		(id) =>
			compareSiblingOrder(
				{
					orderKey: siblings.get(id)?.orderKey,
					createdAt: siblings.get(id)?.createdAt,
					id,
				},
				{
					orderKey: row.orderKey,
					createdAt: row.createdAt,
					id: row.nodeId,
				},
			) > 0,
	);
	return slot === -1 ? order.length : slot;
}

function currentContent(tx: TemporalTransaction, id: string): ContentRow | undefined
{
	return tx
		.select()
		.from(nodeContent)
		.where(and(eq(nodeContent.id, id), currentVersion(nodeContent)))
		.get();
}

function requireNode(tx: TemporalTransaction, id: string): ContentRow
{
	const node = currentContent(tx, id);
	if (node === undefined)
	{
		throw new Error(`Node ${id} not found`);
	}
	return node;
}

function requireParent(tx: TemporalTransaction, parentId: string | null): void
{
	if (parentId !== null)
	{
		requireNode(tx, parentId);
	}
}

/** The original a mirror shows, or the node itself: a mirror's text and completion live on its original. */
function writeTarget(tx: TemporalTransaction, id: string): string
{
	const mirror = tx
		.select(
			{
				originalId: mirrors.originalId,
			},
		)
		.from(mirrors)
		.where(and(eq(mirrors.mirrorId, id), currentVersion(mirrors)))
		.get();
	return mirror?.originalId ?? id;
}

/** Whether `id` is a current references root. */
function isReferencesRoot(tx: TemporalTransaction, id: string): boolean
{
	return (
		tx
			.select(
				{
					nodeId: referencesRoots.nodeId,
				},
			)
			.from(referencesRoots)
			.where(and(eq(referencesRoots.nodeId, id), currentVersion(referencesRoots)))
			.get() !== undefined
	);
}

/** The current node with this short id, or null. */
function resolveShortId(tx: TemporalTransaction, shortId: string): string | null
{
	return (
		tx
			.select(
				{
					nodeId: nodeMetadata.nodeId,
				},
			)
			.from(nodeMetadata)
			.where(and(eq(nodeMetadata.shortId, shortId), currentVersion(nodeMetadata)))
			.get()?.nodeId ?? null
	);
}

/** Home's stored layout mode (`root_preferences.home_layout_mode`), null for the default. */
export function readHomeLayoutMode(tx: TemporalTransaction): string | null
{
	return (
		tx
			.select(
				{
					homeLayoutMode: rootPreferences.homeLayoutMode,
				},
			)
			.from(rootPreferences)
			.where(eq(rootPreferences.systemTo, FAR_FUTURE_DATE))
			.get()?.homeLayoutMode ?? null
	);
}

/**
 * Writes the outline of a standalone account, which has no workflowy.com behind it, straight into the temporal node
 * tables. Each write is one unit of work. Siblings are read in `node_metadata.order_key` order. A write gives only the
 * nodes it creates or moves a key between their new neighbours, so no sibling is renumbered; this writer leaves
 * `priority` null, and only rows whose values changed get a new version.
 */
export class LocalTreeWriter
{
	private readonly now: () => number;
	private readonly generateId: () => string;

	constructor(
		private readonly database: AppDatabase,
		options: LocalTreeWriterOptions = {},
	)
	{
		this.now = options.now ?? Date.now;
		this.generateId = options.generateId ?? (() => crypto.randomUUID());
	}

	private nowDate(): Date
	{
		return new Date(Math.floor(this.now() / 1000) * 1000);
	}

	private write<T>(work: (pending: PendingWrites, unitOfWork: UnitOfWork) => T): T
	{
		return runUnitOfWork(this.database, (unitOfWork) =>
		{
			const pending = new PendingWrites(unitOfWork.tx);
			const result = work(pending, unitOfWork);
			pending.flush(unitOfWork.systemTime);
			return result;
		});
	}

	/** Create a node at a slot under a parent. */
	createAt(input: LocalCreateInput):
	{
		id: string;
	}
	{
		const parentId = toParent(input.parentId);
		const id = input.id ?? this.generateId();
		return this.write((pending, unitOfWork) =>
		{
			requireParent(unitOfWork.tx, parentId);
			const order = pending.order(parentId);
			const index = anchoredSlot(order, input.afterId, input.index);
			this.insertNode(
				pending,
				unitOfWork,
				{
					id,
					name: input.name,
					note: input.note,
					parentId,
					orderKey: null,
					layoutMode: input.layoutMode,
				},
			);
			order.splice(index, 0, id);
			pending.markPlaced(id);
			return {
				id,
			};
		});
	}

	/**
	 * Create a forest of new trees at one slot under a parent, in one unit of work: names, notes, completion, kept
	 * metadata (typed tables), children, and the mirror row of each `metadata.mirror` root. Returns the top ids.
	 */
	createTreesAt(input: LocalCreateTreesInput):
	{
		ids: string[];
	}
	{
		return this.write((pending, unitOfWork) => (
		{
			ids: this.insertTrees(pending, unitOfWork, input),
		}));
	}

	/**
	 * Create an attachment node (empty name, upstream's `s3File` metadata) at a slot under a parent, with the live
	 * `file_blobs` version of its stored bytes, in one unit of work. The bytes must already be in the blob store.
	 */
	createAttachmentAt(input: LocalAttachmentInput):
	{
		id: string;
	}
	{
		return this.write((pending, unitOfWork) =>
		{
			const [id = ""] = this.insertTrees(
				pending,
				unitOfWork,
				{
					parentId: input.parentId,
					index: input.index,
					trees: [
						{
							name: "",
							metadata:
							{
								s3File: input.s3File,
							},
						},
					],
				},
			);
			unitOfWork.tx
				.insert(fileBlobs)
				.values(
					{
						nodeId: id,
						status: "ok",
						...input.blob,
						error: null,
						systemFrom: unitOfWork.systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			return {
				id,
			};
		});
	}

	/** Mirror each original, in order, at consecutive slots under a parent. Returns the new mirrors' ids. */
	createMirrorsAt(input: LocalMirrorsInput):
	{
		ids: string[];
	}
	{
		return this.write((pending, unitOfWork) =>
		{
			for (const originalId of input.originalIds)
			{
				requireNode(unitOfWork.tx, originalId);
				if (writeTarget(unitOfWork.tx, originalId) !== originalId)
				{
					throw new Error(`Node ${originalId} is a mirror`);
				}
			}
			return {
				ids: this.insertTrees(
					pending,
					unitOfWork,
					{
						parentId: input.parentId,
						...(input.index === undefined
							? {}
							:
								{
									index: input.index,
								}),
						trees: input.originalIds.map((originalId) => (
						{
							name: "",
							metadata:
							{
								mirror:
								{
									originalId,
									isMirrorRoot: true,
								},
							},
						})),
					},
				),
			};
		});
	}

	/**
	 * Replace a mirror (or an original that has mirrors) with `copy` at its slot, in one unit of work: the copy goes in,
	 * then `plan` removes the row (an original is kept by its promotion into a mirror's slot). Returns the copy's id.
	 */
	detachMirror(id: string, copy: NewTree, plan: LocalDeletePlan): string
	{
		return this.write((pending, unitOfWork) =>
		{
			const node = requireNode(unitOfWork.tx, id);
			const [copyId] = this.insertTrees(
				pending,
				unitOfWork,
				{
					parentId: node.parentId,
					index: Math.max(pending.order(node.parentId).indexOf(id), 0),
					trees: [copy],
				},
			);
			this.removeNodes(pending, unitOfWork, plan);
			if (copyId === undefined)
			{
				throw new Error("The copy produced no id");
			}
			return copyId;
		});
	}

	private insertNode(
		pending: PendingWrites,
		{tx, systemTime}: UnitOfWork,
		row:
		{
			id: string;
			name: string;
			note?: string | null;
			parentId: string | null;
			/** The key under a parent created in this unit; null for a node placed in a loaded order, keyed at flush. */
			orderKey: string | null;
			completed?: boolean;
			layoutMode?: string | null;
		},
	): void
	{
		if (currentContent(tx, row.id) !== undefined)
		{
			throw new Error(`Node ${row.id} already exists`);
		}
		const now = this.nowDate();
		tx.insert(nodeContent)
			.values(
				{
					id: row.id,
					name: row.name,
					note: noteOrNull(row.note),
					parentId: row.parentId,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		tx.insert(nodeMetadata)
			.values(
				{
					nodeId: row.id,
					shortId: uuidToShortId(row.id),
					orderKey: row.orderKey,
					createdAt: now,
					modifiedAt: now,
					completedAt: row.completed === true ? now : null,
					layoutMode: normalizeLayoutMode(row.layoutMode ?? null),
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		pending.markCreated(row.id);
	}

	private insertTrees(pending: PendingWrites, unitOfWork: UnitOfWork, input: LocalCreateTreesInput): string[]
	{
		const {tx, systemTime} = unitOfWork;
		const parentId = toParent(input.parentId);
		requireParent(tx, parentId);
		const metadataById = new Map<string, InternalMetadata | undefined>();
		const insert = (tree: NewTree, treeParent: string | null, orderKey: string | null): string =>
		{
			const id = tree.id ?? this.generateId();
			const metadata = tree.metadata ?? {};
			this.insertNode(
				pending,
				unitOfWork,
				{
					id,
					name: tree.name,
					note: tree.note,
					parentId: treeParent,
					orderKey,
					completed: tree.completed === true,
					layoutMode: typeof metadata.layoutMode === "string" ? metadata.layoutMode : null,
				},
			);
			metadataById.set(id, metadata);
			const {mirror} = metadata;
			if (isRecord(mirror) && typeof mirror.originalId === "string" && mirror.isMirrorRoot === true)
			{
				tx.insert(mirrors)
					.values(
						{
							mirrorId: id,
							originalId: mirror.originalId,
							systemFrom: systemTime,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
			}
			const children = tree.children ?? [];
			for (const [at, childKey] of generateNKeysBetween(null, null, children.length).entries())
			{
				const child = children[at];
				if (child !== undefined)
				{
					insert(child, id, childKey);
				}
			}
			return id;
		};
		const order = pending.order(parentId);
		const index = anchoredSlot(order, input.afterId, input.index);
		const ids = input.trees.map((tree) => insert(tree, parentId, null));
		order.splice(index, 0, ...ids);
		for (const id of ids)
		{
			pending.markPlaced(id);
		}
		writeInternalMetadata(unitOfWork, metadataById);
		return ids;
	}

	/**
	 * Write metadata values at upstream key paths (`layoutMode`, `numbered_start`, `priority.defaultToBottom`,
	 * `table...`) to the typed tables, merged over the node's current metadata; a mirror's go to its original. Home
	 * (`home`) takes only `layoutMode`, stored as `root_preferences.home_layout_mode`.
	 */
	setNodeMetaValues(requestedId: string, changes: readonly LocalMetaChange[]): void
	{
		this.write((pending, unitOfWork) =>
		{
			if (requestedId === HOME_TARGET)
			{
				this.writeHomeLayoutMode(unitOfWork, changes);
				return;
			}
			requireNode(unitOfWork.tx, requestedId);
			const id = writeTarget(unitOfWork.tx, requestedId);
			this.applyMetaChanges(pending, unitOfWork, id, changes);
			pending.setMetadata(
				id,
				{
					modifiedAt: this.nowDate(),
				},
			);
		});
	}

	/**
	 * `layoutMode` lives on `node_metadata`, which {@link PendingWrites} versions once per unit; every other key goes
	 * through {@link writeInternalMetadata} with `layoutMode` held at its stored value so that call leaves the row alone.
	 */
	private applyMetaChanges(
		pending: PendingWrites,
		unitOfWork: UnitOfWork,
		id: string,
		changes: readonly LocalMetaChange[],
	): void
	{
		const others = changes.filter(({path}) => !(path.length === 1 && path[0] === "layoutMode"));
		for (const {path, value} of changes)
		{
			if (path.length === 1 && path[0] === "layoutMode")
			{
				pending.setMetadata(
					id,
					{
						layoutMode: normalizeLayoutMode(typeof value === "string" ? value : null),
					},
				);
			}
		}
		if (others.length === 0)
		{
			return;
		}
		const metadata = readNodeInternalMetadata(unitOfWork.tx, id);
		for (const {path, value} of others)
		{
			applyPath(metadata, path, value);
		}
		writeInternalMetadata(unitOfWork, new Map([[id, metadata]]));
	}

	private writeHomeLayoutMode({tx, systemTime}: UnitOfWork, changes: readonly LocalMetaChange[]): void
	{
		const change = changes.findLast(({path}) => path.length === 1 && path[0] === "layoutMode");
		if (change === undefined || changes.length !== 1)
		{
			throw new Error("Home accepts only layoutMode");
		}
		const homeLayoutMode = normalizeLayoutMode(typeof change.value === "string" ? change.value : null);
		const current = tx.select().from(rootPreferences).where(eq(rootPreferences.systemTo, FAR_FUTURE_DATE)).get();
		if (current !== undefined)
		{
			if (current.homeLayoutMode === homeLayoutMode)
			{
				return;
			}
			closeCurrentVersions(tx, rootPreferences, systemTime, eq(rootPreferences.userId, current.userId));
		}
		const userId =
			current?.userId ??
			tx
				.select(
					{
						userId: account.userId,
					},
				)
				.from(account)
				.where(eq(account.systemTo, FAR_FUTURE_DATE))
				.get()?.userId;
		if (userId === undefined)
		{
			throw new AccountNotProvisionedError();
		}
		tx.insert(rootPreferences)
			.values(
				{
					...current,
					userId,
					homeLayoutMode,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	}

	/**
	 * Bring a deleted node back under its original id with its subtree as it was just before the delete, at the
	 * requested parent and slot (default: where it was). Answers false when the node never existed; throws while it is
	 * live.
	 */
	restoreNode(input: LocalRestoreInput): boolean
	{
		return this.write((pending, unitOfWork) => this.restoreInUnit(pending, unitOfWork, input));
	}

	/** {@link restoreNode} inside a unit of work; the restored rows count as created in it. */
	private restoreInUnit(pending: PendingWrites, unitOfWork: UnitOfWork, input: LocalRestoreInput): boolean
	{
		const {tx, systemTime} = unitOfWork;
		if (currentContent(tx, input.id) !== undefined)
		{
			throw new Error(`Node ${input.id} is not deleted`);
		}
		const closed = tx
			.select(
				{
					systemTo: nodeContent.systemTo,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.id, input.id), ne(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.orderBy(desc(nodeContent.systemTo))
			.get();
		if (closed === undefined)
		{
			return false;
		}
		const asOf = systemTimeJustBefore(closed.systemTo);
		const at = (table: {systemFrom: AnySQLiteColumn; systemTo: AnySQLiteColumn}) =>
			and(lte(table.systemFrom, asOf), gt(table.systemTo, asOf));
		const rowAt = (id: string) => (
		{
			content: tx
				.select()
				.from(nodeContent)
				.where(and(eq(nodeContent.id, id), at(nodeContent)))
				.get(),
			metadata: tx
				.select()
				.from(nodeMetadata)
				.where(and(eq(nodeMetadata.nodeId, id), at(nodeMetadata)))
				.get(),
		});
		const root = rowAt(input.id);
		if (root.content === undefined)
		{
			return false;
		}
		const parentId = input.parentId === undefined ? root.content.parentId : toParent(input.parentId);
		requireParent(tx, parentId);
		const order = pending.order(parentId);
		const index = clampIndex(
			input.index ?? (input.parentId === undefined ? slotFor(tx, order, root.metadata) : order.length),
			order.length,
		);
		const subtree = readSubtreeAt(tx, input.id, asOf);
		const restored: string[] = [];
		const reopen = (id: string, nodeParent: string | null): void =>
		{
			if (currentContent(tx, id) !== undefined)
			{
				return;
			}
			const {content, metadata} = rowAt(id);
			if (content === undefined)
			{
				return;
			}
			tx.insert(nodeContent)
				.values(
					{
						...content,
						parentId: nodeParent,
						systemFrom: systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			if (metadata !== undefined)
			{
				tx.insert(nodeMetadata)
					.values(
						{
							...metadata,
							priority: null,
							systemFrom: systemTime,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
			}
			restored.push(id);
			pending.markCreated(id);
			for (const childId of subtree.children.get(id) ?? [])
			{
				reopen(childId, id);
			}
		};
		reopen(input.id, parentId);
		order.splice(index, 0, input.id);
		pending.markPlaced(input.id);
		writeInternalMetadata(unitOfWork, new Map(restored.map((id) => [id, subtree.metadata.get(id)])));
		this.reopenMirrors(unitOfWork, restored, asOf);
		return true;
	}

	/** Reopen the mirror rows live at `asOf` that join a restored node to a node live now (or restored too). */
	private reopenMirrors({tx, systemTime}: UnitOfWork, restored: readonly string[], asOf: string): void
	{
		const ids = new Set(restored);
		const rows = tx
			.select()
			.from(mirrors)
			.where(and(lte(mirrors.systemFrom, asOf), gt(mirrors.systemTo, asOf)))
			.all()
			.filter((row) => ids.has(row.mirrorId) || ids.has(row.originalId));
		for (const row of rows)
		{
			const live =
				currentContent(tx, row.mirrorId) !== undefined && currentContent(tx, row.originalId) !== undefined;
			const open = tx
				.select()
				.from(mirrors)
				.where(
					and(
						eq(mirrors.mirrorId, row.mirrorId),
						eq(mirrors.originalId, row.originalId),
						currentVersion(mirrors),
					),
				)
				.get();
			if (live && open === undefined)
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

	/** Edit a node's name, note or layout; a mirror's edit goes to its original. Returns the node written. */
	updateNode(requestedId: string, input: LocalUpdateInput): string
	{
		return this.write((pending, unitOfWork) =>
		{
			const {tx} = unitOfWork;
			requireNode(tx, requestedId);
			const id = writeTarget(tx, requestedId);
			const content: ContentPatch = {};
			if (input.name !== undefined)
			{
				content.name = input.name;
			}
			if (input.note !== undefined)
			{
				content.note = noteOrNull(input.note);
			}
			pending.setContent(id, content);
			const metadata: MetadataPatch =
			{
				modifiedAt: this.nowDate(),
			};
			if (input.layoutMode !== undefined)
			{
				metadata.layoutMode = normalizeLayoutMode(input.layoutMode);
			}
			pending.setMetadata(id, metadata);
			this.applyMetaChanges(pending, unitOfWork, id, input.metadata ?? []);
			return id;
		});
	}

	/** Complete a node (a mirror's original). Returns the node written. */
	completeNode(requestedId: string): string
	{
		return this.setCompletion(requestedId, true);
	}

	/** Uncomplete a node (a mirror's original). Returns the node written. */
	uncompleteNode(requestedId: string): string
	{
		return this.setCompletion(requestedId, false);
	}

	private setCompletion(requestedId: string, completed: boolean): string
	{
		return this.write((pending, {tx}) =>
		{
			requireNode(tx, requestedId);
			const id = writeTarget(tx, requestedId);
			const now = this.nowDate();
			pending.setMetadata(
				id,
				{
					modifiedAt: now,
					completedAt: completed ? now : null,
				},
			);
			return id;
		});
	}

	/**
	 * Delete a node with its whole subtree, the mirror rows of every node in it and the backlink items of every source in
	 * it, then close the gap it leaves. With a `plan` (from `planSubtreeDelete`), mirrors go first and each kept original
	 * takes its mirror's slot, as upstream's web app keeps an original whose mirror lives on.
	 */
	deleteNode(id: string, plan?: LocalDeletePlan): void
	{
		this.write((pending, unitOfWork) =>
		{
			requireNode(unitOfWork.tx, id);
			this.removeNodes(
				pending,
				unitOfWork,
				plan ??
				{
					mirrorIds: [],
					promotions: [],
					nodeId: id,
				},
			);
		});
	}

	private removeNodes(pending: PendingWrites, unitOfWork: UnitOfWork, plan: LocalDeletePlan): void
	{
		const {tx} = unitOfWork;
		const ended: string[] = [];
		const unlink = (id: string): void =>
		{
			const order = pending.order(pending.parentOf(id));
			const at = order.indexOf(id);
			if (at !== -1)
			{
				order.splice(at, 1);
			}
		};
		const end = (id: string): void =>
		{
			unlink(id);
			ended.push(...pending.subtree(id));
		};
		for (const mirrorId of plan.mirrorIds)
		{
			end(mirrorId);
		}
		for (const {originalId, mirrorId} of plan.promotions)
		{
			unlink(originalId);
			const target = pending.parentOf(mirrorId);
			const order = pending.order(target);
			order.splice(order.indexOf(mirrorId), 1, originalId);
			pending.markPlaced(originalId);
			ended.push(...pending.subtree(mirrorId));
			pending.setContent(
				originalId,
				{
					parentId: target,
				},
			);
			pending.setMetadata(
				originalId,
				{
					modifiedAt: this.nowDate(),
				},
			);
		}
		if (plan.nodeId !== null)
		{
			const kept = new Set(plan.promotions.flatMap(({originalId}) => pending.subtree(originalId)));
			unlink(plan.nodeId);
			ended.push(...pending.subtree(plan.nodeId).filter((id) => !kept.has(id)));
		}
		// Upstream deletes a deleted source's backlink items; its references roots stay, even when emptied.
		const dead = new Set(ended);
		for (const item of currentBacklinkItems(tx, inIds(mirrors.originalId, [...dead])))
		{
			if (!dead.has(item.nodeId))
			{
				dead.add(item.nodeId);
				end(item.nodeId);
			}
		}
		endNodeComposites(unitOfWork, [...new Set(ended)]);
	}

	/**
	 * Bring each source's backlink items in step with the links in its text, as upstream's client does on save: a target
	 * it links to (a mirror's original, never the source itself) gets a references root at its bottom when it has none,
	 * and an empty mirror of the source at that root's top; an item whose target is no longer linked is deleted. Mirrors,
	 * references roots and nodes no longer live are never sources. One unit of work.
	 */
	syncBacklinks(sourceIds: readonly string[]): LocalBacklinkSync
	{
		return this.write((pending, unitOfWork) =>
		{
			const {tx, systemTime} = unitOfWork;
			const result: LocalBacklinkSync =
			{
				created: [],
				referencesRoots: [],
				deleted: [],
			};
			const ended: string[] = [];
			const rootOf = new Map<string, string>();
			for (const sourceId of new Set(sourceIds))
			{
				const source = currentContent(tx, sourceId);
				if (source === undefined || isReferencesRoot(tx, sourceId) || writeTarget(tx, sourceId) !== sourceId)
				{
					continue;
				}
				const targets = new Set(
					internalLinkShortIds(`${source.name} ${source.note ?? ""}`).flatMap((shortId) =>
					{
						const id = resolveShortId(tx, shortId);
						const target = id === null ? null : writeTarget(tx, id);
						return target === null || target === sourceId ? [] : [target];
					}),
				);
				for (const item of currentBacklinkItems(tx, eq(mirrors.originalId, sourceId)))
				{
					if (targets.delete(item.targetId))
					{
						continue;
					}
					const order = pending.order(currentContent(tx, item.nodeId)?.parentId ?? null);
					order.splice(order.indexOf(item.nodeId), 1);
					ended.push(item.nodeId);
					result.deleted.push(
						{
							id: item.nodeId,
							targetId: item.targetId,
						},
					);
				}
				for (const targetId of targets)
				{
					const children = pending.order(targetId);
					let rootId = rootOf.get(targetId) ?? children.find((child) => isReferencesRoot(tx, child));
					if (rootId === undefined)
					{
						rootId = this.generateId();
						this.insertNode(
							pending,
							unitOfWork,
							{
								id: rootId,
								name: "",
								parentId: targetId,
								orderKey: null,
							},
						);
						children.push(rootId);
						pending.markPlaced(rootId);
						tx.insert(referencesRoots)
							.values(
								{
									nodeId: rootId,
									systemFrom: systemTime,
									systemTo: FAR_FUTURE_DATE,
								},
							)
							.run();
						result.referencesRoots.push(rootId);
					}
					rootOf.set(targetId, rootId);
					const itemId = this.generateId();
					this.insertNode(
						pending,
						unitOfWork,
						{
							id: itemId,
							name: "",
							parentId: rootId,
							orderKey: null,
						},
					);
					pending.order(rootId).unshift(itemId);
					pending.markPlaced(itemId);
					tx.insert(mirrors)
						.values(
							{
								mirrorId: itemId,
								originalId: sourceId,
								systemFrom: systemTime,
								systemTo: FAR_FUTURE_DATE,
							},
						)
						.run();
					result.created.push(
						{
							id: itemId,
							sourceId,
							targetId,
						},
					);
				}
			}
			endNodeComposites(unitOfWork, ended);
			return result;
		});
	}

	/** Move nodes, keeping their order, to a slot under a parent. */
	moveTo(input: LocalMoveInput): void
	{
		this.moveBlocks([input]);
	}

	/** Several {@link moveTo}s in one unit of work, in order: each is planned against the outline the earlier ones leave. */
	moveBlocks(moves: readonly LocalMoveInput[]): void
	{
		this.write((pending, {tx}) =>
		{
			this.moveInUnit(pending, tx, moves);
		});
	}

	/**
	 * Apply a calendar layout's tree writes (or the writes undoing one), in order, in one unit of work: creates with
	 * their metadata, moves and undeletes at the writes' slots, deletes of the emptied level nodes, and metadata edits
	 * patched over each node's stored metadata. Each write is planned against the outline the earlier ones leave.
	 */
	applyLayoutWrites(writes: readonly LayoutWrite[]): void
	{
		this.write((pending, unitOfWork) =>
		{
			const {tx} = unitOfWork;
			const edited = new Map<string, InternalMetadata>();
			for (const write of writes)
			{
				switch (write.op)
				{
					case "edit":
					{
						const current = edited.get(write.id) ?? readNodeInternalMetadata(tx, write.id);
						edited.set(write.id, applyMetadataPatches(current, write.patches));
						break;
					}
					case "create":
					{
						this.insertTrees(
							pending,
							unitOfWork,
							{
								parentId: write.parentId,
								index: write.index,
								trees: [
									{
										id: write.id,
										name: write.name,
										metadata: write.metadata,
									},
								],
							},
						);
						break;
					}
					case "move":
					{
						this.moveInUnit(pending, tx, [
							{
								ids: [write.id],
								parentId: write.parentId,
								index: write.index,
							},
						]);
						break;
					}
					case "delete":
					{
						this.removeNodes(
							pending,
							unitOfWork,
							{
								mirrorIds: [],
								promotions: [],
								nodeId: write.id,
							},
						);
						break;
					}
					case "undelete":
					{
						this.restoreInUnit(
							pending,
							unitOfWork,
							{
								id: write.id,
								parentId: write.parentId,
								index: write.index,
							},
						);
						break;
					}
				}
			}
			const live = [...edited].filter(([id]) => currentContent(tx, id) !== undefined);
			writeInternalMetadata(unitOfWork, new Map(live));
		});
	}

	/** {@link moveBlocks} inside a unit of work. */
	private moveInUnit(pending: PendingWrites, tx: TemporalTransaction, moves: readonly LocalMoveInput[]): void
	{
		const now = this.nowDate();
		const parentOf = new Map<string, string | null>();
		for (const move of moves)
		{
			if (move.ids.length === 0)
			{
				continue;
			}
			const target = toParent(move.parentId);
			requireParent(tx, target);
			for (const id of move.ids)
			{
				if (!parentOf.has(id))
				{
					parentOf.set(id, requireNode(tx, id).parentId);
				}
				if (target !== null && this.isInSubtree(tx, parentOf, target, id))
				{
					throw new Error(`Cannot move ${id} under its own subtree`);
				}
			}
			const order = pending.order(target);
			const index = clampIndex(move.index ?? order.length, order.length);
			const moving = new Set(move.ids);
			const before = order.slice(0, index).filter((sibling) => !moving.has(sibling));
			const after = order.slice(index).filter((sibling) => !moving.has(sibling));
			for (const id of move.ids)
			{
				const source = parentOf.get(id) ?? null;
				if (source !== target)
				{
					const sourceOrder = pending.order(source);
					sourceOrder.splice(sourceOrder.indexOf(id), 1);
					pending.setContent(
						id,
						{
							parentId: target,
						},
					);
					parentOf.set(id, target);
				}
				pending.setMetadata(
					id,
					{
						modifiedAt: now,
					},
				);
				pending.markPlaced(id);
			}
			order.splice(0, order.length, ...before, ...move.ids, ...after);
		}
	}

	/** Whether `nodeId` is `ancestorId` or below it, following moves already planned in this unit. */
	private isInSubtree(
		tx: TemporalTransaction,
		parentOf: Map<string, string | null>,
		nodeId: string,
		ancestorId: string,
	): boolean
	{
		const seen = new Set<string>();
		let current: string | null = nodeId;
		while (current !== null && !seen.has(current))
		{
			if (current === ancestorId)
			{
				return true;
			}
			seen.add(current);
			current = parentOf.has(current)
				? (parentOf.get(current) ?? null)
				: (currentContent(tx, current)?.parentId ?? null);
		}
		return false;
	}
}
