/**
 * The mirror-mode outbox drain: read the pending outbox rows, build the internal ops that bring workflowy.com up to the
 * nodes' current local state, push them in one `push_and_poll`, and close the rows once the server run echoes every op.
 *
 * Ops go out in this order: undeletes, creates (parents first, siblings in order-key order), placements, name and
 * note and metadata edits, completions, mirror links (a new mirror's link, and each original's edit listing the
 * mirrors and backlink items it gained or lost), deletes. A node's Workflowy index is its position among its current
 * local siblings that exist upstream: siblings with a pending create or placement count only once this push has sent
 * theirs. A pending delete makes the node's other rows moot, and a node created and deleted before any drain sends
 * nothing. A restored node is an undelete once its delete went out, and only a move when the delete is still pending;
 * a node restored where upstream still has it sends only the edits that differ from upstream, and no mirror link
 * upstream still holds.
 *
 * What upstream holds now is the node's local state just before its oldest pending row: every aspect still pending
 * changed after that, and none before it. It supplies the previous values the ops' undo data carries, and decides
 * which name, note, completion and metadata changes still differ from upstream.
 *
 * Failures are never retried here (Craig approved re-delivery only on the next drain trigger, 2026-11-15): a failed or
 * unacknowledged push records `last_error` on every row it carried and leaves them pending.
 */

