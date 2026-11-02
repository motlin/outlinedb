import {closeItemColorPopup, useItemColorPopup} from "../item-color-popup.js";
import {ColorPopup} from "./color-popup.js";

/** Renders the text/highlight popup opened by `show_color_popup` or ⇧⌘H over an item selection. */
export function ItemColorPopupHost()
{
	const request = useItemColorPopup();
	if (request === undefined)
	{
		return null;
	}
	return (
		<ColorPopup
			left={request.left}
			top={request.top}
			selected={{}}
			onSelect={(kind, color) =>
			{
				request.onPick(kind, color);
				closeItemColorPopup();
			}}
			onClose={closeItemColorPopup}
		/>
	);
}
