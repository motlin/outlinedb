export type BlankSpaceClickPlan =
	|
	  {
			kind: "none";
	  }
	|
	  {
			kind: "edit-end";
			id: string;
	  }
	|
	  {
			kind: "add-child";
			index: number;
	  };

export interface BlankSpaceClickInput
{
	selectionActive: boolean;
	/** The last visible descendant row of the zoom, never the zoom root itself. */
	lastVisibleRowId: string | null;
	searching: boolean;
	visibleChildCount: number;
}

/** Upstream's `xy4`: what a click on the page's `.document-end` does. */
export function planBlankSpaceClick({
	selectionActive,
	lastVisibleRowId,
	searching,
	visibleChildCount,
}: BlankSpaceClickInput): BlankSpaceClickPlan
{
	if (selectionActive)
	{
		return {
			kind: "none",
		};
	}
	if (lastVisibleRowId !== null)
	{
		return {
			kind: "edit-end",
			id: lastVisibleRowId,
		};
	}
	return searching
		?
			{
				kind: "none",
			}
		:
			{
				kind: "add-child",
				index: visibleChildCount,
			};
}
