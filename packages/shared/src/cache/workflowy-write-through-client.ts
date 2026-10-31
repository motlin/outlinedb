import type {ItemRelationships, UpstreamRelationshipMetadata} from "./item-relationships.js";
import type {
	CreateMirrorResult,
	CreateNodeRequest,
	UpdateNodeRequest,
	WorkflowyApiClient,
} from "../api/workflowy-client.js";
import {isSystemTarget} from "../types/targets.js";
import type {WorkflowyNode} from "../types/workflowy.js";
import type {BacklinkSyncRecord, CacheService} from "./cache-service.js";
import {planSubtreeDelete} from "./delete-plan.js";
import type {DeletePlan} from "./delete-plan.js";

/** Moves nodes to an exact slot among a parent's children (Home's for `null`), as the internal API can. */
export interface ExactMover {
	moveTo(input: {ids: string[]; parentId: string | null; index: number}): Promise<void>;
}

/**
 * Unified write-through client that wraps both WorkflowyApiClient and CacheService.
 * All write operations are performed against the Workflowy API first, then the cache is updated.
 *
 * Error handling: If the API call succeeds but the cache update fails, the error is thrown.
 * This ensures data consistency and makes failures visible.
 */
export class WorkflowyWriteThroughClient {
	constructor(
		private readonly apiClient: WorkflowyApiClient,
		private readonly cacheService: CacheService,
		/** Places a promoted original in one move; without it, promotions rotate siblings through the REST API. */
		private readonly exactMover?: ExactMover,
	) {}

	/**
	 * Ensure the parent node exists in the cache before inserting a child.
	 * If the parent is missing, fetch it from the API and insert it.
	 * If the grandparent is also missing, throw an error (cache too stale).
	 *
	 * @param parentId The parent node ID to ensure exists in cache
	 */
	private async ensureParentInCache(parentId: string | null): Promise<void> {
		if (parentId === null) {
			return;
		}

		const existingParent = this.cacheService.getNode(parentId);
		if (existingParent) {
			return;
		}

		// Parent not in cache - fetch from API
		const parent = await this.apiClient.getNode(parentId);

		// Check if grandparent exists (if parent has a parent)
		const grandparentId = parent.parent_id ?? null;
		if (grandparentId !== null) {
			const existingGrandparent = this.cacheService.getNode(grandparentId);
			if (!existingGrandparent) {
				throw new Error(`Cache too stale: grandparent node ${grandparentId} not found`);
			}
		}

		// Insert the fetched parent into cache
		this.cacheService.insertNode(parent, grandparentId);
	}

	/**
	 * Create a new node and update the cache.
	 * @param options Node creation options
	 * @returns The created node
	 */
	async createNode(options: CreateNodeRequest): Promise<WorkflowyNode> {
		const created = await this.apiClient.createNode(options);
		// The create response holds only the new id, so read back the priority Workflowy
		// assigned; the placeholder would put the node out of order among its cached siblings.
		// A system target like "inbox" is accepted on create but 404s on GET, so the real parent comes from here too.
		const fetched = await this.apiClient.getNode(created.id);
		const node = {
			...created,
			priority: fetched.priority,
			parent_id: options.parent_id && isSystemTarget(options.parent_id) ? fetched.parent_id : created.parent_id,
		};
		// A top insert can make Workflowy renumber every sibling, so re-read them all;
		// the re-read caches the new node too, in the same unit of work as its siblings.
		await this.refreshChildren([node.parent_id ?? null]);
		return node;
	}

	/**
	 * The node an update should actually be written to. A mirror's text lives on
	 * its original; writing to the mirror id leaves stale text stored on the
	 * mirror, which Workflowy ignores. So every update on a mirror, clears
	 * included, goes to the original.
	 */
	resolveUpdateTarget(nodeId: string): string {
		return this.cacheService.getMirrorOriginal(nodeId) ?? nodeId;
	}

