import {useEffect, useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {locateCell} from "../table-cache.js";
import type {MirrorsResponse, NodeResponse} from "../../node-types.js";
import {useDateSettings} from "../hooks/use-preferences.js";
import {readJson} from "../read-json.js";
import {buildItemMenu, hasFooter} from "../item-menu-model.js";
import {qualifyItemMenu} from "../app-menu.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import type {ItemMenuKey} from "../item-menu-model.js";
import {formatMenuTimestamp} from "../menu-timestamp.js";
import {useOutlineStore} from "../stores/outline.js";
import type {SortDirection} from "../sort-children.js";
import {ButtonMenu} from "./flyout/button-menu.js";
import {MenuSeparator} from "./flyout/menu-item.js";
import {renderAssembledMenu} from "./assembled-menu.js";
import {usePaneId} from "./pane-context.js";

/**
 * Banner shown at the top of context menu for mirror nodes.
 * Shows mirror count with a "See them" link that opens a modal.
 */
function MirrorBanner({
	originalNodeId,
	onShowMirrors,
}: {
	originalNodeId: string;
	onShowMirrors: (data: MirrorsResponse) => void;
})
{
	const [mirrorsData, setMirrorsData] = useState<MirrorsResponse | null>(null);

	useEffect(() =>
	{
		void (async () =>
		{
			try
			{
				const response = await fetch(`/api/v1/nodes/${encodeURIComponent(originalNodeId)}/mirrors`);
				if (response.ok)
				{
					const data = await readJson<MirrorsResponse>(response);
					setMirrorsData(data);
				}
			}
			catch
			{
				// The mirrors badge is optional; a failed lookup just leaves it hidden.
			}
		})();
	}, [originalNodeId]);

	if (!mirrorsData || mirrorsData.mirrors.length <= 1)
	{
		return null;
	}

	return (
		<MirrorBannerView
			count={mirrorsData.mirrors.length}
			onSeeThem={() =>
			{
				onShowMirrors(mirrorsData);
			}}
		/>
	);
}

/** Upstream's banner markup: `Node has N mirrors.` and a "See them" link that keeps focus on the menu trigger. */
export function MirrorBannerView({count, onSeeThem}: {count: number; onSeeThem: () => void})
{
	return (
		<div className="flex flex-wrap justify-center py-m bg-tertiary !mt-0 mb-1.5 rounded-t-md border-b border-primary text-primary text-2xs">
			<span>Node has {count} mirrors.</span>
			{/* Upstream's link prevents mousedown so focus stays on the menu trigger and the menu stays open. */}
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/anchor-is-valid -- verbatim upstream markup */}
			<a
				className="underline my-0 mx-xs"
				onClick={(event) =>
				{
					event.stopPropagation();
					onSeeThem();
				}}
				onMouseDown={(event) =>
				{
					event.preventDefault();
				}}
			>
				See them
			</a>
		</div>
	);
}

/** The node whose mirrors the banner lists: the original of a mirror, or an original that has mirrors; else none. */
export function mirrorBannerOriginalId(
	node: Pick<NodeResponse, "id" | "isMirror" | "hasMirrors" | "originalNodeId">,
): string | null
{
	if (node.isMirror === true)
	{
		return node.originalNodeId ?? null;
	}
	return node.hasMirrors === true ? node.id : null;
}

export interface ItemMenuActions
{
	onOpenInPane: () => void;
	onComplete: () => void;
	onAddNote: () => void;
	onAddDate: () => void;
	onPresent: () => void;
	onMoveTo: () => void;
	onMirrorTo: () => void;
	onMirror: () => void;
	onDetachMirror: () => void;
	onDuplicate: () => void;
	onDuplicateColumn?: () => void;
	onDeleteColumn?: () => void;
	onExport: () => void;
	onCopyLink: () => void;
	onMakeTemplate: () => void;
	onDelete: () => void;
	onExpandAll: () => void;
	onCollapseAll: () => void;
	onSort: (direction: SortDirection) => void;
}

