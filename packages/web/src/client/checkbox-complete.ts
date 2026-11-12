import {MAIN_PANE_ID} from "./pane-ids.js";

export type CheckboxClickPlan =
	|
	  {
			kind: "command";
			focusRowAfter: boolean;
	  }
	|
	  {
			kind: "pane";
			zoomPaneTo: string | null;
	  };

/**
 * What a to-do checkbox click does, as upstream's checkbox `onChange` + `Oj4`: a side pane's own zoom item completes
 * with the caret left alone and zooms that pane to the parent (uncompleting, or no parent, just focuses the pane);
 * every other click is the `complete` command, which moves the caret on completing and enters the row on uncompleting.
 */
export function planCheckboxClick(input: {
	isCompleted: boolean;
	paneId: string;
	isPaneZoomItem: boolean;
	parentId: string | null;
}): CheckboxClickPlan
{
	if (input.paneId !== MAIN_PANE_ID && input.isPaneZoomItem)
	{
		return {
			kind: "pane",
			zoomPaneTo: input.isCompleted ? null : input.parentId,
		};
	}
	return {
		kind: "command",
		focusRowAfter: input.isCompleted,
	};
}
