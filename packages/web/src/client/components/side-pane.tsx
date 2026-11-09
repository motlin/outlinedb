import type {CSSProperties, ReactNode} from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useNavigate} from "react-router-dom";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {useNavigateToToday} from "../hooks/use-navigate-to-today.js";
import {useCalendarTooltipSeen} from "../hooks/use-preferences.js";
import {CalendarTodayControl} from "./calendar-today-control.js";
import {movePane} from "../navigation.js";
import {cachedResolvedId, readNode} from "../node-cache.js";
import {MAIN_PANE_ID, findPane} from "../pane-ids.js";
import type {ItemTreePane} from "../pane-ids.js";
import {bindPaneReorder} from "../pane-reorder.js";
import type {ReorderView} from "../pane-reorder.js";
import {bindPaneSeparator, handleSeparatorKey} from "../pane-resize.js";
import {paneCrumbOptions} from "../breadcrumb-layout.js";
import {MIN_PANE_WIDTH, NARROW_PANE_WIDTH, minimumPaneWidth} from "../pane-widths.js";
import {useOutlineStore, workspaceAvailableWidth, workspaceWidths} from "../stores/outline.js";
import {Breadcrumbs} from "./breadcrumbs.js";
import {FaIcon} from "./fa-icons.js";
import {POPUP_Z} from "./flyout/popover-box.js";
import {HeaderMoreMenu} from "./header-more-menu.js";
import {IconButton} from "./icon-button.js";
import {OutlineTree} from "./outline-tree.js";
import {PANE_HEADER_ACTIVE_BORDER, PaneContext, paneActivation, scrollPaneToTop} from "./pane-context.js";
import {PaneSearchBox} from "./pane-search-box.js";
import {NewPaneIcon} from "./new-pane-icon.js";

/** Upstream's workspace utilities: the pane scrollers inside never scroll sideways, whatever their own classes say. */
const WORKSPACE_SCROLLER_CLASSES = [
	"[&_[data-full-width-boundary].vertical-scrollable-container]:overflow-x-hidden",
	"[&_[data-full-width-boundary].vertical-scrollable-container]:overflow-y-auto",
	"[&_[data-full-width-boundary].vertical-scrollable-container]:overscroll-x-auto",
	"[&_[data-full-width-boundary].vertical-scrollable-container]:overscroll-y-contain",
	"[&_[data-full-width-boundary]>.vertical-scrollable-container]:overflow-x-hidden",
	"[&_[data-full-width-boundary]>.vertical-scrollable-container]:overflow-y-auto",
	"[&_[data-full-width-boundary]>.vertical-scrollable-container]:overscroll-x-auto",
	"[&_[data-full-width-boundary]>.vertical-scrollable-container]:overscroll-y-contain",
].join(" ");

/** Upstream's workspace root: a full-height row clipping the pane scroller and the workspace-level control. */
const WORKSPACE_CLASS = `relative flex h-screen max-h-screen min-h-0 items-stretch overflow-hidden bg-primary print:block print:!mr-0 print:!h-auto print:!max-h-none print:!overflow-visible ${WORKSPACE_SCROLLER_CLASSES}`;

/** A style object with CSS custom properties, which `CSSProperties` does not name. */
function cssVars(style: Record<string, string | number>): CSSProperties {
	return style;
}

const WORKSPACE_STYLE: CSSProperties = cssVars({
	"--pane-workspace-control-width": "var(--wf-header-height)",
	"--pane-workspace-left-control-width": "calc(var(--wf-space-s) + 36px)",
	marginRight: 8,
});

/** Upstream's pane: a fixed-width column that never flexes. Only the active pane prints. */
const PANE_CLASS = "group/pane relative box-border flex-none h-full max-h-full min-h-0 bg-primary flex flex-col";
const PANE_ACTIVE_PRINT_CLASS = "print:block print:!w-auto print:!min-w-0 print:!h-auto print:!max-h-none";
/** The first pane's header leaves room for the fixed left control that holds the bars toggle while the left bar is closed. */
const PANE_FIRST_CLASS = "[&_.header]:pl-[var(--pane-workspace-left-control-width)] [&_.header]:min-w-[280px]";
/** The last pane's header leaves room for the workspace-level control at the workspace's top right. */
const PANE_LAST_CLASS = "[&_.header]:pr-[var(--pane-workspace-control-width)] [&_.header]:min-w-[280px]";

