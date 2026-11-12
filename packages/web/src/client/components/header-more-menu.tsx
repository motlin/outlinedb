import {useQueryClient} from "@tanstack/react-query";
import {useEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {useNavigate} from "react-router-dom";
import {useExpandAll} from "../hooks/use-nodes.js";
import {useChangelogUnread} from "../hooks/use-whats-new.js";
import {movePane} from "../navigation.js";
import {cachedResolvedId} from "../node-cache.js";
import {useOutlineStore} from "../stores/outline.js";
import {FaIcon} from "./fa-icons.js";
import {ButtonMenu} from "./flyout/button-menu.js";
import type {ButtonMenuHandle} from "./flyout/button-menu.js";
import {compactHeaderItems, useHeaderActions} from "./header-actions.js";
import {IconButton} from "./icon-button.js";
import {useHelpMenuRows, useMainMenuRows} from "./main-menu-rows.js";
import {movePaneItems} from "./move-pane-items.js";

/** Where the Help submenu hangs: upstream anchors it at the main flyout's top and horizontal centre. */
interface HelpAnchor
{
	top: number;
	left: number;
	width: number;
}

/** The Help submenu: an empty-button ButtonMenu focused on mount, so it opens at once and closes on blur. */
function HelpSubmenu({
	anchor,
	changelogUnread,
	onClose,
}: {
	anchor: HelpAnchor;
	changelogUnread: boolean;
	onClose: () => void;
})
{
	const openChangelog = useOutlineStore((state) => state.openChangelog);
	const rows = useHelpMenuRows(
		{
			changelogUnread,
			onOpenChangelog: openChangelog,
		},
	);
	const menu = useRef<ButtonMenuHandle>(null);
	useEffect(() =>
	{
		menu.current?.focus();
	}, []);
	return createPortal(
		<ButtonMenu
			button={<div />}
			minWidth={anchor.width - 12}
			onHide={onClose}
			ref={menu}
			style={
			{
				position: "absolute",
				top: anchor.top - 4,
				left: anchor.left + anchor.width / 2,
			}}
		>
			{rows}
		</ButtonMenu>,
		document.body,
	);
}

/** The open main flyout's page rect: the last portaled `.flyout` in the body. */
function mainFlyoutAnchor(): HelpAnchor | null
{
	const flyouts = document.body.querySelectorAll(":scope > .flyout.menu");
	const flyout = flyouts[flyouts.length - 1];
	if (!flyout)
	{
		return null;
	}
	const rect = flyout.getBoundingClientRect();
	return {
		top: rect.top + window.scrollY,
		left: rect.left + window.scrollX,
		width: rect.width,
	};
}

interface HeaderMoreMenuProps
{
	/** The zoom the menu's actions act on (null is Home). */
	zoomedId: string | null;
	/** A pane's committed search query; its Star entry stars that search. Omitted for the main header. */
	query?: string | null;
	/** The pane this kebab sits in (`main` for the main pane); its Move pane left/right rows move it. */
	paneId: string;
	/** Upstream's compact header: the compactable actions move into this menu. */
	compact: boolean;
	/** Set for a pane narrower than 530px: Today leaves the header for a row at the top of this menu. */
	onToday?: () => void;
	onUndo: () => void;
	onRedo: () => void;
}

/**
 * The header kebab (upstream's gearMenu wrapper, no tooltip). While What's New has unread entries the Help row and the
 * kebab carry upstream's blue dot; with panes open only the last pane's kebab shows it. Its Expand/Collapse all act on
 * the zoomed item's whole subtree (every top-level item at Home).
 */
export function HeaderMoreMenu({zoomedId, query = null, paneId, compact, onToday, onUndo, onRedo}: HeaderMoreMenuProps)
{
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const panes = useOutlineStore((state) => state.panes);
	const openSettings = useOutlineStore((state) => state.openSettings);
	const expandAll = useExpandAll();
	const actions = useHeaderActions(zoomedId, query);
	const [helpAnchor, setHelpAnchor] = useState<HelpAnchor | null>(null);
	const changelogUnread = useChangelogUnread();
	// Upstream `showBlueDot: !WF.Panes.any() || WF.Panes.panes().at(-1)?.id === pane?.id`.
	const showBlueDot = panes.length === 0 || panes.at(-1)?.id === paneId;
	const rows = useMainMenuRows(
		{
			changelogUnread,
			headerItems: compact ? compactHeaderItems(actions, zoomedId, onToday, query) : [],
			paneItems: movePaneItems(
				{
					panes,
				},
				paneId,
				(id, index) =>
				{
					movePane(
						navigate,
						id,
						index,
						(locationId) => cachedResolvedId(queryClient, locationId) ?? locationId,
					);
				},
			),
			onCollapseAll: () =>
			{
				expandAll(zoomedId, false);
			},
			onExpandAll: () =>
			{
				expandAll(zoomedId, true);
			},
			onOpenHelp: () =>
			{
				setHelpAnchor(mainFlyoutAnchor());
			},
			onOpenSettings: openSettings,
			onRedo,
			onUndo,
		},
	);
	return (
		<>
			<ButtonMenu
				button={
					<IconButton>
						<FaIcon icon="fal:ellipsis-vertical" size="lg" />
						{showBlueDot && changelogUnread && (
							<div className="w-[7px] h-[7px] bg-tint rounded-circle absolute top-xs right-xs" />
						)}
					</IconButton>
				}
				className="gearMenu"
				maxHeight={700}
				minWidth={100}
				offset={[-8, 0]}
			>
				{rows}
			</ButtonMenu>
			{helpAnchor && (
				<HelpSubmenu
					anchor={helpAnchor}
					changelogUnread={changelogUnread}
					onClose={() =>
					{
						setHelpAnchor(null);
					}}
				/>
			)}
		</>
	);
}
