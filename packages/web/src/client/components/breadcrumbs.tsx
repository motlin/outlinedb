import {Fragment, useMemo, useRef, useState} from "react";
import type {MouseEvent} from "react";
import {createBreadcrumbLayout, crumbInputsFromKey, crumbInputsKey, measureCrumbLabel} from "../breadcrumb-layout.js";
import type {BreadcrumbLayoutOptions, LayoutCrumb} from "../breadcrumb-layout.js";
import type {NodeResponse} from "../../node-types.js";
import type {MirrorInstance} from "../../mirror-path.js";
import {crumbLabel as formatCrumbLabel} from "../crumb-label.js";
import type {MentionAccount} from "../mention-pills.js";
import {useCrumbZoomOut} from "../crumb-zoom.js";
import {useContainerRect, useWindowWidth} from "../hooks/use-container-rect.js";
import {useCalendarSettings, useDayPrefix} from "../hooks/use-calendar-settings.js";
import {useAccount} from "../hooks/use-account.js";
import {useAncestors} from "../hooks/use-nodes.js";
import {useDateSettings} from "../hooks/use-preferences.js";
import {nodeUrl, useNodeNavigation} from "../navigation.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {useOutlineStore} from "../stores/outline.js";
import {BreadcrumbSeparator} from "./breadcrumb-separator.js";
import {FaIcon} from "./fa-icons.js";
import {ButtonMenu} from "./flyout/button-menu.js";
import {IconButton} from "./icon-button.js";
import {scrollPaneToTop} from "./pane-context.js";

export interface Crumb
{
	id: string;
	isRoot: boolean;
	name?: string | null;
	/** `YYYYMMDD` when the node is a 📆 Calendar day node; the Friendly day prefix applies only then. */
	dayDateId?: number | null;
	layoutMode?: string | null;
	/** The live attachment's MIME type, which picks the file icon. */
	fileType?: string | null;
}

const ROOT_CRUMB: Crumb =
{
	id: "None",
	isRoot: true,
};

interface CrumbClickEvent
{
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	button: number;
	preventDefault: () => void;
	stopPropagation: () => void;
}

interface CrumbClickState
{
	current: boolean;
	/** A search is committed (`?q=` in the URL). */
	searchActive: boolean;
}

interface CrumbClickDeps
{
	navigateToNode: (nodeId: string | null) => void;
	cancelSearch: () => void;
	/** Leave the search without its own URL push, since the crumb navigation drops `?q=`. */
	leaveSearch: () => void;
	scrollToTop: () => void;
	focusWindow: () => void;
}

/**
 * Plain clicks focus the window, exit any committed search, navigate in-app and scroll to the top, pushing one history
 * entry so a single Back returns to the search; modified and middle clicks fall through to the anchor's href. The root
 * Home is only clickable during a search, which it exits.
 */
// oxlint-disable-next-line react/only-export-components -- pure click handler exported for tests and reuse by other crumb renderers
export function handleCrumbClick(
	event: CrumbClickEvent,
	crumb: Crumb,
	{current, searchActive}: CrumbClickState,
	{navigateToNode, cancelSearch, leaveSearch, scrollToTop, focusWindow}: CrumbClickDeps,
): void
{
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1)
	{
		return;
	}
	event.preventDefault();
	const rootDuringSearch = crumb.isRoot && current;
	if (rootDuringSearch)
	{
		event.stopPropagation();
	}
	focusWindow();
	if (!rootDuringSearch)
	{
		if (searchActive)
		{
			leaveSearch();
		}
		navigateToNode(crumb.isRoot ? null : crumb.id);
	}
	else if (searchActive)
	{
		cancelSearch();
	}
	scrollToTop();
}

/** Upstream crumbs never take focus on mousedown, so the editor keeps its caret until navigation. */
// oxlint-disable-next-line react/only-export-components -- pure handler exported for tests
export function preventCrumbMouseDown(event: {preventDefault: () => void}): void
{
	event.preventDefault();
}

function focusBrowserWindow(): void
{
	window.focus();
}

/** The main outline scrolls the window, or its own scroller while a pane is open, like upstream. */
function scrollOutlineToTop(): void
{
	scrollPaneToTop(MAIN_PANE_ID);
}

function noop(): void
{
}

/**
 * How crumbs render dates: the account's date format, like the pills, and the 📆 Calendar root's Friendly day names
 * setting, which upstream's crumb decorator honors too.
 */