import {and, eq, gt, isNull, lte, or, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {currentVersion} from "../cache/cache-temporal.js";
import {inIds} from "../cache/in-ids.js";
import {readInternalMetadata} from "../cache/internal-metadata.js";
import type {InternalMetadata} from "../cache/internal-metadata.js";
import {upstreamRelationshipMetadata} from "../cache/item-relationships.js";
import type {UpstreamRelationshipMetadata} from "../cache/item-relationships.js";
import {runUnitOfWork} from "../cache/node-composite.js";
import type {UnitOfWork} from "../cache/node-composite.js";
import {compareSiblingOrder} from "../cache/order-key.js";
import {closeOutboxRows, failOutboxRows, readPendingOutbox} from "../cache/outbox.js";
import type {OutboxAspect, OutboxEntry, PendingOutboxRow} from "../cache/outbox.js";
import {systemTimeJustBefore} from "../cache/subtree-history.js";
import type {TemporalTransaction} from "../cache/temporal-merge.js";
import {mirrors, nodeContent, nodeMetadata, referencesRoots} from "../db/schema.js";
import {OutboxNotAcknowledged} from "./errors.js";
import {buildMetadataChanges} from "./metadata-patch.js";
import type {MetadataChange} from "./metadata-patch.js";
import
{
	bulkCreateOp,
	clientTimestamp,
	completeOp,
	deleteOp,
	editOp,
	moveOp,
	ROOT_PROJECT_ID,
	uncompleteOp,
	undeleteOp,
} from "./ops.js";
import type {NewTree, OpClock} from "./ops.js";
import type {InternalOp, PushResult} from "./push-and-poll.js";

/** Rows one drain pass reads, rounded up to whole enqueue times. */
export const OUTBOX_BATCH_CAP = 500;

/** The account fields a drain's ops carry. */
export interface OutboxSession
{
	userId: number;
	dateJoinedSec: number;
}

/** Where a drain pushes; the internal adapter in production, a fake in tests. */
export interface OutboxPusher
{
	session(): Promise<OutboxSession>;
	/**
	 * Push `ops` in one `push_and_poll`. `accept` runs inside the unit of work that applies the push's transactions,
	 * after them and before the push resolves.
	 */
	push(ops: InternalOp[], accept: (unitOfWork: UnitOfWork, result: PushResult) => void): Promise<void>;
}

export interface OutboxDrainOptions
{
	/** Defaults to `Date.now`; the ops' client timestamps. */
	now?: () => number;
	batchCap?: number;
}

export interface OutboxDrainResult
{
	/** Ops pushed; 0 when nothing needed sending. */
	ops: number;
	/** Rows closed: delivered, moot, or created and deleted before any drain. */
	closed: number;
}

/** A live node's current local state, as the drain sends it. */
interface NodeState
{
	name: string | null;
	note: string | null;
	parentId: string | null;
	orderKey: string | null;
	createdAt: Date | null;
	completedAt: Date | null;
	metadata: InternalMetadata;
	relationships: UpstreamRelationshipMetadata;
}

/** A node's local state just before its oldest pending row: what workflowy.com holds. */
interface UpstreamState
{
	parentId: string | null;
	/** Its index among all its siblings then. */
	index: number;
	name: string | null;
	note: string | null;
	completedAt: Date | null;
	metadata: InternalMetadata;
}

interface DrainPlan
{
	ops: InternalOp[];
	/** Rows the push delivers; they close once it is acknowledged. */
	carried: PendingOutboxRow[];
	/** Each carried row's aspect value as sent; a row whose value changed before the acknowledgement stays pending. */
	sent: Map<string, string>;
	/** Rows of nodes created and deleted before any drain: closed without sending anything. */
	dropped: PendingOutboxRow[];
}

const entryKey = ({nodeId, aspect}: OutboxEntry): string => `${nodeId}\u001F${aspect}`;

const internalParent = (parentId: string | null): string => parentId ?? ROOT_PROJECT_ID;

function versionAt(table: typeof nodeContent | typeof nodeMetadata, asOf: string | undefined): SQL | undefined
{
	return asOf === undefined ? currentVersion(table) : and(lte(table.systemFrom, asOf), gt(table.systemTo, asOf));
}

/** Each live node's state, in one read per table. */
function readStates(tx: TemporalTransaction, ids: readonly string[]): Map<string, NodeState>
{
	const rows = tx
		.select(
			{
				id: nodeContent.id,
				name: nodeContent.name,
				note: nodeContent.note,
				parentId: nodeContent.parentId,
				orderKey: nodeMetadata.orderKey,
				createdAt: nodeMetadata.createdAt,
				completedAt: nodeMetadata.completedAt,
			},
		)
		.from(nodeContent)
		.leftJoin(nodeMetadata, and(eq(nodeMetadata.nodeId, nodeContent.id), currentVersion(nodeMetadata)))
		.where(and(inIds(nodeContent.id, ids), currentVersion(nodeContent)))
		.all();
	const live = rows.map(({id}) => id);
	const metadata = readInternalMetadata(tx, live);
	const relationships = upstreamRelationshipMetadata(tx, live);
	return new Map(
		rows.map((row) => [
			row.id,
			{
				name: row.name,
				note: row.note,
				parentId: row.parentId,
				orderKey: row.orderKey,
				createdAt: row.createdAt,
				completedAt: row.completedAt,
				metadata: metadata.get(row.id) ?? {},
				relationships: relationships.get(row.id) ?? {},
			},
		]),
	);
}

/** Each of `parents`' children in sibling order, live now or at `asOf`. */
function siblingsAt(
	tx: TemporalTransaction,
	parents: readonly (string | null)[],
	asOf?: string,
): Map<string | null, string[]>
{
	const result = new Map<string | null, string[]>(parents.map((parent) => [parent, []]));
	const ids = parents.filter((parent) => parent !== null);
	const conditions = [
		...(ids.length > 0 ? [inIds(nodeContent.parentId, ids)] : []),
		...(parents.includes(null) ? [isNull(nodeContent.parentId)] : []),
	];
	if (conditions.length === 0)
	{
		return result;
	}
	const rows = tx
		.select(
			{
				id: nodeContent.id,
				parentId: nodeContent.parentId,
				orderKey: nodeMetadata.orderKey,
				createdAt: nodeMetadata.createdAt,
			},
		)
		.from(nodeContent)
		.leftJoin(nodeMetadata, and(eq(nodeMetadata.nodeId, nodeContent.id), versionAt(nodeMetadata, asOf)))
		.where(and(or(...conditions), versionAt(nodeContent, asOf)))
		.all()
		.toSorted(compareSiblingOrder);
	for (const row of rows)
	{
		result.get(row.parentId)?.push(row.id);
	}
	return result;
}

/** What workflowy.com holds of each node: its local state at its `asOf`, grouped into one read set per time. */
function readUpstreamStates(tx: TemporalTransaction, asOfById: ReadonlyMap<string, string>): Map<string, UpstreamState>
{
	const result = new Map<string, UpstreamState>();
	const byTime = new Map<string, string[]>();
	for (const [id, asOf] of asOfById)
	{
		byTime.set(asOf, [...(byTime.get(asOf) ?? []), id]);
	}
	for (const [asOf, ids] of byTime)
	{
		const rows = tx
			.select(
				{
					id: nodeContent.id,
					name: nodeContent.name,
					note: nodeContent.note,
					parentId: nodeContent.parentId,
					completedAt: nodeMetadata.completedAt,
				},
			)
			.from(nodeContent)
			.leftJoin(nodeMetadata, and(eq(nodeMetadata.nodeId, nodeContent.id), versionAt(nodeMetadata, asOf)))
			.where(and(inIds(nodeContent.id, ids), versionAt(nodeContent, asOf)))
			.all();
		const metadata = readInternalMetadata(tx, ids, asOf);
		const siblings = siblingsAt(tx, [...new Set(rows.map(({parentId}) => parentId))], asOf);
		for (const row of rows)
		{
			result.set(
				row.id,
				{
					parentId: row.parentId,
					index: siblings.get(row.parentId)?.indexOf(row.id) ?? 0,
					name: row.name,
					note: row.note,
					completedAt: row.completedAt,
					metadata: metadata.get(row.id) ?? {},
				},
			);
		}
	}
	return result;
}

/** Each aspect's value as a push carries it for a live node. */
const ASPECT_VALUES: Readonly<Record<OutboxAspect, (state: NodeState) => unknown>> =
{
	create: (state) => state,
	name: (state) => state.name,
	note: (state) => state.note,
	placement: (state) => [state.parentId, state.orderKey],
	completion: (state) => state.completedAt?.getTime() ?? null,
	metadata: (state) => state.metadata,
	mirror: (state) => state.relationships.mirror ?? null,
	delete: (state) => state,
};

/** The value of `aspect` a push carries for a node; `undefined` state means the node is not live. */
function aspectValue(aspect: OutboxAspect, state: NodeState | undefined): string
{
	return state === undefined ? "gone" : JSON.stringify(ASPECT_VALUES[aspect](state));
}

/** The metadata changes that take upstream's kept metadata to the local one; `priority` changes leaf by leaf. */
function metadataChanges(upstream: InternalMetadata, local: InternalMetadata): MetadataChange[]
{
	const keys = [...new Set([...Object.keys(upstream), ...Object.keys(local)])].toSorted();
	return keys.flatMap((key): MetadataChange[] =>
	{
		if (JSON.stringify(upstream[key]) === JSON.stringify(local[key]))
		{
			return [];
		}
		if (key === "priority")
		{
			const value: unknown = local.priority;
			return [
				{
					path: ["priority", "defaultToBottom"],
					value:
						typeof value === "object" && value !== null ? Reflect.get(value, "defaultToBottom") : undefined,
				},
			];
		}
		return [
			{
				path: [key],
				value: local[key],
			},
		];
	});
}

/** `relationships` without the given mirror ids under either of its mirror root lists. */
function withoutMirrorRoots(
	relationships: UpstreamRelationshipMetadata,
	mirrorIds: ReadonlySet<string>,
): Record<string, unknown>
{
	const {mirror, ...rest} = relationships;
	if (mirror === undefined)
	{
		return rest;
	}
	const kept: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(mirror))
	{
		if (key === "mirrorRootIds" || key === "backlinkMirrorRootIds")
		{
			const ids = Object.keys(value).filter((id) => !mirrorIds.has(id));
			if (ids.length > 0)
			{
				kept[key] = Object.fromEntries(ids.map((id) => [id, true]));
			}
		}
		else
		{
			kept[key] = value;
		}
	}
	return Object.keys(kept).length === 0
		? rest
		:
			{
				...rest,
				mirror: kept,
			};
}

