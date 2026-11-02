import {useItemTypeSelectDeps} from "../hooks/use-item-type-select-deps.js";
import {selectItemType} from "../item-type-select.js";
import type {ItemType} from "../layout-types.js";
import {requestedMenuEntries} from "../requested-menu.js";
import {useOutlineStore} from "../stores/outline.js";
import type {RequestedMenu} from "../stores/outline.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {ItemTypePicker} from "./layout-menu.js";

function NodeTypePickerMenu({menu}: {menu: RequestedMenu})
{
	const hideMenu = useOutlineStore((state) => state.hideMenu);
	const deps = useItemTypeSelectDeps();
	const types = requestedMenuEntries("node_type_picker", menu.cmdContext, menu.qualifiers).flatMap((entry) =>
		entry.kind === "command" ? [entry.cmd] : [],
	);
	if (types.length === 0)
	{
		return null;
	}

	const handleSelect = (type: ItemType) =>
	{
		// One undo step for the whole choice, however many nodes it turns into the type.
		void runInUndoBatch(captureOutlineView, () =>
		{
			selectItemType(type, menu.cmdContext.nodeIds, deps);
		});
	};

	return (
		<ItemTypePicker
			onClose={() =>
			{
				hideMenu("node_type_picker");
			}}
			onSelect={handleSelect}
			position={menu.target}
			types={types}
		/>
	);
}

/** Upstream's `jsx_root.menus` (`d54`): renders every menu requested by id, one per id. */
export function MenusHost()
{
	const requestedMenus = useOutlineStore((state) => state.requestedMenus);
	const picker = requestedMenus.get("node_type_picker");
	return picker === undefined ? null : <NodeTypePickerMenu menu={picker} />;
}
