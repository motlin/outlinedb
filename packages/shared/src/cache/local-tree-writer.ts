import {and, asc, desc, eq, isNull, lte, gt, ne, sql} from "drizzle-orm";
import type {AnySQLiteColumn} from "drizzle-orm/sqlite-core";
import {account, mirrors, nodeContent, nodeMetadata, rootPreferences} from "../db/schema.js";
import type {AppDatabase} from "../db/types.js";
import type {NewTree} from "../internal/ops.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {HOME_TARGET} from "../types/targets.js";
import {uuidToShortId} from "../workflowy/constants.js";
import {AccountNotProvisionedError} from "./account-store.js";
import {currentVersion, normalizeLayoutMode} from "./cache-temporal.js";
import {readNodeInternalMetadata, writeInternalMetadata} from "./internal-metadata.js";
import type {InternalMetadata} from "./internal-metadata.js";
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

export interface LocalTreeWriterOptions
{
	/** The clock, in milliseconds; node timestamps are stored in whole seconds of it. */
	now?: () => number;
	generateId?: () => string;
}

type MetadataRow = typeof nodeMetadata.$inferSelect;
type ContentRow = typeof nodeContent.$inferSelect;
type MetadataPatch = Partial<Pick<MetadataRow, "priority" | "modifiedAt" | "completedAt" | "layoutMode">>;
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

	/** Renumber every touched parent's children 0..n-1, then write each changed row once. */
	flush(systemTime: string): void
	{
		for (const order of this.orders.values())
		{
			for (const [priority, id] of order.entries())
			{
				this.setMetadata(
					id,
					{
						priority,
					},
				);
			}
		}
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

/** A parent's current children ids (Home's for null) in sort order: priority, then createdAt. */
function currentChildIds(tx: TemporalTransaction, parentId: string | null): string[]
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
			sql`coalesce(${nodeMetadata.priority}, 0)`,
			sql`coalesce(${nodeMetadata.createdAt}, 0)`,
			asc(nodeContent.id),
		)
		.all()
		.map((row) => row.id);
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

/** `id` and every current descendant, breadth-first. */
function subtreeIds(tx: TemporalTransaction, id: string): string[]
{
	const ids = [id];
	// for-of visits elements pushed during the loop, so this walks every level.
	for (const parentId of ids)
	{
		for (const child of tx
			.select(
				{
					id: nodeContent.id,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.parentId, parentId), currentVersion(nodeContent)))
			.all())
		{
			ids.push(child.id);
		}
	}
	return ids;
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
 * tables. Each write is one unit of work. Sibling order is `node_metadata.priority`: after a write, every touched
 * parent's children are renumbered 0..n-1, and only rows whose values changed get a new version.
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
		return this.write((pending, {tx, systemTime}) =>
		{
			requireParent(tx, parentId);
			if (currentContent(tx, id) !== undefined)
			{
				throw new Error(`Node ${id} already exists`);
			}
			const order = pending.order(parentId);
			const index = anchoredSlot(order, input.afterId, input.index);
			order.splice(index, 0, id);
			const now = this.nowDate();
			tx.insert(nodeContent)
				.values(
					{
						id,
						name: input.name,
						note: noteOrNull(input.note),
						parentId,
						systemFrom: systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			tx.insert(nodeMetadata)
				.values(
					{
						nodeId: id,
						shortId: uuidToShortId(id),
						priority: index,
						createdAt: now,
						modifiedAt: now,
						completedAt: null,
						layoutMode: normalizeLayoutMode(input.layoutMode),
						systemFrom: systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
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
		const parentId = toParent(input.parentId);
		return this.write((pending, unitOfWork) =>
		{
			const {tx, systemTime} = unitOfWork;
			requireParent(tx, parentId);
			const now = this.nowDate();
			const metadataById = new Map<string, InternalMetadata | undefined>();
			const insert = (tree: NewTree, treeParent: string | null, priority: number): string =>
			{
				const id = tree.id ?? this.generateId();
				if (currentContent(tx, id) !== undefined)
				{
					throw new Error(`Node ${id} already exists`);
				}
				const metadata = tree.metadata ?? {};
				const layoutMode = typeof metadata.layoutMode === "string" ? metadata.layoutMode : null;
				tx.insert(nodeContent)
					.values(
						{
							id,
							name: tree.name,
							note: noteOrNull(tree.note),
							parentId: treeParent,
							systemFrom: systemTime,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
				tx.insert(nodeMetadata)
					.values(
						{
							nodeId: id,
							shortId: uuidToShortId(id),
							priority,
							createdAt: now,
							modifiedAt: now,
							completedAt: tree.completed === true ? now : null,
							layoutMode: normalizeLayoutMode(layoutMode),
							systemFrom: systemTime,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
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
				for (const [childPriority, child] of (tree.children ?? []).entries())
				{
					insert(child, id, childPriority);
				}
				return id;
			};
			const order = pending.order(parentId);
			const index = anchoredSlot(order, input.afterId, input.index);
			const ids = input.trees.map((tree, offset) => insert(tree, parentId, index + offset));
			order.splice(index, 0, ...ids);
			writeInternalMetadata(unitOfWork, metadataById);
			return {
				ids,
			};
		});
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
		return this.write((pending, unitOfWork) =>
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
				input.index ??
					(input.parentId === undefined ? (root.metadata?.priority ?? order.length) : order.length),
				order.length,
			);
			const subtree = readSubtreeAt(tx, input.id, asOf);
			const restored: string[] = [];
			const reopen = (id: string, nodeParent: string | null, priority: number): void =>
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
								priority,
								systemFrom: systemTime,
								systemTo: FAR_FUTURE_DATE,
							},
						)
						.run();
				}
				restored.push(id);
				for (const [childPriority, childId] of (subtree.children.get(id) ?? []).entries())
				{
					reopen(childId, id, childPriority);
				}
			};
			reopen(input.id, parentId, index);
			order.splice(index, 0, input.id);
			writeInternalMetadata(unitOfWork, new Map(restored.map((id) => [id, subtree.metadata.get(id)])));
			this.reopenMirrors(unitOfWork, restored, asOf);
			return true;
		});
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

	/** Delete a node with its whole subtree and the mirror rows of every node in it, then close the gap it leaves. */
	deleteNode(id: string): void
	{
		this.write((pending, unitOfWork) =>
		{
			const node = requireNode(unitOfWork.tx, id);
			const order = pending.order(node.parentId);
			order.splice(order.indexOf(id), 1);
			endNodeComposites(unitOfWork, subtreeIds(unitOfWork.tx, id));
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
				}
				order.splice(0, order.length, ...before, ...move.ids, ...after);
			}
		});
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