type MirrorRootField = "mirrorRootIds" | "backlinkMirrorRootIds";

const mirrorRootField = (backlink: boolean): MirrorRootField => (backlink ? "backlinkMirrorRootIds" : "mirrorRootIds");

function asRecord(value: unknown): Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value)
		?
			{
				...value,
			}
		: {};
}

/** `relationships` with each `[field, mirrorId]` listed under that mirror root list. */
function withMirrorRoots(
	relationships: Record<string, unknown>,
	roots: readonly (readonly [MirrorRootField, string])[],
): Record<string, unknown>
{
	if (roots.length === 0)
	{
		return relationships;
	}
	const mirror = asRecord(relationships.mirror);
	for (const [field, mirrorId] of roots)
	{
		mirror[field] =
		{
			...asRecord(mirror[field]),
			[mirrorId]: true,
		};
	}
	return {
		...relationships,
		mirror,
	};
}

/** A mirror an original listed upstream that no longer mirrors it locally. */
interface RemovedMirror
{
	mirrorId: string;
	/** Whether it was a backlink item: its parent then was a references root. */
	backlink: boolean;
}

/**
 * The mirrors each original had at its `asOf` (what workflowy.com lists on it) that are gone locally now, grouped
 * into one read set per time.
 */
function removedMirrors(tx: TemporalTransaction, asOfById: ReadonlyMap<string, string>): Map<string, RemovedMirror[]>
{
	const result = new Map<string, RemovedMirror[]>();
	const byTime = new Map<string, string[]>();
	for (const [id, asOf] of asOfById)
	{
		byTime.set(asOf, [...(byTime.get(asOf) ?? []), id]);
	}
	for (const [asOf, ids] of byTime)
	{
		const then = tx
			.select(
				{
					mirrorId: mirrors.mirrorId,
					originalId: mirrors.originalId,
				},
			)
			.from(mirrors)
			.where(and(inIds(mirrors.originalId, ids), lte(mirrors.systemFrom, asOf), gt(mirrors.systemTo, asOf)))
			.all();
		const live = new Set(
			tx
				.select(
					{
						mirrorId: mirrors.mirrorId,
					},
				)
				.from(mirrors)
				.where(and(inIds(mirrors.originalId, ids), currentVersion(mirrors)))
				.all()
				.map(({mirrorId}) => mirrorId),
		);
		const gone = then.filter(({mirrorId}) => !live.has(mirrorId));
		if (gone.length === 0)
		{
			continue;
		}
		const parents = new Map(
			tx
				.select(
					{
						id: nodeContent.id,
						parentId: nodeContent.parentId,
					},
				)
				.from(nodeContent)
				.where(
					and(
						inIds(
							nodeContent.id,
							gone.map(({mirrorId}) => mirrorId),
						),
						versionAt(nodeContent, asOf),
					),
				)
				.all()
				.map(({id, parentId}) => [id, parentId]),
		);
		const parentIds = [...parents.values()].filter((parentId) => parentId !== null);
		const roots = new Set(
			parentIds.length === 0
				? []
				: tx
						.select(
							{
								nodeId: referencesRoots.nodeId,
							},
						)
						.from(referencesRoots)
						.where(
							and(
								inIds(referencesRoots.nodeId, parentIds),
								lte(referencesRoots.systemFrom, asOf),
								gt(referencesRoots.systemTo, asOf),
							),
						)
						.all()
						.map(({nodeId}) => nodeId),
		);
		for (const {mirrorId, originalId} of gone)
		{
			const parentId = parents.get(mirrorId) ?? null;
			result.set(originalId, [
				...(result.get(originalId) ?? []),
				{
					mirrorId,
					backlink: parentId !== null && roots.has(parentId),
				},
			]);
		}
	}
	return result;
}