/** Upstream's pane body scroller: padding 16px 32px 16px 56px, a centred project column and the Home indent. */
export const PANE_SCROLLER_CLASS =
	"flex-1 min-h-0 py-l pr-2xl overflow-auto overscroll-contain relative vertical-scrollable-container print:!overflow-visible pl-[calc(var(--wf-space-xl)+var(--side-pane-menu-gutter))] [--name-left-overhang:60px] [&>.project.root]:w-full [&>.project.root]:max-w-[700px] [&>.project.root]:mx-auto [&>.project.root]:data-[full-width-active=true]:!max-w-none [&>.project.root]:!max-w-none";
export const PANE_SCROLLER_STYLE: CSSProperties = cssVars({"--side-pane-menu-gutter": "32px"});

function paneClassName(isActive: boolean, extra = ""): string {
	return `${PANE_CLASS} ${isActive ? PANE_ACTIVE_PRINT_CLASS : "print:hidden"}${extra === "" ? "" : ` ${extra}`}`;
}

/** Upstream's blank space under a pane's last row, so the end of the outline scrolls clear of the bottom edge. */
export function DocumentEnd() {
	return <div className="document-end flex-grow flex-shrink-0 print:hidden" style={{height: 380}} />;
}

/** Upstream's item-tree pane title (`getNameText`): the plain text of the pane's zoom, Home at the root. */
function paneTitle(queryClient: QueryClient, paneId: string): string {
	const state = useOutlineStore.getState();
	const pane = findPane(state.panes, paneId);
	const zoomedId = pane === undefined ? state.zoomedNodeId : pane.zoomedId;
	return zoomedId === null ? "Home" : stripHtmlTags(readNode(queryClient, zoomedId)?.name ?? "");
}

/** Upstream's header-drag overlay, portaled to the body: the tint drop line and the ghost chip under the pointer. */
function ReorderOverlay({view}: {view: ReorderView}) {
	return createPortal(
		<>
			{view.dropLine !== null && (
				<div
					aria-hidden
					className="fixed w-xs bg-tint rounded-pill pointer-events-none print:hidden"
					style={{
						left: view.dropLine.left,
						top: view.dropLine.top,
						height: view.dropLine.height,
						transform: "translateX(-50%)",
						zIndex: POPUP_Z,
					}}
				/>
			)}
			<div
				aria-hidden
				className="fixed translate-x-ml translate-y-ml flex items-center gap-s max-w-[280px] px-m py-s text-s text-primary bg-secondary border border-solid border-primary rounded-s shadow-md pointer-events-none print:hidden"
				style={{left: view.pointerX, top: view.pointerY, zIndex: POPUP_Z}}
			>
				<FaIcon className="flex-shrink-0 text-tertiary" icon="fal:grip-dots-vertical" />
				<span className="truncate">{view.title}</span>
			</div>
		</>,
		document.body,
	);
}

/**
 * Upstream's pane workspace (`[data-pane-workspace]`): while a pane is open, a full-height row holding the pane scroll
 * container (`[data-pane-scroll-container]`, which scrolls sideways once the panes' pixel widths outgrow it) and the
 * workspace-level New pane control. The scroll container's measured width drives the pane widths. Dragging a pane
 * header reorders the panes (drop line and ghost chip while dragging). In the single-document layout both wrappers
 * are `display: contents`, so the fixed header and document-scrolled outline lay out as before.
 */
