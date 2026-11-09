import {HOME_TARGET} from "@outlinedb/shared/types";
import {useItemTypeSelectDeps} from "../hooks/use-item-type-select-deps.js";
import {pickerItemTypes, selectItemType} from "../item-type-select.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import type {HeaderActions} from "./header-actions.js";
import {ButtonMenu} from "./flyout/button-menu.js";
import {IconButton} from "./icon-button.js";
import {nodeTypeMenuItems} from "./layout-menu.js";

/**
 * Upstream's header "Change layout" control (`Fb4`): a ButtonMenu around an IconButton showing the current layout's
 * icon, listing the `turn_into_*` rows. It renders nothing when the item has no types to turn into.
 */
export function LayoutButtonMenu({
	nodeId,
	layoutIcon,
}: {
	nodeId: string | null;
	layoutIcon: HeaderActions["layoutIcon"];
}) {
	const deps = useItemTypeSelectDeps();
	const target = nodeId ?? HOME_TARGET;
	const types = pickerItemTypes([target]);
	if (types.length === 0) {
		return null;
	}
	return (
		<ButtonMenu
			button={
				<IconButton data-handbook="bullet.layout" tooltip="Change layout">
					{layoutIcon}
				</IconButton>
			}
		>
			<>
				{nodeTypeMenuItems(types, (type) => {
					// One undo step for the whole choice.
					void runInUndoBatch(captureOutlineView, () => {
						selectItemType(type, [target], deps);
					});
				})}
			</>
		</ButtonMenu>
	);
}