	/**
	 * Update an existing node and update the cache. Updates on a mirror are
	 * redirected to its original (see {@link resolveUpdateTarget}).
	 * @param requestedId The node ID to update
	 * @param options Update options (name, note, layoutMode)
	 * @returns The node that was updated (the original, for a mirror)
	 */
	async updateNode(requestedId: string, options: UpdateNodeRequest): Promise<WorkflowyNode> {
		const nodeId = this.resolveUpdateTarget(requestedId);
		await this.apiClient.updateNode(nodeId, options);
		// Fetch fresh node data from API to update cache correctly
		const updatedNode = await this.apiClient.getNode(nodeId);
		const cachedNode = this.cacheService.getNode(nodeId);
		const parentId = cachedNode?.parentId ?? null;
		await this.ensureParentInCache(parentId);
		this.cacheService.insertNode(updatedNode, parentId);
		return updatedNode;
	}

	/**
	 * Work out the API calls {@link deleteNode} makes for `nodeId`, from the cache,
	 * without changing anything. Where an original is kept, its mirror's siblings
	 * are read from the API (GET only), since a stale cached order would put the
	 * original in the wrong slot.
	 *
	 * Workflowy's generic DELETE /nodes/:id removes a mirror, or an ancestor of
	 * one, but leaves the mirror's id in its original's mirror list: a dead
	 * reference. DELETE /nodes/:id/mirror cleans the list, so a mirror target is
	 * removed through it alone, and every mirror in the deleted part of a
	 * subtree is removed through it before the generic delete.
	 *
	 * The generic delete of an original also leaves its mirrors elsewhere as
	 * empty orphans. The web app instead keeps the original by moving it into a
	 * mirror's place, so an original in the subtree with a mirror outside the
	 * deleted part is kept that way (see {@link planSubtreeDelete}).
	 */
	async planDelete(nodeId: string): Promise<DeletePlan> {
		if (this.cacheService.getMirrorOriginal(nodeId) !== null) {
			return {mirrorIds: [nodeId], promotions: [], nodeId: null};
		}
		return planSubtreeDelete(this.cacheService, nodeId, async (parentId) => this.liveChildOrder(parentId));
	}

	/** A parent's children ids in Workflowy's current order, read from the API. */
	private async liveChildOrder(parentId: string | null): Promise<string[]> {
		return (await this.liveChildren(parentId)).map((node) => node.id);
	}

	/** A parent's children (Home's for `null`) in Workflowy's current order, read from the API. */
	async liveChildren(parentId: string | null): Promise<WorkflowyNode[]> {
		const children =
			parentId === null ? await this.apiClient.getRootNodes() : await this.apiClient.getChildNodes(parentId);
		return children.toSorted((a, b) => a.priority - b.priority);
	}

	/** A parent's children ids (Home's for `null`) in the cache's order, with no API call. */
	cachedChildIds(parentId: string | null): string[] {
		return this.cacheService.getChildren(parentId).map((node) => node.id);
	}

	/**
	 * Re-read a chain of parents at once, such as a cached parent and the
	 * nested nodes just created under it, and store their children in the
	 * given order so each new node is cached before its own children.
	 */
	async refreshChain(parentIds: string[]): Promise<void> {
		const batches = await Promise.all(
			parentIds.map(async (parentId) => ({parentId, nodes: await this.liveChildren(parentId)})),
		);
		this.cacheService.storeApiResponses(batches);
	}

	/** One node as Workflowy has it now, read from the API. */
	async liveNode(nodeId: string): Promise<WorkflowyNode> {
		return this.apiClient.getNode(nodeId);
	}

	/** One node as Workflowy has it now, or `null` when the public API answers 404. */
	async findLiveNode(nodeId: string): Promise<WorkflowyNode | null> {
		return this.apiClient.findNode(nodeId);
	}

	/** The cached node a link's 12-hex short id names, or `null` when no cached node has it. */
	resolveShortId(shortId: string): string | null {
		return this.cacheService.resolveShortIdToUuid(shortId);
	}

	/** Whether `nodeId` is cached, or else live on Workflowy (one public read, a 404 meaning no). */
	async exists(nodeId: string): Promise<boolean> {
		return this.cacheService.getNode(nodeId) !== undefined || (await this.apiClient.findNode(nodeId)) !== null;
	}

	/** Each node's upstream `mirror`/`backlink`/`isReferencesRoot` view, rebuilt from the cached edge tables. */
	relationshipMetadata(nodeIds: readonly string[]): Map<string, UpstreamRelationshipMetadata> {
		return this.cacheService.relationshipMetadata(nodeIds);
	}

