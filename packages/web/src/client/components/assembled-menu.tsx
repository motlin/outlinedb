import type {ReactElement} from "react";
import type {AssembledEntry} from "../app-menu.js";
import {APP_MENU_CONFIG} from "../app-menu-config.js";
import type {MenuCmdContext} from "../stores/outline.js";
import {useOutlineStore} from "../stores/outline.js";
import {FA_ICONS, FaIcon} from "./fa-icons.js";
import type {FaIconKey} from "./fa-icons.js";
import {MenuItem, MenuSeparator} from "./flyout/menu-item.js";
import type {MenuItemProps} from "./flyout/menu-item.js";

/** What a command row needs: upstream's `cmd.key` (handbook), `label`, `icon` and `shortcut`. */
export interface MenuCommandRow
{
	key: string;
	label: string;
	icon: string;
	shortcut?: string;
}

function isFaIconKey(key: string): key is FaIconKey
{
	return Object.hasOwn(FA_ICONS, key);
}

/** A light FontAwesome icon, falling back to upstream's missing-icon triangle. */
function lightIcon(name: string | undefined): FaIconKey
{
	const key = `fal:${name ?? ""}`;
	return isFaIconKey(key) ? key : "fal:triangle-exclamation";
}

export interface RenderAssembledOptions<C extends MenuCommandRow>
{
	onSelect: (cmd: C) => unknown;
	cmdContext: MenuCmdContext;
	qualifiers: readonly string[];
	/** Upstream drops separators on mobile (`q === true`). */
	isMobile?: boolean;
	/** Opens a submenu at the click's page point; defaults to `showMenuById` in the outline store. */
	openSubmenu?: (
		menuId: string,
		target:
		{
			top: number;
			left: number;
		},
	) => void;
}

/**
 * Upstream's `GuiMenu.renderAssembled` (`rK1`): a command is a `MenuItem` with its handbook key, a submenu is a
 * `MenuItem` labeled from the config with a chevron and no handbook or shortcut that opens its flat menu on click.
 */
export function renderAssembledMenu<C extends MenuCommandRow>(
	entries: readonly AssembledEntry<C>[],
	{onSelect, cmdContext, qualifiers, isMobile = false, openSubmenu}: RenderAssembledOptions<C>,
): ReactElement<MenuItemProps>[]
{
	const rows: ReactElement<MenuItemProps>[] = [];
	entries.forEach((entry, index) =>
	{
		if (entry.kind === "separator")
		{
			if (!isMobile)
			{
				// Separators have no identity beyond their position in the assembled list.
				// oxlint-disable-next-line react/no-array-index-key
				rows.push(<MenuSeparator key={`separator${index}`} />);
			}
			return;
		}
		if (entry.kind === "command")
		{
			const {cmd} = entry;
			rows.push(
				<MenuItem
					handbook={cmd.key}
					icon={lightIcon(cmd.icon)}
					key={entry.id}
					label={cmd.label}
					onSelect={() => onSelect(cmd)}
					shortcut={cmd.shortcut}
				/>,
			);
			return;
		}
		const {id} = entry;
		rows.push(
			<MenuItem
				extra={<FaIcon icon="fal:chevron-right" />}
				icon={lightIcon(APP_MENU_CONFIG.icons[id])}
				key={id}
				label={APP_MENU_CONFIG.labels[id] ?? `<${id}>`}
				onSelect={(event) =>
				{
					const target =
					{
						top: event?.pageY ?? 0,
						left: event?.pageX ?? 0,
					};
					if (openSubmenu === undefined)
					{
						useOutlineStore.getState().showMenuById(id, target, cmdContext, qualifiers);
					}
					else
					{
						openSubmenu(id, target);
					}
				}}
			/>,
		);
	});
	return rows;
}
