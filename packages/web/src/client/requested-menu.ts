import {assembleFlatForId} from "./app-menu.js";
import type {AssembledEntry} from "./app-menu.js";
import {APP_MENU_CONFIG} from "./app-menu-config.js";
import {pickerItemTypes} from "./item-type-select.js";
import type {ItemType} from "./layout-types.js";

/**
 * The rows of a menu opened by id (`GuiMenu.showById`): the config's flat assembly, with a command present only
 * when the local app can run it. Only the "Turn into..." picker is requestable today.
 */
export function requestedMenuEntries(
	menuId: string,
	cmdContext:
	{
		nodeIds: readonly string[];
	},
	qualifiers: readonly string[],
): AssembledEntry<ItemType>[]
{
	if (menuId !== "node_type_picker")
	{
		return [];
	}
	const types = pickerItemTypes(cmdContext.nodeIds);
	return assembleFlatForId(
		menuId,
		qualifiers,
		(id) => types.find((type) => type.command === id) ?? null,
		APP_MENU_CONFIG,
	);
}
