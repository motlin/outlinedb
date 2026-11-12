/**
 * How to land nodes at an exact slot using only the public API's two moves, to the top or to the bottom of a parent.
 * The REST API takes no index, so the siblings on the shorter side of the slot are rotated to their end after the
 * nodes themselves.
 */
export interface SlotPlan
{
	/** The end the nodes go to first. */
	position: "top" | "bottom";
	/**
	 * Siblings then moved to the same end, one at a time in this order. For the top they run nearest-first
	 * (reversed), so every sibling keeps its relative order.
	 */
	siblingIds: string[];
}

/**
 * Plan landing `ids`, in order, at `index` among the siblings that are not being moved. `order` is the parent's current
 * children (moved nodes included or not). Ties rotate the top side.
 */
export function planBlockSlot(order: string[], ids: string[], index: number): SlotPlan
{
	const moving = new Set(ids);
	const others = order.filter((id) => !moving.has(id));
	const slot = Math.min(Math.max(index, 0), others.length);
	const before = others.slice(0, slot);
	const after = others.slice(slot);
	return before.length <= after.length
		?
			{
				position: "top",
				siblingIds: before.toReversed(),
			}
		:
			{
				position: "bottom",
				siblingIds: after,
			};
}

/**
 * Plan landing one node at `index`, which counts the siblings other than `id`. Null when the node is already there.
 */
export function planSlot(order: string[], id: string, index: number): SlotPlan | null
{
	const others = order.filter((sibling) => sibling !== id);
	const current = order.indexOf(id);
	if (current !== -1 && current === Math.min(Math.max(index, 0), others.length))
	{
		return null;
	}
	return planBlockSlot(order, [id], index);
}