/**
 * Which of the nodes with a pending create row are restores: the node had a version before the row was enqueued, so
 * it existed (and upstream knew it) before a delete.
 */
function restoredNodes(tx: TemporalTransaction, creates: readonly PendingOutboxRow[]): Set<string>
{
	if (creates.length === 0)
	{
		return new Set();
	}
	const first = new Map(
		tx
			.select(
				{
					id: nodeContent.id,
					since: sql<string>`min(${nodeContent.systemFrom})`,
				},
			)
			.from(nodeContent)
			.where(
				inIds(
					nodeContent.id,
					creates.map(({nodeId}) => nodeId),
				),
			)
			.groupBy(nodeContent.id)
			.all()
			.map(({id, since}) => [id, since]),
	);
	return new Set(
		creates
			.filter(({nodeId, enqueuedAt}) => (first.get(nodeId) ?? enqueuedAt) < enqueuedAt)
			.map(({nodeId}) => nodeId),
	);
}

/**
 * Which mirrors' links were live at their `asOf`: every change to a link leaves a pending row on its mirror or its
 * original, so the link as of just before the older of the two nodes' oldest pending rows is what upstream holds.
 */
function upstreamLinks(
	tx: TemporalTransaction,
	links: readonly
	{
		mirrorId: string;
		originalId: string;
		asOf: string;
	}[],
): Set<string>
{
	return new Set(
		links
			.filter(
				({mirrorId, originalId, asOf}) =>
					tx
						.select(
							{
								mirrorId: mirrors.mirrorId,
							},
						)
						.from(mirrors)
						.where(
							and(
								eq(mirrors.mirrorId, mirrorId),
								eq(mirrors.originalId, originalId),
								lte(mirrors.systemFrom, asOf),
								gt(mirrors.systemTo, asOf),
							),
						)
						.get() !== undefined,
			)
			.map(({mirrorId}) => mirrorId),
	);
}

