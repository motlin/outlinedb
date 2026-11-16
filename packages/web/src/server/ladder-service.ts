/**
 * The ladder's orchestration layer: read both buckets, turn a drop into a
 * local tree write, and announce the write on the event bus.
 *
 * The router stays a thin adapter over this so the interesting rules — which
 * tier a row came from, whether a write is even legal, when a watcher gets
 * woken — are testable without a live Workflowy or an HTTP server.
 */

import type {LadderEvent, LadderEventBus} from "./ladder-events.js";
import {planTierMove, toLadder} from "./ladder-model.js";
import type {Ladder, RawNode} from "./ladder-model.js";

export type LadderBuckets = Record<string, RawNode>;

export interface LadderServiceOptions
{
	readBuckets: () => Promise<LadderBuckets>;
	/**
	 * Move to an exact slot. `index` counts the tier's full current child list,
	 * hidden completed rows and the moved node included.
	 */
	moveTo: (nodeId: string, parentId: string, index: number) => Promise<unknown>;
	completeNode: (nodeId: string) => Promise<unknown>;
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
	 * move it can't see in the outline is worse than no notification at all.
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
		if (beforeNodeId && !destination.items.some((item) => item.id === beforeNodeId && item.id !== nodeId))
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
		const children = buckets[root]?.children?.find((child) => child.id === plan.parentId)?.children ?? [];
		const ids = children.map((child) => child.id);
		await this.#options.moveTo(nodeId, plan.parentId, beforeNodeId ? ids.indexOf(beforeNodeId) : ids.length);
		return this.#publish(
			{
				...event,
				beforeNodeId: beforeNodeId ?? "",
			},
		);
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
