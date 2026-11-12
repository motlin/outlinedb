import type {CacheService, SubtreeMirrors} from "./cache-service.js";
import {planBlockSlot} from "./slot-plan.js";

/** A parent's children ids in their current Workflowy order (roots for null). */
export type ChildOrder = (parentId: string | null) => Promise<string[]>;

/**
 * An original inside a deleted subtree kept the way the Workflowy web app keeps
 * it: one of its mirrors outside the subtree is removed, and the original, with
 * its children, is moved into that mirror's place. Its other mirrors keep
 * mirroring it where it now lives.
 */
export interface MirrorPromotion
{
	/** The original that is kept. */
	originalId: string;
	/** The mirror removed through DELETE /nodes/:id/mirror to make room for it. */
	mirrorId: string;
	/** The mirror's parent, which the original is moved to. */
	parentId: string | null;
	/** The end of the parent the original is moved to; the REST move takes only 'top' or 'bottom' (verified live). */
	position: "top" | "bottom";
	/**
	 * Siblings then moved to the same end, in order, so the original lands in
	 * the mirror's exact slot. `position` is the end nearer the slot, so this is
	 * the shorter of the two sibling runs. The REST API cannot place a node at
	 * an index: move rejects a numeric position and move and update ignore
	 * `priority` (verified live on 2026-09-30).
	 */
	siblingIds: string[];
	/**
	 * The mirror's slot among its parent's children once it is removed, for an
	 * exact-index move (the internal API) that replaces the original-plus-siblings
	 * run: the count of children before it that are still there then.
	 */
	index: number;
}

/** The API calls {@link WorkflowyWriteThroughClient.deleteNode} makes for one delete, in order. */
export interface DeletePlan
{
	/** Mirrors inside the deleted part of the subtree, removed first through DELETE /nodes/:id/mirror. */
	mirrorIds: string[];
	/** Originals kept by moving them into a mirror's place, carried out next. */
	promotions: MirrorPromotion[];
	/** The node then removed through the generic DELETE /nodes/:id, or null when the target is a mirror or is itself kept. */
	nodeId: string | null;
}

/** One API call of a {@link DeletePlan}; `path` is relative to /api/v1. */
export interface DeletePlanCall
{
	method: "DELETE" | "POST";
	path: string;
	body?:
	{
		parent_id: string | null;
		position: "top" | "bottom";
	};
}

/** Every mutating API call a plan makes, in order (the GETs that refresh the cache after a move are left out). */
export function deletePlanCalls(plan: DeletePlan): DeletePlanCall[]
{
	const calls: DeletePlanCall[] = plan.mirrorIds.map((id) => (
	{
		method: "DELETE",
		path: `/nodes/${id}/mirror`,
	}));
	for (const {mirrorId, originalId, parentId, position, siblingIds} of plan.promotions)
	{
		calls.push(
			{
				method: "DELETE",
				path: `/nodes/${mirrorId}/mirror`,
			},
		);
		for (const id of [originalId, ...siblingIds])
		{
			calls.push(
				{
					method: "POST",
					path: `/nodes/${id}/move`,
					body:
					{
						parent_id: parentId,
						position,
					},
				},
			);
		}
	}
	if (plan.nodeId !== null)
	{
		calls.push(
			{
				method: "DELETE",
				path: `/nodes/${plan.nodeId}`,
			},
		);
	}
	return calls;
}

/**
 * Plan the delete of non-mirror `nodeId` from its cached subtree, placing each
 * kept original by the sibling order `childOrder` gives for its mirror's parent.
 * The cached order can be stale, so callers pass the live one.
 *
 * An original in the subtree with a mirror outside the part being deleted is
 * kept, as the web app does, and so is everything under it. Keeping one can
 * leave another original's mirror outside the deleted part (inside the kept
 * subtree), so originals are rechecked until none changes. Originals are
 * checked breadth-first, and promotions run in the order they were found.
 *
 * With several candidate mirrors, the one with the lowest id (plain string
 * comparison) is used. The web app uses the first key of its in-memory
 * `mirrorRootIds`, which a fresh page load sorts by mirror id; verified live
 * against the web UI on 2026-09-30, where it disagreed with both outline and
 * creation order. A long-open tab can pick differently, since live-synced
 * mirrors are added to the front, so the fresh-load rule is the one followed.
 */