function footerTimestamp(
	label: string,
	unixSeconds: number | null,
	now: Date,
	formats:
	{
		dateFormat: string;
		timeFormat: string;
	},
)
{
	return (
		<div className="flex flex-col gap-s">
			<div>
				<b>{label}</b> {unixSeconds === null ? "Unknown" : formatMenuTimestamp(unixSeconds, now, formats)}
			</div>
		</div>
	);
}

/**
 * Upstream's item-menu body (`AV`): returned as one Fragment so MenuBody sees no navigable
 * items and ArrowDown highlights nothing. Rows come from the pure item-menu model.
 */
export function ItemMenuBody({
	node,
	actions,
	onClose,
	onShowMirrors,
}: {
	node: NodeResponse;
	actions: ItemMenuActions;
	onClose: () => void;
	onShowMirrors: (data: MirrorsResponse) => void;
})
{
	// The body mounts each time the menu opens, so "now" is the moment it opened.
	const [now] = useState(() => new Date());
	const dateSettings = useDateSettings();
	const paneId = usePaneId();
	const queryClient = useQueryClient();
	const cell = locateCell(queryClient, node.id);
	const qualifiers = qualifyItemMenu(node, [
		...(paneId === MAIN_PANE_ID ? [] : ["is_inside_side_pane"]),
		...(cell === null ? [] : [cell.rowIndex === 0 ? "is_table_header_cell" : "is_table_body_cell"]),
	]);
	const entries = buildItemMenu(node, qualifiers);
	const mirrorOriginalId = mirrorBannerOriginalId(node);
	/** Runs the action, then closes the menu (returning false so MenuItem does not keep it open). */
	const thenClose = (run: () => void) => (): boolean =>
	{
		run();
		onClose();
		return false;
	};
	/** Closes the menu first, for actions that move focus or open another surface. */
	const closeThen = (run: () => void) => (): boolean =>
	{
		onClose();
		run();
		return false;
	};
	// Expand all / Collapse all return true so the menu stays open; the rest close it.
	const select: Partial<Record<ItemMenuKey, () => boolean>> =
	{
		open_in_pane: closeThen(actions.onOpenInPane),
		complete: thenClose(actions.onComplete),
		add_note: closeThen(actions.onAddNote),
		add_date: closeThen(actions.onAddDate),
		present_it: closeThen(actions.onPresent),
		move_to: closeThen(actions.onMoveTo),
		mirror_to: closeThen(actions.onMirrorTo),
		mirror: closeThen(actions.onMirror),
		detach_mirror: thenClose(actions.onDetachMirror),
		duplicate: thenClose(actions.onDuplicate),
		duplicate_table_column: thenClose(() =>
		{
			actions.onDuplicateColumn?.();
		}),
		delete_table_column: thenClose(() =>
		{
			actions.onDeleteColumn?.();
		}),
		show_export: closeThen(actions.onExport),
		copy_link: thenClose(actions.onCopyLink),
		make_template: thenClose(actions.onMakeTemplate),
		delete: thenClose(actions.onDelete),
		expand_all: () =>
		{
			actions.onExpandAll();
			return true;
		},
		collapse_all: () =>
		{
			actions.onCollapseAll();
			return true;
		},
		sort_children_asc: thenClose(() =>
		{
			actions.onSort("asc");
		}),
		sort_children_desc: thenClose(() =>
		{
			actions.onSort("desc");
		}),
	};

	return (
		<>
			{mirrorOriginalId !== null && (
				<MirrorBanner
					onShowMirrors={(data) =>
					{
						onClose();
						onShowMirrors(data);
					}}
					originalNodeId={mirrorOriginalId}
				/>
			)}
			{renderAssembledMenu(
				entries,
				{
					cmdContext:
					{
						nodeIds: [node.id],
					},
					qualifiers,
					onSelect: (cmd) => (cmd.key === "node_type_picker" ? undefined : select[cmd.key]?.()),
					// Upstream closes the bullet menu on a click, then opens the submenu at the click's page point.
					openSubmenu: (menuId, target) =>
					{
						onClose();
						setTimeout(() =>
						{
							useOutlineStore.getState().showMenuById(
								menuId,
								target,
								{
									nodeIds: [node.id],
								},
								qualifiers,
							);
						});
					},
				},
			)}
			{hasFooter(node) && (
				<>
					<MenuSeparator key="separator4" />
					<div
						className={`flex flex-col gap-m text-tertiary text-xs px-l pt-s pb-ml whitespace-nowrap
            mobile:text-base  mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right`}
					>
						{footerTimestamp("Changed:", node.modifiedAt, now, dateSettings)}
						{footerTimestamp("Created:", node.createdAt, now, dateSettings)}
					</div>
				</>
			)}
		</>
	);
}

