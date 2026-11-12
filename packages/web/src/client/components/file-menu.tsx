import type {ReactNode} from "react";
import {FaIcon} from "./fa-icons.js";
import type {FaIconKey} from "./fa-icons.js";
import {ButtonMenu} from "./flyout/button-menu.js";
import {MenuItem} from "./flyout/menu-item.js";

export interface FileMenuActions
{
	/** The inline preview's menu only; the full-screen viewer is already full screen. */
	showFullScreen?: () => void;
	viewOriginal: () => void;
	download: () => void;
	openSettings: () => void;
}

export interface FileMenuRow
{
	label: string;
	icon: FaIconKey;
	onSelect: () => void;
}

/**
 * Upstream's image menu rows, in order: Show full-screen (inline preview only), View original, Download, Settings.
 * Delete is left out: removing a file needs a metadata write the public API cannot do.
 */
export function fileMenuRows(actions: FileMenuActions): FileMenuRow[]
{
	return [
		...(actions.showFullScreen === undefined
			? []
			: [
					{
						label: "Show full-screen",
						icon: "fal:arrows-maximize" as const,
						onSelect: actions.showFullScreen,
					},
				]),
		{
			label: "View original",
			icon: "fal:arrow-up-right-from-square",
			onSelect: actions.viewOriginal,
		},
		{
			label: "Download",
			icon: "fal:arrow-down-long",
			onSelect: actions.download,
		},
		{
			label: "Settings",
			icon: "fal:gear",
			onSelect: actions.openSettings,
		},
	];
}

const TRIGGER_CLASS =
	" cursor-pointer w-[32px] h-[32px] rounded-pill overflow-hidden bg-primary text-default text-base opacity-75 hover:opacity-95 active:opacity-75 flex items-center justify-center relative ";

/** Upstream's `ButtonMenu.keep-overlay` around the 32px ellipsis pill. Rows act on mousedown, like upstream's `MenuItem`. */
export function FileMenu({nodeId, rows}: {nodeId: string; rows: readonly FileMenuRow[]}): ReactNode
{
	return (
		<ButtonMenu
			for={nodeId}
			className="keep-overlay"
			button={
				<div className={TRIGGER_CLASS}>
					<FaIcon icon="fal:ellipsis-vertical" />
				</div>
			}
		>
			<>
				{rows.map((row) => (
					<MenuItem key={row.label} label={row.label} icon={row.icon} onMouseDown={row.onSelect} />
				))}
			</>
		</ButtonMenu>
	);
}