interface CrumbDateOptions
{
	dateFormat?: string;
	timeFormat?: string | null;
	dayPrefix?: boolean;
	account?: MentionAccount;
}

/** An empty name stays empty, like upstream's empty anchor; the layout measures it as 0. */
function crumbLabel(
	{name, dayDateId}: Pick<Crumb, "name" | "dayDateId">,
	{dateFormat, timeFormat, dayPrefix, account = null}: CrumbDateOptions,
): string
{
	return formatCrumbLabel(
		name ?? "",
		{
			now: new Date(),
			dateFormat,
			timeFormat: timeFormat ?? undefined,
			dayDateId,
			dayPrefix,
			account,
		},
	);
}

const DIVIDER_CLASS = "min-w-l w-full h-px border-0 border-t border-solid border-color text-center m-0 mt-xs";

function fileIconKey(fileType: string): "fal:file-audio" | "fal:file-video" | "fal:file-image" | "fal:file"
{
	if (fileType.startsWith("audio/"))
	{
		return "fal:file-audio";
	}
	if (fileType.startsWith("video/"))
	{
		return "fal:file-video";
	}
	if (fileType.startsWith("image/"))
	{
		return "fal:file-image";
	}
	return "fal:file";
}

/** Upstream's `item:icon` decorators that reach crumbs: the file-type icon and the divider rule. */
function CrumbIcon({crumb}: {crumb: Crumb})
{
	if (crumb.layoutMode === "divider")
	{
		return <hr className={DIVIDER_CLASS} />;
	}
	if (crumb.fileType === undefined || crumb.fileType === null)
	{
		return null;
	}
	return (
		<>
			<FaIcon
				icon={fileIconKey(crumb.fileType)}
				style={
				{
					color: "var(--wf-text-tertiary)",
				}}
			/>
			{"\u00A0"}
		</>
	);
}

/** Crumb fields filled from an ancestor node. */
function crumbOfNode(node: NodeResponse): Crumb
{
	return {
		id: node.id,
		isRoot: false,
		name: node.name,
		dayDateId: node.calendar?.level === "day" ? node.calendar.dateId : null,
		layoutMode: node.data.layoutMode,
		fileType: node.attachment?.isDeleted === false ? node.attachment.fileType : null,
	};
}

function noLog(): void
{
}

const NO_DATE_OPTIONS: CrumbDateOptions = {};

interface CrumbProps
{
	crumb: Crumb;
	current: boolean;
	truncateWidth?: number | null;
	onNavigate: (nodeId: string | null) => void;
	/** A search is committed; enables the root Home so it can exit the search. */
	searchActive?: boolean;
	onCancelSearch?: () => void;
	dateOptions?: CrumbDateOptions;
	scrollToTop?: () => void;
}

/** One upstream `.breadcrumb-item`: an anchor when enabled, a div for the disabled Home at the root. */
function BreadcrumbItem({
	crumb,
	current,
	truncateWidth,
	onNavigate,
	searchActive = false,
	onCancelSearch = noop,
	dateOptions = NO_DATE_OPTIONS,
	scrollToTop = scrollOutlineToTop,
}: CrumbProps)
{
	const leaveSearch = useOutlineStore((state) => state.leaveSearch);
	const disabled = crumb.isRoot && current && !searchActive;
	const className = `breadcrumb-item flex-shrink-0 whitespace-nowrap overflow-hidden truncate ${current ? "current opacity-100" : "opacity-70"}
    data-hj-suppress hover:pointer-fine:opacity-100 hover:pointer-fine:underline cursor-pointer`;
	const content = crumb.isRoot ? (
		<IconButton
			className={`homeButton ${disabled ? "disabled" : ""}`}
			disabled={disabled}
			tooltip="Home"
			data-handbook="nav.home"
		>
			<FaIcon icon="fal:house" size="lg" />
		</IconButton>
	) : (
		<>
			<CrumbIcon crumb={crumb} />
			{crumbLabel(crumb, dateOptions)}
		</>
	);
	const style =
	{
		maxWidth: truncateWidth === null ? undefined : truncateWidth,
	};

	if (disabled)
	{
		return (
			<div className={className} style={style}>
				{content}
			</div>
		);
	}
	return (
		<a
			className={className}
			style={style}
			href={crumb.isRoot ? "/" : nodeUrl(crumb.id)}
			data-item-id={crumb.isRoot ? "None" : crumb.id}
			onMouseDown={preventCrumbMouseDown}
			onClick={(event: MouseEvent<HTMLAnchorElement>) =>
			{
				handleCrumbClick(
					event,
					crumb,
					{
						current,
						searchActive,
					},
					{
						navigateToNode: onNavigate,
						cancelSearch: onCancelSearch,
						leaveSearch,
						scrollToTop,
						focusWindow: focusBrowserWindow,
					},
				);
			}}
		>
			{content}
		</a>
	);
}