/** Build the push for `rows` from the nodes' current local state. */
function planDrain(
	tx: TemporalTransaction,
	rows: readonly PendingOutboxRow[],
	session: OutboxSession,
	now: number,
): DrainPlan
{
	const clock: OpClock =
	{
		now,
		dateJoinedSec: session.dateJoinedSec,
	};
	const aspectsOf = new Map<string, Set<OutboxAspect>>();
	const oldest = new Map<string, string>();
	for (const row of rows)
	{
		let aspects = aspectsOf.get(row.nodeId);
		if (aspects === undefined)
		{
			aspects = new Set();
			aspectsOf.set(row.nodeId, aspects);
			oldest.set(row.nodeId, row.enqueuedAt);
		}
		aspects.add(row.aspect);
	}
	const ids = [...aspectsOf.keys()];
	const has = (id: string, aspect: OutboxAspect): boolean => aspectsOf.get(id)?.has(aspect) === true;
	const states = readStates(tx, ids);

	const droppedIds = new Set(ids.filter((id) => has(id, "create") && !states.has(id)));
	const restored = restoredNodes(
		tx,
		rows.filter(({nodeId, aspect}) => aspect === "create" && states.has(nodeId)),
	);
	// A node deleted and restored before any drain is still live upstream: its delete never went out.
	const revived = new Set([...restored].filter((id) => has(id, "delete")));
	// A restore of a node whose delete went out is an undelete there, which brings back its subtree with it.
	const undeleted = [...restored].filter((id) => !revived.has(id) && has(id, "placement"));
	const created = new Set(ids.filter((id) => has(id, "create") && states.has(id) && !restored.has(id)));
	const placed = ids.filter(
		(id) => has(id, "placement") && states.has(id) && !created.has(id) && !undeleted.includes(id),
	);
	const upstream = readUpstreamStates(
		tx,
		new Map(
			ids
				.filter((id) => !has(id, "create") || revived.has(id))
				.map((id) => [id, systemTimeJustBefore(oldest.get(id) ?? "")] as const),
		),
	);

	const ops: InternalOp[] = [];
	const notUpstream = new Set([...created, ...placed, ...undeleted]);
	const parentOf = (id: string): string | null => states.get(id)?.parentId ?? null;
	const parentOrder = [...new Set([...created, ...placed, ...undeleted].map(parentOf))];
	const siblings = siblingsAt(tx, [...parentOrder, ...created]);
	const childrenOf = (parent: string | null): string[] => siblings.get(parent) ?? [];
	/** The node's index among its parent's children that exist upstream, itself excluded. */
	const slot = (id: string): number =>
	{
		const order = childrenOf(parentOf(id));
		return order.slice(0, order.indexOf(id)).filter((sibling) => !notUpstream.has(sibling)).length;
	};

	const undeletedSet = new Set(undeleted);
	for (const parent of parentOrder)
	{
		for (const id of childrenOf(parent))
		{
			if (undeletedSet.has(id))
			{
				ops.push(
					undeleteOp(
						{
							...clock,
							id,
							parentId: internalParent(parent),
							index: slot(id),
						},
					),
				);
				notUpstream.delete(id);
			}
		}
	}

	const create = (id: string): void =>
	{
		const state = states.get(id);
		if (state === undefined)
		{
			return;
		}
		const metadata =
		{
			...state.metadata,
			...state.relationships,
		};
		const tree: NewTree =
		{
			id,
			name: state.name ?? "",
			...(state.note === null
				? {}
				:
					{
						note: state.note,
					}),
			...(Object.keys(metadata).length === 0
				? {}
				:
					{
						metadata,
					}),
			...(state.completedAt === null
				? {}
				:
					{
						completed: true,
					}),
		};
		ops.push(
			bulkCreateOp(
				{
					...clock,
					parentId: internalParent(state.parentId),
					index: slot(id),
					trees: [tree],
					userId: session.userId,
				},
			).op,
		);
		notUpstream.delete(id);
		for (const child of childrenOf(id))
		{
			if (created.has(child))
			{
				create(child);
			}
		}
	};
	for (const parent of parentOrder)
	{
		if (parent !== null && created.has(parent))
		{
			continue;
		}
		for (const id of childrenOf(parent))
		{
			if (created.has(id))
			{
				create(id);
			}
		}
	}

	const placedSet = new Set(placed);
	for (const parent of parentOrder)
	{
		for (const id of childrenOf(parent))
		{
			if (!placedSet.has(id))
			{
				continue;
			}
			const index = slot(id);
			const before = upstream.get(id);
			const from =
				before === undefined
					?
						{
							parentId: internalParent(parent),
							index,
						}
					:
						{
							parentId: internalParent(before.parentId),
							index: before.index,
						};
			notUpstream.delete(id);
			if (before?.parentId === parent && before.index === index)
			{
				// Already there upstream, as for a node deleted and restored in place before any drain.
				continue;
			}
			const sameParentBefore = before?.parentId === parent && before.index <= index;
			ops.push(
				moveOp(
					{
						...clock,
						id,
						parentId: internalParent(parent),
						// moveOp takes the slot before the node leaves its old one.
						index: sameParentBefore ? index + 1 : index,
						from,
					},
				),
			);
		}
	}

	const edited = ids.filter((id) => states.has(id) && !created.has(id));
	for (const id of edited)
	{
		const state = states.get(id);
		const before = upstream.get(id);
		if (state === undefined)
		{
			continue;
		}
		const name = has(id, "name") && state.name !== before?.name ? (state.name ?? "") : undefined;
		const note = has(id, "note") && state.note !== before?.note ? (state.note ?? "") : undefined;
		const {patches, inverse} = has(id, "metadata")
			? buildMetadataChanges(before?.metadata ?? {}, metadataChanges(before?.metadata ?? {}, state.metadata))
			:
				{
					patches: [],
					inverse: [],
				};
		if (name === undefined && note === undefined && patches.length === 0)
		{
			continue;
		}
		ops.push(
			editOp(
				{
					...clock,
					id,
					...(name === undefined
						? {}
						:
							{
								name,
							}),
					...(note === undefined
						? {}
						:
							{
								note,
							}),
					metadataPatches: patches,
					metadataInversePatches: inverse,
					previous:
					{
						name: before?.name ?? "",
						note: before?.note ?? "",
					},
				},
			),
		);
	}
	for (const id of edited)
	{
		const state = states.get(id);
		const before = upstream.get(id);
		const completed = state?.completedAt !== null;
		const wasCompleted = before !== undefined && before.completedAt !== null;
		if (!has(id, "completion") || completed === wasCompleted)
		{
			continue;
		}
		const input =
		{
			...clock,
			id,
			previousCompleted:
				before?.completedAt === null || before === undefined
					? (false as const)
					: clientTimestamp(
							{
								now: before.completedAt.getTime(),
								dateJoinedSec: session.dateJoinedSec,
							},
						),
		};
		ops.push(completed ? completeOp(input) : uncompleteOp(input));
	}

	const originalOf = (id: string): string => states.get(id)?.relationships.mirror?.originalId ?? "";
	const linkedUpstream = upstreamLinks(
		tx,
		ids
			.filter((id) => has(id, "mirror") && !created.has(id) && originalOf(id) !== "")
			.map((id) =>
			{
				const times = [oldest.get(id), oldest.get(originalOf(id))].filter((time) => time !== undefined);
				return {
					mirrorId: id,
					originalId: originalOf(id),
					asOf: systemTimeJustBefore(times.toSorted()[0] ?? ""),
				};
			}),
	);
	// A link upstream already holds, as when a delete that unlinked it was undone before any drain, sends nothing.
	const linked = ids.filter((id) => has(id, "mirror") && originalOf(id) !== "" && !linkedUpstream.has(id));
	const added = new Map<string, string[]>();
	for (const id of linked)
	{
		const originalId = originalOf(id);
		if (!created.has(id))
		{
			const {patches, inverse} = buildMetadataChanges({}, [
				{
					path: ["mirror", "originalId"],
					value: originalId,
				},
				{
					path: ["mirror", "isMirrorRoot"],
					value: true,
				},
			]);
			ops.push(
				editOp(
					{
						...clock,
						id,
						metadataPatches: patches,
						metadataInversePatches: inverse,
					},
				),
			);
		}
		if (!created.has(originalId))
		{
			added.set(originalId, [...(added.get(originalId) ?? []), id]);
		}
	}
	// An original with a pending mirror change of its own lost the mirrors upstream still lists on it.
	const removed = removedMirrors(
		tx,
		new Map(
			ids
				.filter(
					(id) =>
						has(id, "mirror") &&
						!created.has(id) &&
						states.has(id) &&
						states.get(id)?.relationships.mirror?.originalId === undefined,
				)
				.map((id) => [id, systemTimeJustBefore(oldest.get(id) ?? "")] as const),
		),
	);
	const originalIds = [...new Set([...added.keys(), ...removed.keys()])];
	const originals = upstreamRelationshipMetadata(tx, originalIds);
	for (const originalId of originalIds)
	{
		const adds = added.get(originalId) ?? [];
		const drops = removed.get(originalId) ?? [];
		const isBacklink = (mirrorId: string) => states.get(mirrorId)?.relationships.backlink !== undefined;
		const base = withMirrorRoots(
			withoutMirrorRoots(originals.get(originalId) ?? {}, new Set(adds)),
			drops.map(({mirrorId, backlink}) => [mirrorRootField(backlink), mirrorId] as const),
		);
		const {patches, inverse} = buildMetadataChanges(base, [
			...adds.map((mirrorId) => (
			{
				path: ["mirror", mirrorRootField(isBacklink(mirrorId)), mirrorId],
				value: true as unknown,
			})),
			...drops.map(({mirrorId, backlink}) => (
			{
				path: ["mirror", mirrorRootField(backlink), mirrorId],
				value: undefined,
			})),
		]);
		if (patches.length === 0)
		{
			continue;
		}
		ops.push(
			editOp(
				{
					...clock,
					id: originalId,
					metadataPatches: patches,
					metadataInversePatches: inverse,
				},
			),
		);
	}

	const deleted = new Set(ids.filter((id) => has(id, "delete") && !states.has(id) && !droppedIds.has(id)));
	for (const id of deleted)
	{
		const before = upstream.get(id);
		if (before === undefined || (before.parentId !== null && deleted.has(before.parentId)))
		{
			continue;
		}
		ops.push(
			deleteOp(
				{
					...clock,
					id,
					from:
					{
						parentId: internalParent(before.parentId),
						index: before.index,
					},
				},
			),
		);
	}

	const carried = rows.filter(({nodeId}) => !droppedIds.has(nodeId));
	return {
		ops,
		carried,
		sent: new Map(carried.map((row) => [entryKey(row), aspectValue(row.aspect, states.get(row.nodeId))])),
		dropped: rows.filter(({nodeId}) => droppedIds.has(nodeId)),
	};
}

