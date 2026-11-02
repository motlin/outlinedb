/**
 * The asap ladder, read from a `📌 Tasks (asap)` bucket.
 *
 * The ladder is ordinal tiers with a halving capacity: `1st` holds 2, `2nd` 4,
 * `3rd` 8, and so on. The cap is fixed rather than relative to what the tier
 * below currently holds, so finishing work never retroactively forces an item
 * out of a higher tier.
 */

const ORDINAL_SUFFIX: Record<number, string> =
{
	1: "st",
	2: "nd",
	3: "rd",
};

export type TierState = "room" | "exact" | "over";

export interface LadderItem
{
	id: string;
	name: string;
	/** Incomplete children, recursively, as read from the cache. */
	children: LadderItem[];
	hasChildren?: boolean;
	/** How many incomplete nodes sit under this one, at any depth. */
	descendantCount: number;
}

export interface LadderTier
{
	tier: number;
	label: string;
	id: string;
	capacity: number;
	state: TierState;
	items: LadderItem[];
}

export interface Ladder
{
	root: string;
	bucketId: string;
	tiers: LadderTier[];
}

/** The shape {@link toLadder} needs from a cached node tree. */
export interface RawNode
{
	id: string;
	name?: string | null;
	completedAt?: string | null;
	children?: RawNode[];
}

export function tierCapacity(tier: number): number
{
	return 2 ** tier;
}

export function tierLabel(tier: number): string
{
	const teen = tier % 100 >= 11 && tier % 100 <= 13;
	return `${tier}${teen ? "th" : (ORDINAL_SUFFIX[tier % 10] ?? "th")}`;
}

function parseTierLabel(name: string | null | undefined): number | null
{
	const match = /^\s*(\d+)(st|nd|rd|th)\s*$/iu.exec(stripHtml(name ?? ""));
	if (!match)
	{
		return null;
	}
	const tier = Number(match[1]);
	return Number.isInteger(tier) && tier >= 1 ? tier : null;
}

function stripHtml(value: string): string
{
	return value.replaceAll(/<[^>]+>/gu, "").trim();
}

function stateFor(count: number, capacity: number): TierState
{
	if (count > capacity)
	{
		return "over";
	}
	return count === capacity ? "exact" : "room";
}

export function toLadder(root: string, bucket: RawNode): Ladder
{
	const tiers: LadderTier[] = [];

	for (const child of bucket.children ?? [])
	{
		const tier = parseTierLabel(child.name);
		if (tier === null)
		{
			continue;
		}
		const items = (child.children ?? []).filter((node) => !node.completedAt).map(toItem);
		const capacity = tierCapacity(tier);
		tiers.push(
			{
				tier,
				label: tierLabel(tier),
				id: child.id,
				capacity,
				state: stateFor(items.length, capacity),
				items,
			},
		);
	}

	tiers.sort((a, b) => a.tier - b.tier);
	return {
		root,
		bucketId: bucket.id,
		tiers,
	};
}

/** A row with its loaded open descendants; the tree panel fetches deeper branches on demand. */
function toItem(node: RawNode): LadderItem
{
	const children = (node.children ?? []).filter((child) => !child.completedAt).map(toItem);
	return {
		id: node.id,
		name: stripHtml(node.name ?? ""),
		children,
		hasChildren: (node.children?.length ?? 0) > 0,
		descendantCount: children.reduce((total, child) => total + 1 + child.descendantCount, 0),
	};
}

export interface TierMove
{
	nodeId: string;
	parentId: string;
	fromTier: string;
	toTier: string;
}

/**
 * Turn "put this row in that tier" into the parent id the move endpoint wants.
 *
 * Both lookups throw rather than defaulting. An earlier version of this flow
 * hardcoded one destination tier for every move and silently filed four rows
 * into the wrong place, so an unknown tier has to be an error, never a guess.
 */
export function planTierMove(ladder: Ladder, nodeId: string, toTier: string): TierMove
{
	const destination = ladder.tiers.find((tier) => tier.label === toTier);
	if (!destination)
	{
		throw new Error(`no tier ${toTier} on the ${ladder.root} ladder`);
	}
	const origin = ladder.tiers.find((tier) => tier.items.some((item) => item.id === nodeId));
	if (!origin)
	{
		throw new Error(`node ${nodeId} is not on the ${ladder.root} ladder`);
	}
	return {
		nodeId,
		parentId: destination.id,
		fromTier: origin.label,
		toTier: destination.label,
	};
}
