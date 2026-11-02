import {paneMoveIndex} from "../pane-ids.js";
import {FaIcon} from "./fa-icons.js";
import type {GearMenuHeaderItem} from "./main-menu-model.js";

/**
 * Upstream's `more-menu.menu.header.move-pane-left` / `move-pane-right` rows for the kebab of pane `paneId` (`main` for
 * the main pane): hidden with no pane open, each disabled when `canPlacePane` refuses that direction.
 */
export function movePaneItems(
	state:
	{
		panes: readonly
		{
			id: string;
		}[];
	},
	paneId: string,
	move: (paneId: string, index: number) => void,
): GearMenuHeaderItem[]
{
	if (state.panes.length === 0)
	{
		return [];
	}
	const row = (
		direction: "left" | "right",
		label: string,
		icon: "fal:square-chevron-left" | "fal:square-chevron-right",
	) =>
	{
		const index = paneMoveIndex(state, paneId, direction);
		return {
			label,
			icon: <FaIcon icon={icon} />,
			disabled: index === null,
			onSelect: () =>
			{
				if (index !== null)
				{
					move(paneId, index);
				}
			},
		};
	};
	return [
		row("left", "Move pane left", "fal:square-chevron-left"),
		row("right", "Move pane right", "fal:square-chevron-right"),
	];
}
