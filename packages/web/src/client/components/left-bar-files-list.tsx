import {QueryClientContext} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {memo, useContext, useEffect, useRef, useState} from "react";
import type {CSSProperties, MouseEvent as ReactMouseEvent, ReactNode} from "react";
import {startLeftBarRowDrag} from "../hooks/use-bullet-drag.js";
import {isValidLeftBarParent, planLeftBarDrop, rowMovingStyle} from "../left-bar-drop.js";
import {readChildren, readNode} from "../node-cache.js";
import {useStableNavigate} from "../hooks/use-stable-navigate.js";
import type {NodeResponse} from "../../node-types.js";
import {friendlyPrefix} from "@outlinedb/shared";
import {useDayPrefix} from "../hooks/use-calendar-settings.js";
import {useChildren} from "../hooks/use-nodes.js";
import {useDateSettings} from "../hooks/use-preferences.js";
import {renderDatePills} from "../date-pills.js";
import type {DateSettings} from "../date-settings.js";
import {addMonolithGuards} from "../monolith-guards.js";
import {nodeUrl} from "../navigation.js";
import {leftBarExpansionKey, pageUniqueId, useLeftBarExpansionStore} from "../stores/left-bar-expansions.js";
import type {LeftBarSectionName} from "../stores/left-bar-expansions.js";
import {useOutlineStore} from "../stores/outline.js";
import {rowHasChildren} from "../tree-ops.js";
import {triangleSvg} from "./fa-icons.js";

type ArrowStyle = CSSProperties & Record<"--opacity" | "--hover-opacity", number>;

/**
 * Upstream's FilesList arrow opacities (`kx4` k1/y1): a row with no potentially visible
 * children is dimmer, and the current row is brighter than its siblings.
 */
function filesListArrowStyle(noChildren: boolean, current: boolean): ArrowStyle {
	if (noChildren) {
		return {"--opacity": current ? 0.2 : 0.15, "--hover-opacity": current ? 0.65 : 0.45};
	}
	return {"--opacity": current ? 0.65 : 0.45, "--hover-opacity": 1};
}

function isListed(node: NodeResponse, showCompleted: boolean): boolean {
	if (node.completedAt !== null && !showCompleted) {
		return false;
	}
	return Boolean(node.name) || Boolean(node.note) || node.hasChildren !== false;
}

/**
 * A name fragment: stored HTML keeps its colors and formatting; plain text (a custom star name) is escaped. A plain
 * element, not a component, so a row mounts no fiber for it.
 */
export function rowName({
	html,
	text,
	dates,
	prefix,
}: {
	html?: string;
	text?: string;
	/** Render stored `<time>` markup as date pills with these settings, as outline rows do. */
	dates?: DateSettings;
	/** The friendly day prefix (`Today, `), a sibling before the label as upstream's `item:icon` decorator renders it. */
	prefix?: string | null;
}) {
	const shown = html !== undefined && dates !== undefined ? addMonolithGuards(renderDatePills(html, dates)) : html;
	return (
		<>
			{prefix}
			<span style={{pointerEvents: "none", whiteSpace: "nowrap"}}>
				{shown === undefined ? (
					<span className="innerContentContainer">{text}</span>
				) : (
					<span
						className="innerContentContainer"
						// oxlint-disable-next-line react/no-danger -- node names are stored HTML; colors and formatting must survive
						dangerouslySetInnerHTML={{__html: shown}}
					/>
				)}
			</span>
		</>
	);
}

/** The local-midnight date a `YYYYMMDD` dateId names. */
function dateOfId(dateId: number): Date {
	return new Date(Math.floor(dateId / 10_000), (Math.floor(dateId / 100) % 100) - 1, dateId % 100);
}

/** A node's left-bar label: its rich name with date pills, plus `Today, ` on a calendar day node. */
export function useNodeRowName(node: Pick<NodeResponse, "name" | "calendar"> | undefined) {
	const dates = useDateSettings();
	const dayPrefix = useDayPrefix(undefined);
	const [now] = useState(() => new Date());
	const dateId = node?.calendar?.level === "day" ? node.calendar.dateId : null;
	const prefix = dateId !== null && dayPrefix ? friendlyPrefix(dateOfId(dateId), now) : null;
	return rowName({html: nodeNameHtml(node?.name), dates, prefix: prefix === null ? null : `${prefix}, `});
}

