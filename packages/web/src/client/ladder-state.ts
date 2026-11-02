/**
 * Ladder state in the browser, moved without a refetch.
 *
 * Every write reaches the page twice: once as the optimistic local move that
 * makes the drop feel instant, and again as the WebSocket frame the server
 * broadcasts after the write lands. Both go through here, and both are
 * idempotent — re-applying a move the page already made is a no-op.
 */

import type {Ladder, LadderTier, TierState} from "../server/ladder-model.js";
import type {LadderEvent} from "../server/ladder-events.js";

export type Ladders = Record<string, Ladder>;

function stateFor(count: number, capacity: number): TierState
{
	if (count > capacity)
	{
		return "over";
	}
	return count === capacity ? "exact" : "room";
}

function withItems(tier: LadderTier, items: LadderTier["items"]): LadderTier
{
	return {
		...tier,
		items,
		state: stateFor(items.length, tier.capacity),
	};
}

/** Move one row to another tier of the same ladder, or return the input unchanged. */
export function moveWithin(
	ladders: Ladders,
	root: string,
	nodeId: string,
	toTier: string,
	beforeNodeId?: string,
): Ladders
{
	const ladder = ladders[root];
	if (ladder === undefined)
	{
		return ladders;
	}
	const origin = ladder.tiers.find((tier) => tier.items.some((item) => item.id === nodeId));
	const destination = ladder.tiers.find((tier) => tier.label === toTier);
	if (!origin || !destination || (origin.label === destination.label && beforeNodeId === undefined))
	{
		return ladders;
	}
	const item = origin.items.find((candidate) => candidate.id === nodeId);
	if (!item)
	{
		return ladders;
	}
	const destinationItems = destination.items.filter((candidate) => candidate.id !== nodeId);
	const position = beforeNodeId
		? destinationItems.findIndex((candidate) => candidate.id === beforeNodeId)
		: destinationItems.length;
	if (position < 0)
	{
		return ladders;
	}
	destinationItems.splice(position, 0, item);
	const tiers = ladder.tiers.map((tier) =>
	{
		if (tier.label === destination.label)
		{
			return withItems(tier, destinationItems);
		}
		if (tier.label === origin.label)
		{
			return withItems(
				tier,
				tier.items.filter((candidate) => candidate.id !== nodeId),
			);
		}
		return tier;
	});
	return {
		...ladders,
		[root]:
		{
			...ladder,
			tiers,
		},
	};
}

/** Remove a row from whichever ladder holds it. */
export function removeRow(ladders: Ladders, nodeId: string): Ladders
{
	for (const [root, ladder] of Object.entries(ladders))
	{
		if (!ladder.tiers.some((tier) => tier.items.some((item) => item.id === nodeId)))
		{
			continue;
		}
		const tiers = ladder.tiers.map((tier) =>
			tier.items.some((item) => item.id === nodeId)
				? withItems(
						tier,
						tier.items.filter((item) => item.id !== nodeId),
					)
				: tier,
		);
		return {
			...ladders,
			[root]:
			{
				...ladder,
				tiers,
			},
		};
	}
	return ladders;
}

/** Apply one broadcast write. Unknown nodes are ignored, never invented. */
export function applyLadderEvent(ladders: Ladders, event: LadderEvent): Ladders
{
	const root = Object.entries(ladders).find(([, ladder]) =>
		ladder.tiers.some((tier) => tier.items.some((item) => item.id === event.nodeId)),
	)?.[0];
	if (!root)
	{
		return ladders;
	}
	if (event.verb === "move" && event.toTier)
	{
		return moveWithin(ladders, root, event.nodeId, event.toTier, event.beforeNodeId);
	}
	if (event.verb === "complete")
	{
		return removeRow(ladders, event.nodeId);
	}
	return ladders;
}

/**
 * Which tier a row is in right now. The drop handler uses this to drop a
 * gesture that ended where it started: a finger that wanders and comes back
 * should not cost a write.
 */
export function tierOf(ladders: Ladders, root: string, nodeId: string): string | undefined
{
	return ladders[root]?.tiers.find((tier) => tier.items.some((item) => item.id === nodeId))?.label;
}

/** Select a contiguous range in the displayed root, including both endpoints. */
export function selectLadderRange(ladder: Ladder, anchor: string, target: string): Set<string>
{
	const ids = ladder.tiers.flatMap((tier) => tier.items.map((item) => item.id));
	const from = ids.indexOf(anchor);
	const to = ids.indexOf(target);
	if (from === -1 || to === -1)
	{
		return new Set([target]);
	}
	return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
}

/** Preserve display order for a group move, regardless of checkbox click order. */
export function ladderMoveSelection(ladder: Ladder, selected: Set<string>, nodeId: string): string[]
{
	return selected.has(nodeId)
		? ladder.tiers.flatMap((tier) => tier.items.filter((item) => selected.has(item.id)).map((item) => item.id))
		: [nodeId];
}

/**
 * Where a step arrow lands its rows: stepping down puts them at the top of the
 * next tier, stepping up at the bottom of the previous one. Returns the row to
 * insert before, or undefined to append.
 */
export function stepBeforeId(
	ladder: Ladder,
	toTier: string,
	direction: "up" | "down",
	moving: readonly string[],
): string | undefined
{
	if (direction === "up")
	{
		return undefined;
	}
	const destination = ladder.tiers.find((tier) => tier.label === toTier);
	return destination?.items.find((item) => !moving.includes(item.id))?.id;
}

/** Restore only the failed row, preserving writes received for other rows. */
export function restoreRow(current: Ladders, before: Ladders, nodeId: string): Ladders
{
	const root = Object.keys(before).find((name) => tierOf(before, name, nodeId));
	if (!root || current[root] === undefined)
	{
		return current;
	}
	const origin = before[root]?.tiers.find((tier) => tier.items.some((item) => item.id === nodeId));
	const index = origin?.items.findIndex((item) => item.id === nodeId) ?? -1;
	const row = origin?.items[index];
	const without = removeRow(current, nodeId);
	const ladder = without[root];
	if (origin === undefined || row === undefined || ladder === undefined)
	{
		return current;
	}
	return {
		...without,
		[root]:
		{
			...ladder,
			tiers: ladder.tiers.map((tier) =>
			{
				if (tier.id !== origin.id)
				{
					return tier;
				}
				const items = [...tier.items];
				items.splice(index, 0, row);
				return withItems(tier, items);
			}),
		},
	};
}