export function PaneWorkspace({children}: {children: ReactNode}) {
	const panesOpen = useOutlineStore((state) => state.panes.length > 0);
	const resizing = useOutlineStore((state) => state.paneResizing);
	const workspaceWidth = useOutlineStore((state) => state.workspaceWidth);
	const leftBarOffset = useOutlineStore((state) => state.leftBarOffset);
	const setWorkspaceWidth = useOutlineStore((state) => state.setWorkspaceWidth);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [reorder, setReorder] = useState<ReorderView | null>(null);
	// Upstream measures the scroll container into `workspaceWidth`; the store rescales the panes when it changes.
	useEffect(() => {
		const scroller = scrollRef.current;
		if (!panesOpen || scroller === null || typeof ResizeObserver === "undefined") {
			return () => {};
		}
		const measure = () => {
			setWorkspaceWidth(scroller.clientWidth);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		return () => {
			observer.disconnect();
			setWorkspaceWidth(null);
		};
	}, [panesOpen, setWorkspaceWidth]);
	useEffect(() => {
		const scroller = scrollRef.current;
		const unbind =
			panesOpen && scroller !== null
				? bindPaneReorder(scroller, {
						getState: useOutlineStore.getState,
						title: (paneId) => paneTitle(queryClient, paneId),
						movePane: (paneId, index) => {
							movePane(navigate, paneId, index, (id) => cachedResolvedId(queryClient, id) ?? id);
						},
						onView: setReorder,
					})
				: null;
		return () => {
			unbind?.();
		};
	}, [navigate, panesOpen, queryClient]);
	return (
		<div
			className={panesOpen ? WORKSPACE_CLASS : "contents"}
			data-pane-workspace={panesOpen ? "true" : undefined}
			style={panesOpen ? WORKSPACE_STYLE : undefined}
		>
			<div
				className={
					panesOpen
						? `flex min-w-0 min-h-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden print:block print:!overflow-visible [&_.wf-pane-header]:cursor-grab${reorder === null ? "" : " cursor-grabbing [&_*]:!cursor-grabbing [&_*]:!pointer-events-none"}`
						: "contents"
				}
				data-pane-reordering={panesOpen ? (reorder === null ? "false" : "true") : undefined}
				data-pane-scroll-container={panesOpen ? "true" : undefined}
				ref={scrollRef}
			>
				{children}
				{panesOpen && resizing && (
					<div
						aria-hidden="true"
						className="flex-none print:hidden"
						style={{width: workspaceAvailableWidth({leftBarOffset, workspaceWidth})}}
					/>
				)}
			</div>
			{panesOpen && <PaneWorkspaceControl />}
			{reorder !== null && <ReorderOverlay view={reorder} />}
		</div>
	);
}

/**
 * The main outline's pane. In the single-document layout it is two `display: contents` wrappers, with no pane
 * attributes, around its header and outline, so the fixed header and document-scrolled outline lay out as before.
 * While a pane is open it is the workspace's first pane: a fixed-width column holding its header and its own scroller
 * in upstream's body wrapper, then its resize separator. It is the active pane (header border tinted) only while a
 * pane is open and the main outline last saw a pointerdown or focusin.
 */
export function MainPane({children}: {children: ReactNode}) {
	const panesOpen = useOutlineStore((state) => state.panes.length > 0);
	const isActive = useOutlineStore((state) => state.panes.length > 0 && state.activePaneId === MAIN_PANE_ID);
	const width = useOutlineStore((state) => (state.panes.length > 0 ? state.paneWidths[MAIN_PANE_ID] : undefined));
	const setActivePane = useOutlineStore((state) => state.setActivePane);
	const leftControlShown = useOutlineStore((state) => state.leftBarMode !== "alwaysOpen");
	return panesOpen ? (
		<div
			id={`pane-${MAIN_PANE_ID}`}
			data-pane-id={MAIN_PANE_ID}
			data-pane-type="item-tree"
			data-pane-active={isActive ? "true" : "false"}
			className={`main-pane ${paneClassName(isActive, leftControlShown ? PANE_FIRST_CLASS : "")}`}
			style={{width, minWidth: MIN_PANE_WIDTH}}
			{...paneActivation(MAIN_PANE_ID, setActivePane)}
		>
			<div className="flex flex-1 min-h-0 flex-col" data-full-width-boundary="true" data-split-pane="true">
				{children}
			</div>
			<PaneSeparator index={0} />
		</div>
	) : (
		<div className="main-pane contents">
			<div className="contents">{children}</div>
		</div>
	);
}

/**
 * Upstream's resize separator on a pane's right edge, the last pane's included: a 6px focusable `role=separator`.
 * Dragging it or pressing ArrowLeft, ArrowRight or Home resizes the pane at workspace `index` (see `resizedDivider`).
 */
function PaneSeparator({index}: {index: number}) {
	const panes = useOutlineStore((state) => state.panes);
	const paneWidths = useOutlineStore((state) => state.paneWidths);
	const workspaceWidth = useOutlineStore((state) => state.workspaceWidth);
	const leftBarOffset = useOutlineStore((state) => state.leftBarOffset);
	const setPaneWidths = useOutlineStore((state) => state.setPaneWidths);
	const setPaneResizing = useOutlineStore((state) => state.setPaneResizing);
	const ref = useRef<HTMLDivElement>(null);
	const ids = [MAIN_PANE_ID, ...panes.map((pane) => pane.id)];
	const widths = workspaceWidths({panes, paneWidths});
	const available = workspaceAvailableWidth({leftBarOffset, workspaceWidth});
	const width = widths[index] ?? MIN_PANE_WIDTH;
	const nextId = ids[index + 1];
	const nextWidth = widths[index + 1];
	const deps = {
		getWidths: () => workspaceWidths(useOutlineStore.getState()),
		available: () => workspaceAvailableWidth(useOutlineStore.getState()),
		setWidths: setPaneWidths,
	};
	useEffect(() => {
		const separator = ref.current;
		const scroller = separator?.closest<HTMLElement>("[data-pane-scroll-container]") ?? null;
		if (separator === null || scroller === null) {
			return () => {};
		}
		return bindPaneSeparator(separator, index, {
			scroller,
			getWidths: () => workspaceWidths(useOutlineStore.getState()),
			available: () => workspaceAvailableWidth(useOutlineStore.getState()),
			setWidths: setPaneWidths,
			setResizing: setPaneResizing,
		});
	}, [index, setPaneResizing, setPaneWidths]);
	return (
		<div
			aria-controls={nextId === undefined ? `pane-${ids[index]}` : `pane-${ids[index]} pane-${nextId}`}
			aria-label={`Resize pane ${index + 1}`}
			aria-orientation="vertical"
			aria-valuemin={Math.round(minimumPaneWidth(widths, index, available))}
			aria-valuenow={Math.round(width)}
			aria-valuetext={
				nextWidth === undefined
					? `${Math.round(width)} pixels`
					: `${Math.round(width)} and ${Math.round(nextWidth)} pixels`
			}
			className="absolute top-0 right-0 bottom-0 w-[6px] cursor-col-resize touch-none select-none border-r border-solid border-primary hover:bg-tertiary focus-visible:bg-tertiary focus-visible:outline-none print:hidden"
			data-pane-drag-ignore="true"
			onKeyDown={(event) => {
				handleSeparatorKey(event, index, deps);
			}}
			ref={ref}
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- upstream's focusable, draggable separator is a div; an hr cannot take pointer or key handlers
			role="separator"
			style={{zIndex: 200}}
			tabIndex={0}
		/>
	);
}

/**
 * Upstream's `pane-workspace-control`: one per workspace, at its top right. Its New pane button opens another pane on
 * the last pane's zoom after it and focuses it.
 */
function PaneWorkspaceControl() {
	const last = useOutlineStore((state) => state.panes.at(-1));
	const openPane = useOutlineStore((state) => state.openPane);
	return (
		<div
			className="wf-header pane-workspace-control box-border absolute top-0 right-0 flex h-[var(--wf-header-height)] w-[var(--pane-workspace-control-width)] items-center justify-center border-x border-solid border-primary bg-primary [&_.iconButton]:text-primary print:hidden"
			style={{zIndex: 200}}
		>
			<IconButton
				onClick={() => {
					if (last !== undefined) {
						openPane(last.zoomedId, {sourcePaneId: last.id});
					}
				}}
				shortcut="⌃R"
				tooltip="New pane"
			>
				<NewPaneIcon />
			</IconButton>
		</div>
	);
}

interface PaneActions {
	onUndo: () => void;
	onRedo: () => void;
}

interface SidePaneProps extends PaneActions {
	pane: ItemTreePane;
	/** The pane's workspace index, counting the main pane as 0. */
	index: number;
	/** The rightmost pane's header leaves room for the workspace-level New pane control. */
	isLast: boolean;
}

/**
 * One of upstream's secondary item-tree panes (`[data-pane-id][data-pane-type=item-tree]`), opened by New pane or
 * Open in Pane. It zooms independently of the main outline and the other panes: its bullets zoom the pane, not the URL.
 * Its compact `.wf-pane-header` follows upstream's: Back/Forward through the pane's own history, breadcrumbs (whose
 * root crumb is Home) that zoom the pane, the compact search circle filtering only this pane, Today zooming the pane,
 * the kebab holding the compactable actions for the pane's zoom, and Close pane. Its body follows upstream's wrappers,
 * and its resize separator sits on its right edge.
 */
function SidePane({pane, index, isLast, onUndo, onRedo}: SidePaneProps) {
	const {id} = pane;
	const width = useOutlineStore((state) => state.paneWidths[id]);
	const zoomPane = useOutlineStore((state) => state.zoomPane);
	const closePane = useOutlineStore((state) => state.closePane);
	const paneBack = useOutlineStore((state) => state.paneBack);
	const paneForward = useOutlineStore((state) => state.paneForward);
	const setPaneQuery = useOutlineStore((state) => state.setPaneQuery);
	const isActive = useOutlineStore((state) => state.activePaneId === id);
	const setActivePane = useOutlineStore((state) => state.setActivePane);
	const context = useMemo(
		() => ({
			id,
			zoom: (zoomedId: string | null) => {
				zoomPane(id, zoomedId);
			},
		}),
		[id, zoomPane],
	);
	const navigateToToday = useNavigateToToday(context.zoom);
	const narrow = (width ?? MIN_PANE_WIDTH) < NARROW_PANE_WIDTH;
	// Upstream hides the more menu's Today row until the calendar onboarding tooltip is seen.
	const todaySeen = useCalendarTooltipSeen();
	return (
		<div
			id={`pane-${id}`}
			data-pane-id={id}
			data-pane-type="item-tree"
			data-pane-active={isActive ? "true" : "false"}
			className={paneClassName(isActive, isLast ? PANE_LAST_CLASS : "")}
			style={{width, minWidth: MIN_PANE_WIDTH}}
			{...paneActivation(id, setActivePane)}
		>
			<div className="flex flex-1 min-h-0 flex-col" data-full-width-boundary="true" data-split-pane="true">
				<div
					className={`wf-header header bg-primary wf-pane-header border-b border-solid border-primary ${PANE_HEADER_ACTIVE_BORDER} flex-shrink-0`}
				>
					<div className="pagination">
						<IconButton
							data-handbook="nav.back"
							disabled={pane.backLocations.length === 0}
							onClick={() => {
								paneBack(id);
							}}
							tooltip="Back"
						>
							<FaIcon icon="fal:chevron-left" />
						</IconButton>
						{pane.forwardLocations.length > 0 && (
							<IconButton
								data-handbook="nav.forward"
								onClick={() => {
									paneForward(id);
								}}
								tooltip="Forward"
							>
								<FaIcon icon="fal:chevron-right" />
							</IconButton>
						)}
					</div>
					<Breadcrumbs
						nodeId={pane.zoomedId}
						onNavigate={context.zoom}
						{...paneCrumbOptions(width ?? MIN_PANE_WIDTH)}
						scrollToTop={() => {
							scrollPaneToTop(id);
						}}
					/>
					<div className="ml-auto flex self-stretch items-center gap-xs flex-shrink-0">
						<PaneSearchBox
							compact
							onCommit={(query) => {
								setPaneQuery(id, query);
							}}
							query={pane.query}
						/>
						{!narrow && (
							<CalendarTodayControl onToday={() => void navigateToToday()}>
								{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream wraps the Today IconButton in a bare clickable div; the IconButton handles keys */}
								<div onClick={() => void navigateToToday()}>
									<IconButton tooltip="Today">
										<FaIcon icon="fal:calendar-day" />
									</IconButton>
								</div>
							</CalendarTodayControl>
						)}
						<HeaderMoreMenu
							compact
							onRedo={onRedo}
							onToday={narrow && todaySeen === true ? () => void navigateToToday() : undefined}
							paneId={id}
							onUndo={onUndo}
							query={pane.query}
							zoomedId={pane.zoomedId}
						/>
						<IconButton
							className="text-tertiary hover:text-on-surface flex-shrink-0"
							onClick={() => {
								closePane(id);
							}}
							tooltip="Close pane"
						>
							<FaIcon icon="fal:xmark" />
						</IconButton>
					</div>
				</div>
				<div className="relative flex flex-1 min-h-0 flex-col">
					<div className={PANE_SCROLLER_CLASS} data-full-width-boundary="true" style={PANE_SCROLLER_STYLE}>
						<PaneContext.Provider value={context}>
							<OutlineTree parentId={pane.zoomedId} />
						</PaneContext.Provider>
						<DocumentEnd />
					</div>
				</div>
			</div>
			<PaneSeparator index={index} />
		</div>
	);
}

/** Upstream's secondary panes: every open item-tree pane left to right, after the main pane in the workspace. */
export function SidePanes(actions: PaneActions) {
	const panes = useOutlineStore((state) => state.panes);
	return panes.map((pane, index) => (
		<SidePane index={index + 1} isLast={index === panes.length - 1} key={pane.id} pane={pane} {...actions} />
	));
}