	/**
	 * Re-read each parent's children (Home's for `null`) through the API, then
	 * replace the cached children of all of them in one transaction. Positional
	 * writes call it because Workflowy may renumber every sibling's priority when
	 * the gap at the top runs out; use it too after a write made outside this
	 * client, such as an internal-API push.
	 *
	 * Each of `subtreeRoots` also has its whole subtree re-read level by level
	 * and stored in the same transaction, for writes such as a restore that
	 * bring back descendants the parent's children alone do not show.
	 */
	async refreshChildren(parentIds: (string | null)[], subtreeRoots: string[] = []): Promise<void> {
		const unique = [...new Set(parentIds)];
		for (const parentId of unique) {
			await this.ensureParentInCache(parentId);
		}
		const batches = await Promise.all(
			unique.map(async (parentId) => ({parentId, nodes: await this.liveChildren(parentId)})),
		);
		let level = subtreeRoots;
		while (level.length > 0) {
			const levelBatches = await Promise.all(
				level.map(async (parentId) => ({parentId, nodes: await this.liveChildren(parentId)})),
			);
			batches.push(...levelBatches);
			level = levelBatches.flatMap((batch) => batch.nodes.map((node) => node.id));
		}
		this.cacheService.storeApiResponses(batches);
	}

	/**
	 * After an internal-API push that changed backlinks, re-read each changed
	 * parent's children (in the given order: parents before the references
	 * roots created under them) and record the sync in the cache as one unit
	 * of work.
	 */
	async refreshBacklinks(parentIds: string[], record: Omit<BacklinkSyncRecord, "children">): Promise<void> {
		const children = await Promise.all(
			parentIds.map(async (parentId) => ({parentId, nodes: await this.liveChildren(parentId)})),
		);
		this.cacheService.recordBacklinkSync({...record, children});
	}

	/**
	 * Delete a node and remove it from the cache, carrying out {@link planDelete}
	 * in order: inner mirrors, then each promotion (remove the mirror, move the
	 * original into its slot, move siblings to fix the slot; with an
	 * {@link ExactMover}, one exact-index move instead), then the generic
	 * delete. The cache follows each call. If any call fails, the rest are not
	 * sent, so the generic delete never runs before every kept original has
	 * moved out of the subtree.
	 * @param nodeId The node ID to delete
	 * @param plan The plan from {@link planDelete} to carry out, when the caller
	 *   already made (and showed) one; otherwise one is made now
	 * @returns The plan that was carried out
	 */
	async deleteNode(nodeId: string, plan?: DeletePlan): Promise<DeletePlan> {
		plan ??= await this.planDelete(nodeId);
		for (const mirrorId of plan.mirrorIds) {
			await this.deleteMirror(mirrorId);
		}
		for (const {mirrorId, originalId, parentId, position, siblingIds, index} of plan.promotions) {
			if (this.exactMover !== undefined) {
				await this.deleteMirror(mirrorId);
				await this.exactMover.moveTo({ids: [originalId], parentId, index});
				await this.refreshChildren([parentId]);
				continue;
			}
			const end = position === "top" ? -1 : 0;
			await this.promote(mirrorId, originalId, parentId, end);
			for (const siblingId of siblingIds) {
				await this.moveNode(siblingId, parentId, end);
			}
		}
		if (plan.nodeId !== null) {
			await this.apiClient.deleteNode(plan.nodeId);
			this.cacheService.deleteNode(plan.nodeId);
		}
		return plan;
	}

	/**
	 * Remove a mirror and move its original into the mirror's slot. The cache
	 * records both as one unit of work; if the move fails, it records the
	 * removal alone, matching Workflowy.
	 */
	private async promote(
		mirrorId: string,
		originalId: string,
		parentId: string | null,
		position: number,
	): Promise<void> {
		await this.apiClient.deleteMirror(mirrorId);
		let moved: WorkflowyNode;
		try {
			await this.apiClient.moveNode(originalId, parentId, position);
			moved = await this.apiClient.getNode(originalId);
		} catch (error) {
			this.cacheService.deleteNode(mirrorId);
			throw error;
		}
		this.cacheService.promoteOriginal(mirrorId, moved, parentId);
		// A top move can make Workflowy renumber every sibling, so re-read them all.
		await this.refreshChildren([parentId]);
	}