/** A node's rich name, or "Untitled" when it has none. */
function nodeNameHtml(name: string | null | undefined): string {
	return name === null || name === undefined || name === "" ? "Untitled" : name;
}

/** The expand triangle; clicks toggle without following the row's link. A plain element, not a component. */
export function filesListArrow({
	expanded,
	noChildren,
	current,
	onToggle,
}: {
	expanded: boolean;
	noChildren: boolean;
	current: boolean;
	onToggle: () => void;
}) {
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup: a plain clickable div arrow
		<div
			className={`flex shrink-0 items-center justify-center opacity-[var(--opacity)] hover:opacity-[var(--hover-opacity)] arrow ${expanded ? "expanded" : ""}`}
			data-left-bar-controls
			onClick={(event) => {
				event.stopPropagation();
				event.preventDefault();
				onToggle();
			}}
			style={filesListArrowStyle(noChildren, current)}
		>
			<div>{triangleSvg("block transition-transform duration-200 ease-base [.expanded_&]:rotate-90")}</div>
		</div>
	);
}

/** What a left-bar row knows about itself as a drop target and drag source. */
interface LeftBarDropItem {
	id: string;
	/** The list's parent (`"home"` for the root list). */
	parentId: string;
	index: number;
	expanded: boolean;
	isSearch: boolean;
	/** Starred depth-0 rows accept only a drop into them and cannot be dragged. */
	disableRootMoves: boolean;
	previousId: string | null;
	previousExpanded: boolean;
}

/** The ids above `id` in the cached tree, nearest first. */
function ancestorsInCache(queryClient: QueryClient | undefined, id: string): string[] {
	const chain: string[] = [];
	if (queryClient === undefined) {
		return chain;
	}
	let parentId = readNode(queryClient, id)?.parent_id ?? null;
	while (parentId !== null && !chain.includes(parentId)) {
		chain.push(parentId);
		parentId = readNode(queryClient, parentId)?.parent_id ?? null;
	}
	return chain;
}

interface LeftBarRowProps {
	dropItem?: LeftBarDropItem;
	href: string;
	depth: number;
	current: boolean;
	completed: boolean;
	expanded: boolean;
	arrow: ReactNode;
	label: ReactNode;
	controls?: ReactNode;
}

/** A row's hover state and link navigation, which `leftBarRowLink` renders with. */
function useLeftBarRowState() {
	const navigate = useStableNavigate();
	const [hovered, setHovered] = useState(false);
	/** Upstream's `WF.Moving.happening`: a bullet drag or a Starred reorder freezes row hover. */
	const moving = useOutlineStore((state) => state.draggingIds.length > 0 || state.starDragActive);
	const grabbedId = useOutlineStore((state) => state.draggingIds[0] ?? null);
	const queryClient = useContext(QueryClientContext);
	return {navigate, hovered, setHovered, moving, grabbedId, queryClient};
}