/** The node an op names: its `projectid`, or a `bulk_create`'s first tree id. */
function opSubject(op: InternalOp): unknown
{
	if (op.type !== "bulk_create")
	{
		return op.data.projectid;
	}
	const trees: unknown =
		typeof op.data.project_trees === "string" ? JSON.parse(op.data.project_trees) : op.data.project_trees;
	return Array.isArray(trees) ? Reflect.get(Object(trees[0]), "id") : undefined;
}

/** How many of `sent` the server run echoes, in order, matched by type and subject. */
export function echoedCount(sent: readonly InternalOp[], serverRun: readonly InternalOp[]): number
{
	let matched = 0;
	for (const op of serverRun)
	{
		const next = sent[matched];
		if (next !== undefined && op.type === next.type && opSubject(op) === opSubject(next))
		{
			matched += 1;
		}
	}
	return matched;
}

/** Close the carried rows whose value is still the one the push sent, in the acknowledging unit of work. */
function closeDelivered(unitOfWork: UnitOfWork, plan: DrainPlan): number
{
	const states = readStates(unitOfWork.tx, [...new Set(plan.carried.map(({nodeId}) => nodeId))]);
	const delivered = plan.carried.filter(
		(row) => plan.sent.get(entryKey(row)) === aspectValue(row.aspect, states.get(row.nodeId)),
	);
	closeOutboxRows(unitOfWork, delivered);
	return delivered.length;
}

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}

