/**
 * The ladder's orchestration layer: read both buckets, turn a drop into a
 * Workflowy write, and announce the write on the event bus.
 *
 * The router stays a thin adapter over this so the interesting rules — which
 * tier a row came from, whether a write is even legal, when a watcher gets
 * woken — are testable without a live Workflowy or an HTTP server.
 */

import type {LadderEvent, LadderEventBus} from "./ladder-events.js";
import {planSlot} from "@outlinedb/shared/cache";
import {planTierMove, toLadder} from "./ladder-model.js";
import type {Ladder, RawNode} from "./ladder-model.js";

export type LadderBuckets = Record<string, RawNode>;

export interface LadderServiceOptions
{
	readBuckets: () => Promise<LadderBuckets>;
	/** Negative position prepends; zero appends. The fallback when {@link moveTo} is absent. */
	moveNode: (nodeId: string, parentId: string, position: number) => Promise<unknown>;
	/**
	 * Move to an exact slot (the internal API). `index` counts the tier's full
	 * current child list, hidden completed rows and the moved node included.
	 */
	moveTo?: (nodeId: string, parentId: string, index: number) => Promise<unknown>;
	completeNode: (nodeId: string) => Promise<unknown>;
	/**
	 * Re-read a tier's sibling order after a move. It runs after the response,
	 * because Workflowy throttling can stretch it past the page's connection.
	 */
	refreshTier?: (parentId: string) => Promise<unknown>;
	events: LadderEventBus;
	now?: () => Date;
}

export class LadderService
{
	readonly #options: LadderServiceOptions;

	constructor(options: LadderServiceOptions)
	{
		this.#options = options;
	}

	async read(): Promise<Record<string, Ladder>>
	{
		const buckets = await this.#options.readBuckets();
		const ladders: Record<string, Ladder> = {};
		for (const [root, bucket] of Object.entries(buckets))
		{
			ladders[root] = toLadder(root, bucket);
		}
		return ladders;
	}

	/**
	 * Move one row to another tier of the same ladder.
	 *
	 * The event is published only after the write resolves. A watcher woken by a
	 * move it can't see in Workflowy is worse than no notification at all.
	 */
	async move({
		root,
		nodeId,
		toTier,
		beforeNodeId,
	}: {
		root: string;
		nodeId: string;
		toTier: string;
		beforeNodeId?: string;
	}): Promise<LadderEvent>
	{
		const buckets = await this.#options.readBuckets();
		const ladder = ladderFrom(buckets, root);
		const plan = planTierMove(ladder, nodeId, toTier);
		const destination = ladder.tiers.find((tier) => tier.id === plan.parentId);
		if (destination === undefined)
		{
			throw new Error(`tier ${plan.parentId} is not in ladder ${root}`);
		}
		const remaining = destination.items.filter((item) => item.id !== nodeId);
		const index = beforeNodeId ? remaining.findIndex((item) => item.id === beforeNodeId) : remaining.length;
		if (index < 0)
		{
			throw new Error(`node ${beforeNodeId} is not a destination row`);
		}
		const event =
		{
			verb: "move" as const,
			nodeId,
			name: findItem(ladder, nodeId)?.name ?? null,
			fromTier: plan.fromTier,
			toTier,
		};
		const {moveTo} = this.#options;
		if (moveTo !== undefined)
		{
			const children = buckets[root]?.children?.find((child) => child.id === plan.parentId)?.children ?? [];
			const ids = children.map((child) => child.id);
			await moveTo(nodeId, plan.parentId, beforeNodeId ? ids.indexOf(beforeNodeId) : ids.length);
			return this.#landed(
				plan.parentId,
				{
					...event,
					beforeNodeId: beforeNodeId ?? "",
				},
			);
		}
		const slot = planSlot(
			destination.items.map((item) => item.id),
			nodeId,
			index,
		);
		if (slot === null)
		{
			return this.#landed(
				plan.parentId,
				{
					...event,
					beforeNodeId: beforeNodeId ?? "",
				},
			);
		}
		const position = slot.position === "top" ? -1 : 0;
		await this.#options.moveNode(nodeId, plan.parentId, position);
		if (slot.siblingIds.length === 0)
		{
			return this.#landed(
				plan.parentId,
				{
					...event,
					beforeNodeId: slot.position === "top" ? (remaining[0]?.id ?? "") : "",
				},
			);
		}
		this.#publish(
			{
				...event,
				beforeNodeId: "",
			},
		);
		// Workflowy's API supports only top/bottom. Rotate the shorter side to preserve exact placement.
		for (const siblingId of slot.siblingIds)
		{
			await this.#options.moveNode(siblingId, plan.parentId, position);
			this.#publish(
				{
					verb: "move",
					nodeId: siblingId,
					name: remaining.find((item) => item.id === siblingId)?.name ?? null,
					fromTier: toTier,
					toTier,
					beforeNodeId: "",
				},
			);
		}
		return this.#landed(
			plan.parentId,
			{
				...event,
				beforeNodeId: beforeNodeId ?? "",
			},
		);
	}

	/** Announce a landed move, then refresh its tier without holding the response. */
	#landed(parentId: string, event: Omit<LadderEvent, "at">): LadderEvent
	{
		const published = this.#publish(event);
		this.#options.refreshTier?.(parentId).catch((error: unknown) =>
		{
			const message = error instanceof Error ? error.message : String(error);
			console.error(`ladder: could not refresh tier ${parentId} after a move: ${message}`);
		});
		return published;
	}

	async complete({root, nodeId}: {root: string; nodeId: string}): Promise<LadderEvent>
	{
		const ladder = await this.#ladder(root);
		const origin = ladder.tiers.find((tier) => tier.items.some((item) => item.id === nodeId));
		if (!origin)
		{
			throw new Error(`node ${nodeId} is not on the ${root} ladder`);
		}
		const name = findItem(ladder, nodeId)?.name ?? null;
		await this.#options.completeNode(nodeId);
		return this.#publish(
			{
				verb: "complete",
				nodeId,
				name,
				fromTier: origin.label,
				toTier: null,
			},
		);
	}

	async #ladder(root: string): Promise<Ladder>
	{
		return ladderFrom(await this.#options.readBuckets(), root);
	}

	#publish(event: Omit<LadderEvent, "at">): LadderEvent
	{
		const at = (this.#options.now?.() ?? new Date()).toISOString();
		const published =
		{
			...event,
			at,
		};
		this.#options.events.publish(published);
		return published;
	}
}

function ladderFrom(buckets: LadderBuckets, root: string): Ladder
{
	const bucket = buckets[root];
	if (bucket === undefined)
	{
		throw new Error(`no ladder named ${root}`);
	}
	return toLadder(root, bucket);
}

function findItem(ladder: Ladder, nodeId: string)
{
	return ladder.tiers.flatMap((tier) => tier.items).find((candidate) => candidate.id === nodeId);
}