/** One upstream FilesList row: a link with an arrow slot, a label, and hover-only controls. */
function leftBarRowLink(
	{href, depth, current: zoomed, completed, expanded, arrow, label, controls, dropItem}: LeftBarRowProps,
	{navigate, hovered, setHovered, moving, grabbedId, queryClient}: ReturnType<typeof useLeftBarRowState>,
) {
	// While a drag carries rows, upstream shows the grabbed item (and anything inside it) as secondary/600 and dimmed.
	const {inside, dim} =
		grabbedId === null || dropItem === undefined
			? {inside: false, dim: false}
			: rowMovingStyle(dropItem.id, grabbedId, (id) => ancestorsInCache(queryClient, id));
	const current = grabbedId === null ? zoomed : inside;
	/** Upstream `G`: while rows are carried, hovering a row plans where a drop here would land. */
	const planDrop = (event: ReactMouseEvent<HTMLAnchorElement>) => {
		const {draggingIds, setLeftBarDrop} = useOutlineStore.getState();
		if (draggingIds.length === 0 || dropItem === undefined) {
			return;
		}
		const labelRect = (
			event.currentTarget.querySelector("[data-expanded]") ?? event.currentTarget
		).getBoundingClientRect();
		const rowRect = event.currentTarget.getBoundingClientRect();
		const pos = planLeftBarDrop({
			rowRect: {top: rowRect.top, height: rowRect.height},
			labelRect: {left: labelRect.left, width: labelRect.width},
			point: {x: event.clientX, y: event.clientY},
			item: dropItem,
			disableRootMoves: dropItem.disableRootMoves,
			previousSibling:
				dropItem.previousId === null
					? null
					: {
							id: dropItem.previousId,
							expanded: dropItem.previousExpanded,
							childCount:
								queryClient === undefined
									? 0
									: (readChildren(queryClient, dropItem.previousId)?.length ?? 0),
						},
			isValidParent: (id) =>
				isValidLeftBarParent(id, draggingIds, (ancestor) => ancestorsInCache(queryClient, ancestor)),
		});
		// Upstream keeps the last valid position when this row has none.
		if (pos !== null) {
			setLeftBarDrop(pos);
		}
	};

	const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		void navigate(href);
	};

	return (
		<a
			href={href}
			data-location-url={href}
			draggable="false"
			className={`flex justify-between items-center pr-m hover:cursor-pointer ${completed ? "hover:line-through" : "hover:no-underline"} left-bar-section-item font-custom `}
			onClick={handleClick}
			onMouseDown={(event) => {
				if (
					queryClient === undefined ||
					dropItem === undefined ||
					dropItem.disableRootMoves ||
					dropItem.isSearch ||
					event.button !== 0 ||
					event.ctrlKey ||
					event.metaKey
				) {
					return;
				}
				startLeftBarRowDrag(queryClient, dropItem.id, event);
			}}
			onMouseEnter={(event) => {
				if (!moving) {
					setHovered(true);
				}
				planDrop(event);
			}}
			onMouseLeave={() => {
				if (!moving) {
					setHovered(false);
				}
			}}
			onMouseMove={planDrop}
			style={{
				paddingLeft: 12 * (depth + 1),
				background: hovered ? "var(--wf-background-tertiary)" : undefined,
				color: current ? "var(--wf-text-secondary)" : "var(--wf-text-tertiary)",
				textDecoration: completed ? "line-through" : undefined,
				opacity: dim ? 0.3 : completed ? 0.5 : undefined,
			}}
		>
			<div
				className="flex grow items-center min-w-0 h-[30px] pl-xs text-tertiary"
				style={{fontWeight: current ? 600 : 400}}
			>
				{arrow}
				<div className="grow py-xs truncate" data-expanded={expanded}>
					{label}
				</div>
			</div>
			{hovered ? (
				<div className="flex flex-row items-center pl-xs gap-m item-controls" data-left-bar-controls>
					{controls}
				</div>
			) : null}
		</a>
	);
}

/** A left-bar row with hover controls, for the Starred section's rows. */
export function LeftBarRow(props: LeftBarRowProps) {
	return leftBarRowLink(props, useLeftBarRowState());
}

const ROW_HEIGHT = 32;
const LIMIT_PADDING = 100;
const LIMIT_HYSTERESIS = 40;

/** Upstream's FilesList render limit: rows to the bottom of the scroller's viewport, plus 100. */
export function renderLimit({
	scrollTop,
	offsetHeight,
	rulerOffsetTop,
}: {
	scrollTop: number;
	offsetHeight: number;
	rulerOffsetTop: number;
}): number {
	return Math.ceil(Math.max(0, scrollTop + offsetHeight - rulerOffsetTop) / ROW_HEIGHT) + LIMIT_PADDING;
}

/** The limit is only replaced when it moves by more than 40, as upstream. */
export function nextLimit(current: number, computed: number): number {
	return Math.abs(computed - current) > LIMIT_HYSTERESIS ? computed : current;
}

