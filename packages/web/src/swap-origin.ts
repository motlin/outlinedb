export interface SwapSide
{
	id: string;
	parentId: string | null;
}

export interface SwapMove
{
	id: string;
	parentId: string | null;
	/** Insertion slot among the target's current children, counted before the moved item is removed. */
	index: number;
}

/** Where `id` sits in `order` after it moves to `slot` (a pre-removal slot). */
function moved(order: readonly string[], id: string, slot: number): string[]
{
	const from = order.indexOf(id);
	const rest = order.filter((entry) => entry !== id);
	const at = slot - (from !== -1 && from < slot ? 1 : 0);
	return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * The two moves that make a mirror and its original exchange slots, ids unchanged (upstream `Item.swap`): first the
 * mirror moves under the original's parent, then the original under the mirror's old parent. Within one parent a slot
 * past the mover's own is one higher (`o(a, i) = i + (sameParent && i > a ? 1 : 0)`).
 */
export function planSwapOrigin(
	orders: ReadonlyMap<string | null, readonly string[]>,
	mirror: SwapSide,
	original: SwapSide,
): [SwapMove, SwapMove]
{
	const order = (parentId: string | null): readonly string[] => orders.get(parentId) ?? [];
	const sameParent = mirror.parentId === original.parentId;
	const slot = (from: number, to: number): number => to + (sameParent && to > from ? 1 : 0);
	const mirrorIndex = order(mirror.parentId).indexOf(mirror.id);
	const originalIndex = order(original.parentId).indexOf(original.id);
	const first: SwapMove =
	{
		id: mirror.id,
		parentId: original.parentId,
		index: slot(mirrorIndex, originalIndex),
	};
	const afterFirst = moved(order(original.parentId), mirror.id, first.index);
	const second: SwapMove =
	{
		id: original.id,
		parentId: mirror.parentId,
		index: slot(afterFirst.indexOf(original.id), mirrorIndex),
	};
	return [first, second];
}

/** One move of a swap with the slot that puts the mover back, the shape an undo batch records. */
export interface SwapMoveOp
{
	kind: "move";
	nodeId: string;
	from:
	{
		parentId: string | null;
		index: number;
	};
	to:
	{
		parentId: string | null;
		index: number;
	};
}

/** The undo-batch ops of {@link planSwapOrigin}: each move with the slot its inverse needs. */
export function swapMoveOps(
	orders: ReadonlyMap<string | null, readonly string[]>,
	mirror: SwapSide,
	original: SwapSide,
): SwapMoveOp[]
{
	const lists = new Map<string | null, string[]>([...orders].map(([parentId, ids]) => [parentId, [...ids]]));
	return planSwapOrigin(orders, mirror, original).map((move) =>
	{
		const sourceParent = move.id === mirror.id ? mirror.parentId : original.parentId;
		const source = lists.get(sourceParent) ?? [];
		const from = source.indexOf(move.id);
		const sameParent = sourceParent === move.parentId;
		const landed = move.index - (sameParent && from < move.index ? 1 : 0);
		lists.set(
			sourceParent,
			source.filter((id) => id !== move.id),
		);
		const target = lists.get(move.parentId) ?? [];
		lists.set(move.parentId, [...target.slice(0, landed), move.id, ...target.slice(landed)]);
		return {
			kind: "move",
			nodeId: move.id,
			from:
			{
				parentId: sourceParent,
				index: sameParent && from > landed ? from + 1 : from,
			},
			to:
			{
				parentId: move.parentId,
				index: move.index,
			},
		};
	});
}
