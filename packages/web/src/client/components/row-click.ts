interface RowClickTarget
{
	closest(selector: string): object | null;
}

/**
 * Whether a click on a row's `.name` should resume editing at the end of the text. Clicks in the
 * editor, on the item-menu trigger, or in its portaled flyout (React bubbles portal events through
 * the row) must leave focus where it is, or the menu closes.
 */
export function rowClickResumesEditing<T extends RowClickTarget>(
	target: T | null,
	row:
	{
		contains(other: NoInfer<T>): boolean;
	},
): boolean
{
	if (target === null || !row.contains(target))
	{
		return false;
	}
	return target.closest("[contenteditable]") === null && target.closest(".itemMenu") === null;
}