	/**
	 * Move a node to a new parent and update the cache.
	 * @param nodeId The node ID to move
	 * @param newParentId The target parent ID (null for Home)
	 * @param position Optional position ('top' for -1, 'bottom' for >= 0)
	 * @returns The moved node
	 */
	async moveNode(nodeId: string, newParentId: string | null, position?: number): Promise<WorkflowyNode> {
		await this.apiClient.moveNode(nodeId, newParentId, position);
		// Fetch fresh node data from API to update cache correctly
		const movedNode = await this.apiClient.getNode(nodeId);
		const parentId =
			newParentId !== null && isSystemTarget(newParentId) ? (movedNode.parent_id ?? null) : newParentId;
		// A top move can make Workflowy renumber every sibling, so re-read them all;
		// the re-read caches the moved node too, in the same unit of work as its siblings.
		await this.refreshChildren([parentId]);
		return movedNode;
	}

	/**
	 * Create a live mirror of a node and record it in the cache. The mirror row
	 * is stored blank, matching backup imports: its content lives on the origin.
	 * @param originId The node to mirror
	 * @param parentId The parent to place the mirror under
	 * @param position Where among the parent's children to place the mirror
	 */
	async createMirror(originId: string, parentId: string, position: "top" | "bottom"): Promise<CreateMirrorResult> {
		const result = await this.apiClient.createMirror(originId, parentId, position);
		const mirrorNode = await this.apiClient.getNode(result.mirrorId);
		const mirrorParentId = mirrorNode.parent_id ?? parentId;
		await this.ensureParentInCache(mirrorParentId);
		this.cacheService.insertNode({...mirrorNode, name: "", note: null}, mirrorParentId);
		this.cacheService.insertMirror(result.originId, result.mirrorId);
		return result;
	}

	/** Cache the mirror, backlink and references-root rows an accepted push created outside {@link createMirror}. */
	recordRelationships(relationships: ItemRelationships): void {
		this.cacheService.recordRelationships(relationships);
	}

	/**
	 * Remove a mirror and drop it, with its mirror relationship, from the cache.
	 * @param mirrorId The mirror node to remove
	 */
	async deleteMirror(mirrorId: string): Promise<void> {
		await this.apiClient.deleteMirror(mirrorId);
		this.cacheService.deleteNode(mirrorId);
	}

	/**
	 * Mark a node as completed and update the cache. A mirror's completion is its
	 * original's, so completing a mirror completes the original.
	 * @param requestedId The node ID to complete
	 * @returns The completed node (the original, for a mirror)
	 */
	async completeNode(requestedId: string): Promise<WorkflowyNode> {
		const nodeId = this.resolveUpdateTarget(requestedId);
		await this.apiClient.completeNode(nodeId);
		// Fetch fresh node data from API to update cache correctly
		const completedNode = await this.apiClient.getNode(nodeId);
		const cachedNode = this.cacheService.getNode(nodeId);
		const parentId = cachedNode?.parentId ?? null;
		await this.ensureParentInCache(parentId);
		this.cacheService.insertNode(completedNode, parentId);
		return completedNode;
	}

	/**
	 * Mark a node as not completed and update the cache. Uncompleting a mirror
	 * uncompletes its original.
	 * @param requestedId The node ID to uncomplete
	 * @returns The uncompleted node (the original, for a mirror)
	 */
	async uncompleteNode(requestedId: string): Promise<WorkflowyNode> {
		const nodeId = this.resolveUpdateTarget(requestedId);
		await this.apiClient.uncompleteNode(nodeId);
		// Fetch fresh node data from API to update cache correctly
		const uncompletedNode = await this.apiClient.getNode(nodeId);
		const cachedNode = this.cacheService.getNode(nodeId);
		const parentId = cachedNode?.parentId ?? null;
		await this.ensureParentInCache(parentId);
		this.cacheService.insertNode(uncompletedNode, parentId);
		return uncompletedNode;
	}
}