/**
 * One drain pass over the oldest pending outbox rows: one push, or none when nothing needs sending. On acknowledgement
 * the carried rows close in the unit of work that applies the push's transactions. A failed or unacknowledged push
 * records its error as `last_error` on every row it carried, which stay pending, and throws; a failed session fetch
 * records its error on every row the pass read.
 */
export async function drainOutbox(
	database: TemporalTransaction,
	pusher: OutboxPusher,
	options: OutboxDrainOptions = {},
): Promise<OutboxDrainResult>
{
	const cap = options.batchCap ?? OUTBOX_BATCH_CAP;
	const now = options.now ?? Date.now;
	if (readPendingOutbox(database, cap).length === 0)
	{
		return {
			ops: 0,
			closed: 0,
		};
	}
	let session: OutboxSession;
	try
	{
		session = await pusher.session();
	}
	catch (error)
	{
		runUnitOfWork(database, (unitOfWork) =>
		{
			failOutboxRows(unitOfWork, readPendingOutbox(unitOfWork.tx, cap), errorMessage(error));
		});
		throw error;
	}
	const plan = runUnitOfWork(database, (unitOfWork) =>
	{
		const planned = planDrain(unitOfWork.tx, readPendingOutbox(unitOfWork.tx, cap), session, now());
		closeOutboxRows(unitOfWork, planned.dropped);
		if (planned.ops.length === 0)
		{
			closeOutboxRows(unitOfWork, planned.carried);
		}
		return planned;
	});
	if (plan.ops.length === 0)
	{
		return {
			ops: 0,
			closed: plan.dropped.length + plan.carried.length,
		};
	}
	let closed = 0;
	let unacknowledged: OutboxNotAcknowledged | undefined;
	try
	{
		await pusher.push(plan.ops, (unitOfWork, result) =>
		{
			const echoed = echoedCount(plan.ops, result.serverRun);
			if (echoed === plan.ops.length)
			{
				closed = closeDelivered(unitOfWork, plan);
				return;
			}
			unacknowledged = new OutboxNotAcknowledged(plan.ops.length, echoed);
			failOutboxRows(unitOfWork, plan.carried, unacknowledged.message);
		});
	}
	catch (error)
	{
		runUnitOfWork(database, (unitOfWork) =>
		{
			failOutboxRows(unitOfWork, plan.carried, errorMessage(error));
		});
		throw error;
	}
	if (unacknowledged !== undefined)
	{
		throw unacknowledged;
	}
	return {
		ops: plan.ops.length,
		closed: closed + plan.dropped.length,
	};
}
