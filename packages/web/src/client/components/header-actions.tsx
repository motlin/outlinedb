import {selectCompletedVisibility} from "../completed-visibility.js";
import type {ReactNode} from "react";
import {locationKey} from "@outlinedb/shared";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {useChildren, useHome, useNode} from "../hooks/use-nodes.js";
import {useShowCompletedToggle} from "../hooks/use-show-completed-toggle.js";
import {useStarActions, useStars} from "../hooks/use-starred.js";
import {internalLinkUrl} from "../item-menu-model.js";
import {pickerItemTypes} from "../item-type-select.js";
import {currentTypeIcon} from "../layout-types.js";
import {useOutlineStore} from "../stores/outline.js";
import {FaIcon} from "./fa-icons.js";
import type {GearMenuHeaderItem} from "./main-menu-model.js";
import {typeIcon} from "./item-type-icon.js";

/** A header's compactable actions (upstream's share, present, star, show-completed and layout) for one pane's zoom. */
export interface HeaderActions
{
	canPresent: boolean;
	isStarred: boolean;
	showCompleted: boolean;
	layoutIcon: ReactNode;
	share: () => void;
	present: () => void;
	toggleStar: () => void;
	toggleCompleted: () => void;
	/** A revealing search forces completed rows, so upstream renders no toggle. */
	completedForced: boolean;
	/**
	 * Upstream's compact "Change layout" `getMenuAnchor`: opens the picker over the last visible flyout (the more menu
	 * itself), horizontally centered on it with its top 4px above the flyout's top.
	 */
	openLayoutPickerOverMenu: () => void;
}

/**
 * The compactable header actions acting on `zoomedId` (null is Home). `query` is a pane's committed search: the star
 * then acts on that search (the main header passes none and stars the page, like upstream).
 */
export function useHeaderActions(zoomedId: string | null, query: string | null = null): HeaderActions
{
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const searchQuery = useOutlineStore((state) => state.searchQuery);
	const openPresentation = useOutlineStore((state) => state.openPresentation);
	const showItemTypePicker = useOutlineStore((state) => state.showItemTypePicker);
	const toggleCompleted = useShowCompletedToggle();
	const {stars, unavailable: starsUnavailable} = useStars();
	const {toggleStar} = useStarActions();
	const starKey = locationKey(
		{
			nodeId: zoomedId,
			query,
		},
	);
	const zoomedNode = useNode(zoomedId);
	const home = useHome();
	const rootChildren = useChildren(null);
	return {
		canPresent: zoomedId === null ? (rootChildren.data?.length ?? 0) > 0 : zoomedNode.data?.hasChildren === true,
		isStarred: stars.some((star) => star.key === starKey),
		showCompleted,
		completedForced: selectCompletedVisibility(
			{
				showCompleted,
				searchQuery,
			},
		).forced,
		layoutIcon: (
			<FaIcon
				icon={typeIcon(
					currentTypeIcon(zoomedId === null ? home.data?.layoutMode : zoomedNode.data?.data.layoutMode),
				)}
			/>
		),
		share: () =>
		{
			if (zoomedId !== null)
			{
				window.open(internalLinkUrl(zoomedId), "_blank", "noopener");
			}
		},
		present: () =>
		{
			openPresentation(zoomedId ?? "root");
		},
		toggleStar: () =>
		{
			if ((zoomedId !== null || query) && !starsUnavailable)
			{
				void toggleStar(
					{
						nodeId: zoomedId,
						query: query === "" ? null : query,
					},
				);
			}
		},
		toggleCompleted,
		openLayoutPickerOverMenu: () =>
		{
			const flyout = [...document.querySelectorAll(".flyout.menu")]
				.map((element) => element.getBoundingClientRect())
				.findLast((rect) => rect.width > 0 && rect.height > 0);
			if (flyout)
			{
				showItemTypePicker(
					{
						nodeIds: [zoomedId ?? HOME_TARGET],
						position:
						{
							top: flyout.top - 4,
							left: flyout.left + flyout.width / 2,
						},
					},
				);
			}
		},
	};
}

/**
 * The compactable actions as more-menu rows, like upstream's `more-menu.menu.header.*`. Change layout has no element
 * of its own, so its picker opens over the more menu, like upstream.
 */
export function compactHeaderItems(
	actions: HeaderActions,
	zoomedId: string | null,
	onToday?: () => void,
	query: string | null = null,
): GearMenuHeaderItem[]
{
	const items: GearMenuHeaderItem[] = [];
	if (onToday !== undefined)
	{
		items.push(
			{
				label: "Today",
				icon: <FaIcon icon="fal:calendar-day" />,
				onSelect: onToday,
			},
		);
	}
	if (zoomedId !== null)
	{
		items.push(
			{
				label: "Share",
				icon: <FaIcon icon="fal:user-plus" />,
				onSelect: actions.share,
			},
		);
	}
	items.push(
		{
			label: "Present",
			icon: <FaIcon icon="fal:play" />,
			onSelect: actions.present,
			disabled: !actions.canPresent,
		},
	);
	if (zoomedId !== null || query)
	{
		items.push(
			{
				label: actions.isStarred ? "Unstar" : "Star",
				icon: actions.isStarred ? (
					<FaIcon
						icon="fas:star"
						style={
						{
							color: "var(--wf-text-spark)",
						}}
					/>
				) : (
					<FaIcon icon="fal:star" fixedWidth />
				),
				handbook: "starring.star",
				onSelect: actions.toggleStar,
			},
		);
	}
	if (!actions.completedForced)
	{
		items.push(
			{
				label: actions.showCompleted ? "Hide completed" : "Show completed",
				icon: <FaIcon icon="fal:check" />,
				onSelect: actions.toggleCompleted,
			},
		);
	}
	if (pickerItemTypes([zoomedId ?? HOME_TARGET]).length > 0)
	{
		items.push(
			{
				label: "Change layout",
				icon: actions.layoutIcon,
				onSelect: actions.openLayoutPickerOverMenu,
			},
		);
	}
	return items;
}