const HOME_LABEL = "Home";
const OVERFLOW_MENU_GUTTER = 48;

interface BreadcrumbOverflowMenuProps
{
	items: LayoutCrumb[];
	crumbs: Map<string, Crumb>;
	currentId: string;
	maxWidth: number;
	onNavigate: (nodeId: string | null) => void;
	searchActive?: boolean;
	onCancelSearch?: () => void;
	dateOptions?: CrumbDateOptions;
	scrollToTop?: () => void;
}

/** The ellipsis flyout's body: collapsed crumbs stacked vertically, each in a div, without separators. */
export function BreadcrumbOverflowMenu({
	items,
	crumbs,
	currentId,
	maxWidth,
	onNavigate,
	searchActive,
	onCancelSearch,
	dateOptions,
	scrollToTop,
}: BreadcrumbOverflowMenuProps)
{
	return (
		<div className={`max-w-[${maxWidth}px] flex flex-col items-stretch gap-m px-m breadcrumb-overflow-menu`}>
			{items.map((item) =>
			{
				const crumb = crumbs.get(item.id);
				return crumb === undefined ? null : (
					<div key={item.id}>
						<BreadcrumbItem
							crumb={crumb}
							current={item.id === currentId}
							truncateWidth={item.truncateWidth}
							onNavigate={onNavigate}
							searchActive={searchActive}
							onCancelSearch={onCancelSearch}
							dateOptions={dateOptions}
							scrollToTop={scrollToTop}
						/>
					</div>
				);
			})}
		</div>
	);
}

/** Upstream zoomedIds: ids zoomed into while mounted that are still on the trail, plus the current one. */
function useZoomedIds(trailIds: string[], currentId: string): string[]
{
	const [zoomedIds, setZoomedIds] = useState<string[]>([currentId]);
	const onTrail = new Set(trailIds);
	const next = [...zoomedIds.filter((id) => id !== currentId && onTrail.has(id)), currentId];
	if (next.join("/") !== zoomedIds.join("/"))
	{
		setZoomedIds(next);
	}
	return next;
}

interface BreadcrumbsProps
{
	nodeId: string | null;
	/** The mirror instance the zoomed row was met in: its crumbs run through the mirror. */
	instance?: MirrorInstance | null;
	/**
	 * A side pane's zoom: crumbs zoom the pane instead of navigating the main outline, and ignore the main outline's
	 * search, which the pane does not show.
	 */
	onNavigate?: (nodeId: string | null) => void;
	/** The scroller a crumb click returns to the top; the window by default. */
	scrollToTop?: () => void;
	/** Layout sizes overriding the header defaults, as a side pane passes. */
	sizes?: BreadcrumbLayoutOptions;
	/** Width budget overriding the container's measured width. */
	maxWidth?: number;
	threeDotPosition?: "middle" | "left";
}