export async function planSubtreeDelete(
	cacheService: CacheService,
	nodeId: string,
	childOrder: ChildOrder,
): Promise<DeletePlan>
{
	const subtree = cacheService.getSubtreeMirrors(nodeId);
	const kept = findKeptOriginals(nodeId, subtree);
	const deleted = (id: string) => isDeleted(id, nodeId, subtree.parents, kept);

	const chosen = new Map<string, string>();
	for (const [originalId, candidates] of kept)
	{
		chosen.set(
			originalId,
			candidates.reduce((lowest, id) => (id < lowest ? id : lowest)),
		);
	}

	// Removed before any promotion, so they no longer count toward a slot.
	const removedFirst = new Set(subtree.inside.filter(deleted));
	const outline = new OutlineSimulation(childOrder);
	const pendingMirrors = new Set(chosen.values());
	const promotions: MirrorPromotion[] = [];
	for (const [originalId, mirrorId] of chosen)
	{
		const parentId = cacheService.getNode(mirrorId)?.parentId ?? null;
		const siblings = (await outline.children(parentId)).filter(
			(id) => id === mirrorId || (id !== originalId && !deleted(id) && !pendingMirrors.has(id)),
		);
		const slot = siblings.indexOf(mirrorId);
		const others = siblings.filter((id) => id !== mirrorId);
		const {position, siblingIds} = planBlockSlot(others, [originalId], slot === -1 ? others.length : slot);
		const live = await outline.children(parentId);
		const index = live.slice(0, Math.max(live.indexOf(mirrorId), 0)).filter((id) => !removedFirst.has(id)).length;

		pendingMirrors.delete(mirrorId);
		outline.remove(mirrorId);
		for (const id of [originalId, ...siblingIds])
		{
			await outline.move(id, parentId, position);
		}
		promotions.push(
			{
				originalId,
				mirrorId,
				parentId,
				position,
				siblingIds,
				index,
			},
		);
	}

	return {
		mirrorIds: [...removedFirst],
		promotions,
		nodeId: kept.has(nodeId) ? null : nodeId,
	};
}

/**
 * The originals kept, in the order found, each with its candidate mirrors:
 * those outside the part still deleted once every kept original is known.
 */
function findKeptOriginals(nodeId: string, subtree: SubtreeMirrors): Map<string, string[]>
{
	const kept = new Map<string, string[]>();
	let changed = true;
	while (changed)
	{
		changed = false;
		for (const [originalId, mirrorIds] of subtree.mirrorsOf)
		{
			if (!isDeleted(originalId, nodeId, subtree.parents, kept))
			{
				continue;
			}
			if (mirrorIds.some((id) => !isDeleted(id, nodeId, subtree.parents, kept)))
			{
				kept.set(originalId, []);
				changed = true;
			}
		}
	}
	for (const [originalId, mirrorIds] of subtree.mirrorsOf)
	{
		if (!kept.has(originalId))
		{
			continue;
		}
		kept.set(
			originalId,
			mirrorIds.filter((id) => !isDeleted(id, nodeId, subtree.parents, kept)),
		);
	}
	return kept;
}

/** Whether `id` is in the subtree of `nodeId` and not under (or itself) a kept original. */
function isDeleted(id: string, nodeId: string, parents: Map<string, string>, kept: Map<string, unknown>): boolean
{
	if (id !== nodeId && !parents.has(id))
	{
		return false;
	}
	for (let current: string | undefined = id; current !== undefined; current = parents.get(current))
	{
		if (kept.has(current))
		{
			return false;
		}
	}
	return true;
}

/**
 * The children of the parents a plan touches, updated as each planned
 * removal and move is applied, so a later promotion into the same parent sees
 * the siblings as they will be by then.
 */
class OutlineSimulation
{
	private readonly lists = new Map<string | null, string[]>();
	private readonly touched = new Set<string>();

	constructor(private readonly childOrder: ChildOrder)
	{
	}

	async children(parentId: string | null): Promise<string[]>
	{
		let list = this.lists.get(parentId);
		if (list === undefined)
		{
			list = (await this.childOrder(parentId)).filter((id) => !this.touched.has(id));
			this.lists.set(parentId, list);
		}
		return list;
	}

	remove(id: string): void
	{
		this.touched.add(id);
		for (const list of this.lists.values())
		{
			const index = list.indexOf(id);
			if (index !== -1)
			{
				list.splice(index, 1);
			}
		}
	}

	async move(id: string, parentId: string | null, position: "top" | "bottom"): Promise<void>
	{
		const list = await this.children(parentId);
		this.remove(id);
		if (position === "top")
		{
			list.unshift(id);
		}
		else
		{
			list.push(id);
		}
	}
}
