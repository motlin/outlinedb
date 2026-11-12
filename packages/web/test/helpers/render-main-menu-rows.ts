import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {ReactNode} from "react";
import {MenuBody} from "../../src/client/components/flyout/menu.js";
import type {GearMenuHeaderItem} from "../../src/client/components/main-menu-model.js";
import type {MainMenuRowsOptions} from "../../src/client/components/main-menu-rows.js";

type UseMainMenuRows = (options: MainMenuRowsOptions) => ReactNode[];

/** Renders the main menu's rows inside MenuBody (the ButtonMenu's body), as a flyout would. */
export function renderMainMenuRows(
	useMainMenuRows: UseMainMenuRows,
	headerItems: GearMenuHeaderItem[] = [],
	paneItems: GearMenuHeaderItem[] = [],
	changelogUnread = false,
): string
{
	function Rows()
	{
		const rows = useMainMenuRows(
			{
				headerItems,
				paneItems,
				changelogUnread,
				onOpenSettings: () =>
				{
				},
				onExpandAll: () =>
				{
				},
				onCollapseAll: () =>
				{
				},
				onUndo: () =>
				{
				},
				onRedo: () =>
				{
				},
			},
		);
		return createElement(
			MenuBody,
			{
				unwrapped: true,
			},
			...rows,
		);
	}
	return renderToStaticMarkup(createElement(Rows));
}