/** Upstream's header breadcrumbs: flat crumbs from Home to the zoomed node, truncated and middle-collapsed to fit. */
export function Breadcrumbs({
	nodeId,
	instance = null,
	onNavigate,
	scrollToTop,
	sizes,
	maxWidth,
	threeDotPosition,
}: BreadcrumbsProps)
{
	const {navigateToNode: navigateMain, cancelSearch} = useNodeNavigation();
	const crumbZoomOut = useCrumbZoomOut();
	const mainSearchActive = useOutlineStore((state) => state.searchQuery !== "");
	const searchActive = onNavigate === undefined && mainSearchActive;
	const {data: ancestors, isLoading} = useAncestors(nodeId, instance);
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerLeft, containerWidth] = useContainerRect(containerRef);
	const windowWidth = useWindowWidth();
	const {dateFormat, timeFormat} = useDateSettings();
	const dayPrefix = useDayPrefix(ancestors?.find((node) => node.calendar?.root === true)?.calendar?.dayPrefix);

	const crumbs: Crumb[] =
		nodeId === null || isLoading || ancestors === undefined
			? [ROOT_CRUMB]
			: [ROOT_CRUMB, ...ancestors.map(crumbOfNode)];
	const currentId = crumbs.at(-1)?.id ?? ROOT_CRUMB.id;
	// The main outline's crumbs to an ancestor zoom out with upstream's animation; Home swaps without one, as upstream.
	const navigateToNode =
		onNavigate ??
		((id: string | null) =>
		{
			if (id === null)
			{
				navigateMain(null);
			}
			else
			{
				crumbZoomOut(
					crumbs.filter((crumb) => !crumb.isRoot).map((crumb) => crumb.id),
					id,
				);
			}
		});
	const account = useAccount();
	const dateOptions =
	{
		dateFormat,
		timeFormat,
		dayPrefix,
		account,
	};
	const inputs = crumbs.map((crumb) => (
	{
		id: crumb.id,
		label: crumb.isRoot ? HOME_LABEL : crumbLabel(crumb, dateOptions),
	}));

	const zoomedIds = useZoomedIds(
		crumbs.map((crumb) => crumb.id),
		currentId,
	);

	// Upstream memoizes on width and the joined id path, not on array identity.
	const inputsKey = crumbInputsKey(inputs);
	const zoomedKey = zoomedIds.join("/");
	const {itemGap, rightMargin, minItemWidth, ellipsisWidth} = sizes ?? {};
	const layout = useMemo(
		() =>
			createBreadcrumbLayout(
				{
					itemGap,
					rightMargin,
					minItemWidth,
					ellipsisWidth,
					threeDotPosition,
				},
				(label) => measureCrumbLabel(label),
			),
		[itemGap, rightMargin, minItemWidth, ellipsisWidth, threeDotPosition],
	);
	const layoutWidth = maxWidth ?? containerWidth;
	const visible = useMemo(
		() => layout.calculateVisibleItems(crumbInputsFromKey(inputsKey), layoutWidth, zoomedKey.split("/")),
		[layout, layoutWidth, inputsKey, zoomedKey],
	);
	const chunks = layout.getItemGroupsWithLeftOffset(layout.getItemGroups(visible));
	const crumbsById = new Map(crumbs.map((crumb) => [crumb.id, crumb]));

	return (
		<div
			ref={containerRef}
			className="breadcrumbs grow shrink min-w-0 flex gap-m items-center text-s leading-base overflow-hidden"
		>
			{chunks.flatMap(({items, leftOffset}) =>
			{
				if (items[0]?.group === 1)
				{
					return [
						<ButtonMenu
							key={`more-${leftOffset}-${currentId}`}
							actOnHover
							button={
								<IconButton size="md">
									<FaIcon icon="fal:ellipsis" />
								</IconButton>
							}
						>
							<BreadcrumbOverflowMenu
								items={items}
								crumbs={crumbsById}
								currentId={currentId}
								maxWidth={windowWidth - leftOffset - containerLeft - OVERFLOW_MENU_GUTTER}
								onNavigate={navigateToNode}
								searchActive={searchActive}
								onCancelSearch={cancelSearch}
								dateOptions={dateOptions}
								scrollToTop={scrollToTop}
							/>
						</ButtonMenu>,
						<BreadcrumbSeparator key={`breadcrumb-icon-${leftOffset}`} />,
					];
				}
				return items.flatMap((item) =>
				{
					const crumb = crumbsById.get(item.id);
					if (crumb === undefined)
					{
						return [];
					}
					const current = item.id === currentId;
					const element = (
						<BreadcrumbItem
							key={crumb.id}
							crumb={crumb}
							current={current}
							truncateWidth={item.truncateWidth}
							onNavigate={navigateToNode}
							searchActive={searchActive}
							onCancelSearch={cancelSearch}
							dateOptions={dateOptions}
							scrollToTop={scrollToTop}
						/>
					);
					return current ? [element] : [element, <BreadcrumbSeparator key={`${crumb.id}-separator`} />];
				});
			})}
		</div>
	);
}