/** Tracks the render limit of the list whose ruler element `ruler` is, from its `.scroller` ancestor. */
function useRenderLimit(ruler: {current: HTMLElement | null}): number {
	const [limit, setLimit] = useState(() => renderLimit({scrollTop: 0, offsetHeight: 0, rulerOffsetTop: 0}));
	useEffect(() => {
		const element = ruler.current;
		const scroller = element?.closest<HTMLElement>(".scroller");
		const update = () => {
			if (!element || !scroller) {
				return;
			}
			const computed = renderLimit({
				scrollTop: scroller.scrollTop,
				offsetHeight: scroller.offsetHeight,
				rulerOffsetTop: element.offsetTop,
			});
			setLimit((current) => nextLimit(current, computed));
		};
		update();
		scroller?.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		return () => {
			scroller?.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, [ruler]);
	return limit;
}

/**
 * Upstream's left-bar FilesList: a flat run of rows for `parentId`'s children, each followed by its
 * own children's rows when expanded. Expansion is account state keyed `leftbar__<section>__<top row>__<id8>`.
 * The `windowed` root renders a ruler and limits its rows (and those under them) to the scroll window;
 * `budget` is the rows a nested list may still render.
 */
export function FilesListRows({
	parentId,
	depth,
	section,
	topUniqueId,
	windowed = false,
	budget,
	limit: forcedLimit,
}: {
	parentId: string | null;
	depth: number;
	section: LeftBarSectionName;
	/** The enclosing top-level row's unique id; top-level rows use their own. */
	topUniqueId?: string;
	windowed?: boolean;
	budget?: number;
	/** Overrides the measured limit (tests). */
	limit?: number;
}) {
	const {data: nodes} = useChildren(parentId);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const keys = useLeftBarExpansionStore((state) => state.keys);
	const ruler = useRef<HTMLDivElement>(null);
	const measured = useRenderLimit(ruler);
	const available = windowed ? (forcedLimit ?? measured) : (budget ?? Number.POSITIVE_INFINITY);

	const listed = nodes?.filter((node) => isListed(node, showCompleted)).slice(0, Math.max(0, available));
	const listParentId = parentId ?? "home";
	return (
		<>
			{windowed ? <div ref={ruler} /> : null}
			{listed?.map((node, index) => {
				const top = topUniqueId ?? pageUniqueId(node.id);
				const previous = listed[index - 1];
				return (
					<FilesListBranch
						budget={available - index - 1}
						depth={depth}
						expanded={keys.has(leftBarExpansionKey(section, top, node.id))}
						key={node.id}
						listParentId={listParentId}
						node={node}
						previousExpanded={
							previous !== undefined && keys.has(leftBarExpansionKey(section, top, previous.id))
						}
						previousId={previous?.id ?? null}
						siblingIndex={nodes?.indexOf(node) ?? index}
						section={section}
						topUniqueId={top}
					/>
				);
			})}
		</>
	);
}

/**
 * One FilesList row and, when expanded, its children's rows: one component per row. Memoized so a save that patches
 * one row of a children list re-renders only that row's branch, and a zoom only the rows it makes or stops current.
 */
const FilesListBranch = memo(function FilesListBranch({
	node,
	depth,
	section,
	topUniqueId,
	expanded,
	budget,
	listParentId,
	previousId,
	previousExpanded,
	siblingIndex,
}: {
	listParentId: string;
	previousId: string | null;
	previousExpanded: boolean;
	siblingIndex: number;
	node: NodeResponse;
	depth: number;
	section: LeftBarSectionName;
	topUniqueId: string;
	expanded: boolean;
	budget: number;
}) {
	const toggle = useLeftBarExpansionStore((state) => state.toggle);
	const current = useOutlineStore((state) => state.zoomedNodeId === node.id);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const rowState = useLeftBarRowState();
	const nameLabel = useNodeRowName(node);
	return (
		<>
			{leftBarRowLink(
				{
					arrow: filesListArrow({
						current,
						expanded,
						noChildren: !rowHasChildren(node, showCompleted),
						onToggle: () => {
							// Upstream skips items with no children at all (completed ones count).
							if (node.hasChildren !== false) {
								toggle(leftBarExpansionKey(section, topUniqueId, node.id));
							}
						},
					}),
					completed: node.completedAt !== null,
					current,
					depth,
					dropItem: {
						id: node.id,
						parentId: listParentId,
						index: siblingIndex,
						expanded,
						isSearch: false,
						disableRootMoves: false,
						previousId,
						previousExpanded,
					},
					expanded,
					href: nodeUrl(node.id),
					label: nameLabel,
				},
				rowState,
			)}
			{expanded ? (
				<FilesListRows
					budget={budget}
					depth={depth + 1}
					parentId={node.id}
					section={section}
					topUniqueId={topUniqueId}
				/>
			) : null}
		</>
	);
});
