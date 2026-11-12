import {useEffect, useRef} from "react";
import type {ReactElement} from "react";
import {createPortal} from "react-dom";
import type {ItemType} from "../layout-types.js";
import {ButtonMenu} from "./flyout/button-menu.js";
import type {ButtonMenuHandle} from "./flyout/button-menu.js";
import {MenuItem} from "./flyout/menu-item.js";
import type {MenuItemProps} from "./flyout/menu-item.js";
import {typeIcon} from "./item-type-icon.js";

/** Upstream picker: selecting runs the type's effect, then the focus leaves the picker (to body), which closes it. */
function selectType(type: ItemType, onSelect: (type: ItemType) => void): void
{
	onSelect(type);
	const active = document.activeElement;
	if (active instanceof HTMLElement)
	{
		active.blur();
	}
}

/** The node-type menu rows (`turn_into_*` commands): one MenuItem per type, no shortcut and no checked state, like upstream. */
export function nodeTypeMenuItems(
	types: readonly ItemType[],
	onSelect: (type: ItemType) => void,
): ReactElement<MenuItemProps>[]
{
	return types.map((type) => (
		<MenuItem
			key={type.key}
			className="menuItem"
			handbook={type.command}
			icon={typeIcon(type.icon)}
			label={type.label}
			onSelect={() =>
			{
				selectType(type, onSelect);
			}}
		/>
	));
}

interface ItemTypePickerProps
{
	position:
	{
		top: number;
		left: number;
	};
	types: readonly ItemType[];
	onSelect: (type: ItemType) => void;
	onClose: () => void;
}

/**
 * Upstream "item-types.picker" UiRoot: an absolutely positioned host around a
 * ButtonMenu with no button, focused on mount so it opens; blur closes it. The
 * rows sit in a Fragment so the menu gives them no arrow-key navigation.
 */
export function ItemTypePicker({position, types, onSelect, onClose}: ItemTypePickerProps)
{
	const menuRef = useRef<ButtonMenuHandle>(null);

	useEffect(() =>
	{
		menuRef.current?.focus();
	}, []);

	return createPortal(
		<div
			style={
			{
				position: "absolute",
				top: position.top,
				left: position.left,
			}}
		>
			<ButtonMenu ref={menuRef} button={null} minWidth={200} onHide={onClose}>
				<>{nodeTypeMenuItems(types, onSelect)}</>
			</ButtonMenu>
		</div>,
		document.body,
	);
}