/** Crumbs outside the header trail: the account's date format and the 📆 Calendar's Friendly day names setting. */
function useCrumbDateOptions(): CrumbDateOptions
{
	const {dateFormat, timeFormat} = useDateSettings();
	const {dayPrefix} = useCalendarSettings(noLog).settings;
	const account = useAccount();
	return {
		dateFormat,
		timeFormat,
		dayPrefix,
		account,
	};
}

/** A backlink's ancestors laid out flat, without the header's truncation engine. */
export function FlatCrumbs({crumbs}: {crumbs: Crumb[]})
{
	const {navigateToNode} = useNodeNavigation();
	const dateOptions = useCrumbDateOptions();
	return (
		<div className="breadcrumbs grow shrink min-w-0 flex gap-m items-center text-s leading-base overflow-hidden">
			{crumbs.map((crumb, index) => (
				<Fragment key={crumb.id}>
					{index > 0 ? <BreadcrumbSeparator /> : null}
					<BreadcrumbItem
						crumb={crumb}
						current={false}
						truncateWidth={null}
						onNavigate={navigateToNode}
						dateOptions={dateOptions}
					/>
				</Fragment>
			))}
		</div>
	);
}

// Upstream's Found Dates crumbs pass `sizes: {minItemWidth: 80}` and `threeDotPosition: "left"`.
const leftCollapseLayout = createBreadcrumbLayout(
	{
		minItemWidth: 80,
		threeDotPosition: "left",
	},
	(label) => measureCrumbLabel(label),
);

/**
 * Upstream GuiCrumbs.Widget with hideCurrent and threeDotPosition "left": the ancestors of an item, the widest
 * truncated and the leftmost collapsed into an ellipsis menu to fit the row, with no separator after the last.
 */
export function LeftCollapsingCrumbs({
	crumbs,
	currentId = "",
	onNavigate,
}: {
	crumbs: Crumb[];
	/** The crumb drawn as `current opacity-100`; none by default. */
	currentId?: string;
	/** Replaces the default zoom, e.g. to close a dialog first. */
	onNavigate?: (nodeId: string | null) => void;
})
{
	const navigation = useNodeNavigation();
	const navigateToNode = onNavigate ?? navigation.navigateToNode;
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerLeft, containerWidth] = useContainerRect(containerRef);
	const windowWidth = useWindowWidth();
	const dateOptions = useCrumbDateOptions();
	const inputs = crumbs.map((crumb) => (
	{
		id: crumb.id,
		label: crumb.isRoot ? HOME_LABEL : crumbLabel(crumb, dateOptions),
	}));
	const inputsKey = crumbInputsKey(inputs);
	const visible = useMemo(
		() => leftCollapseLayout.calculateVisibleItems(crumbInputsFromKey(inputsKey), containerWidth, []),
		[containerWidth, inputsKey],
	);
	const chunks = leftCollapseLayout.getItemGroupsWithLeftOffset(leftCollapseLayout.getItemGroups(visible));
	const crumbsById = new Map(crumbs.map((crumb) => [crumb.id, crumb]));
	const elements = chunks.flatMap(({items, leftOffset}) =>
	{
		if (items[0]?.group === 1)
		{
			return [
				<ButtonMenu
					key={`more-${leftOffset}`}
					actOnHover
					button={
						<IconButton size="md">
							<FaIcon icon="fal:ellipsis" />
						</IconButton>
					}
				>
					<BreadcrumbOverflowMenu
						items={items}
						crumbs={crumbsById}
						currentId={currentId}
						maxWidth={windowWidth - leftOffset - containerLeft - OVERFLOW_MENU_GUTTER}
						onNavigate={navigateToNode}
						dateOptions={dateOptions}
					/>
				</ButtonMenu>,
			];
		}
		return items.flatMap((item) =>
		{
			const crumb = crumbsById.get(item.id);
			return crumb === undefined
				? []
				: [
						<BreadcrumbItem
							key={crumb.id}
							crumb={crumb}
							current={crumb.id === currentId}
							truncateWidth={item.truncateWidth}
							onNavigate={navigateToNode}
							dateOptions={dateOptions}
						/>,
					];
		});
	});
	return (
		<div
			ref={containerRef}
			className="breadcrumbs grow shrink min-w-0 flex gap-m items-center text-s leading-base overflow-hidden"
		>
			{elements.flatMap((element, index) =>
				index === 0 ? [element] : [<BreadcrumbSeparator key={`separator-${element.key}`} />, element],
			)}
		</div>
	);
}