interface ItemMenuTriggerProps
{
	node: NodeResponse;
	/** Upstream `--item-menu-left`, from `itemMenuLeft`; omitted on the zoom title, whose CSS pins it at 65px. */
	left?: string;
	actions: ItemMenuActions;
	onOpenChange: (open: boolean) => void;
	/** Upstream fa1's controlled open state; omitted, ButtonMenu keeps its own. */
	expanded?: boolean;
	setExpanded?: (expanded: boolean) => void;
}

/** Upstream fa1's ButtonMenu placement: the flyout hangs 16px left of the trigger, up to 300px wide. */
const ITEM_MENU_OFFSET = [-16, 0] as const;

// Upstream's multi-line class templates, byte for byte (whitespace and newlines are part of the DOM contract).
const ITEM_MENU_TRIGGER_CLASS =
	"\n        [body.moving_&]:hidden\n        !absolute left-[var(--item-menu-left)] top-0\n\n        h-[var(--line-height)] pt-[var(--wf-content-padding-top)]\n        flex items-center\n        opacity-100 cursor-pointer transition-opacity duration-200\n        \n        itemMenu\n      ";

const ITEM_MENU_DOTS_CLASS =
	"\n            block size-xl rounded-[12px]\n            text-tertiary\n            hover:bg-tertiary\n            [.menu:focus_&]:text-quaternary\n            [.menu:focus_&]:bg-tertiary\n          ";

function blurActiveElement(): void
{
	if (document.activeElement instanceof HTMLElement)
	{
		document.activeElement.blur();
	}
}

/**
 * Upstream's bullet-menu trigger: a ButtonMenu `div.menu.itemMenu` holding the three-dot
 * button. The row mounts it only while hovered or while its menu is open.
 */
export function ItemMenuTrigger({node, left, actions, onOpenChange, expanded, setExpanded}: ItemMenuTriggerProps)
{
	return (
		<ButtonMenu
			className={ITEM_MENU_TRIGGER_CLASS}
			expanded={expanded}
			maxWidth={300}
			offset={ITEM_MENU_OFFSET}
			placement="bottom-start"
			setExpanded={setExpanded}
			onHide={() =>
			{
				onOpenChange(false);
			}}
			onShow={() =>
			{
				onOpenChange(true);
			}}
			style={
				left === undefined
					? undefined
					:
						{
							["--item-menu-left" as string]: left,
						}
			}
			button={
				<span className={ITEM_MENU_DOTS_CLASS}>
					<svg viewBox="0 0 24 24" fill="currentColor" className="block size-full">
						<circle cx="6" cy="12" r="2" />
						<circle cx="12" cy="12" r="2" />
						<circle cx="18" cy="12" r="2" />
					</svg>
				</span>
			}
		>
			<ItemMenuBody
				actions={actions}
				node={node}
				onClose={blurActiveElement}
				onShowMirrors={(data) =>
				{
					useOutlineStore.getState().openMirrorsDialog(data.originalId);
				}}
			/>
		</ButtonMenu>
	);
}
