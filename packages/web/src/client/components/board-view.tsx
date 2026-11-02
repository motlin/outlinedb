// fallow-ignore-file circular-dependency
// Mutual recursion between OutlineRow and the board renderers is intentional.
import {useContext, useLayoutEffect, useRef, useState} from "react";
import type {CSSProperties, MouseEvent as ReactMouseEvent} from "react";
import {useShallow} from "zustand/react/shallow";
import {boardColumnsVisibleInSearch, inlineBoardBleed, MIN_COLUMN_WIDTH, nextWidth, saveColumnWidth} from "../board.js";
import type {WidthStorage} from "../board.js";
import {useChildren, useCreateNode} from "../hooks/use-nodes.js";
import {MirrorInstanceContext} from "../mirror-instance-context.js";
import {rendersInstanceRow} from "../render-window.js";
import {searchShowsNode} from "../search-filter.js";
import {useOutlineSearchFilter} from "../search-filter-context.js";
import {useOutlineStore} from "../stores/outline.js";
import {rowHasChildren} from "../tree-ops.js";
import
{
	ADD_CARD_TILE_CLASS,
	ADD_COLUMN_TILE_CLASS,
	BOARD_COLUMN_CHILDREN_CLASS,
	boardChildrenClass,
	EXPAND_COLUMN_LINK_CLASS,
	RESIZE_HANDLE_CLASS,
} from "./board-classes.js";
import {BoardZoomedContext} from "./board-context.js";
import {InComplexLayoutContext} from "./complex-layout-context.js";
import {FaIcon} from "./fa-icons.js";
import {OutlineRow} from "./outline-node.js";

/** Upstream's `#fullWidthBoundaryStyle` rule, injected while a zoomed board is mounted. */
const FULL_WIDTH_BOUNDARY_CSS =
	'.page[data-full-width-active="true"]{height:calc(100vh - 72px)!important;border-radius:0!important;box-sizing:border-box!important;max-width:none!important;padding-bottom:3px!important}';

/** A computed `NNpx` length as a number; 0 for anything else. */
function px(length: string): number
{
	const value = Number(length.replace("px", ""));
	return Number.isFinite(value) ? value : 0;
}

/** `localStorage`, or a no-op store when the browser blocks it. */
export function safeStorage(): WidthStorage
{
	try
	{
		return globalThis.localStorage;
	}
	catch
	{
		return {
			getItem: () => null,
			setItem: () =>
			{
			},
		};
	}
}

/** Appends an empty last child to `parentId` and edits it. */
function useAppendChild(parentId: string): (onCreated?: () => void) => void
{
	const createNode = useCreateNode();
	const {data: children} = useChildren(parentId);
	return (onCreated) =>
	{
		const id = crypto.randomUUID();
		createNode.mutate(
			{
				id,
				parent_id: parentId,
				name: "",
				index: (children ?? []).length,
			},
		);
		useOutlineStore.getState().resumeEditing(id, 0);
		onCreated?.();
	};
}

/** Upstream's add-column tile: the last child of the board's `.children`. */
function AddColumnTile({
	boardId,
	scroller,
}: {
	boardId: string;
	scroller?:
	{
		current: HTMLElement | null;
	};
})
{
	const append = useAppendChild(boardId);
	const handleClick = () =>
	{
		append(() =>
		{
			const element = scroller?.current;
			if (element)
			{
				element.scrollLeft = element.scrollWidth - 48 - 48 - 16;
			}
		});
	};
	return (
		<div className="grow-0 shrink-0 ">
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a mouse shortcut; keyboard users add a column with Enter at the end of a title or the Insert column commands */}
			<div
				className={ADD_COLUMN_TILE_CLASS}
				style={
				{
					margin: "8px 24px 24px",
					width: 48,
					height: 48,
					borderRadius: 4,
				}}
				onClick={handleClick}
			>
				<FaIcon icon="fal:plus" />
			</div>
		</div>
	);
}

/** Upstream's add-card tile: expands the column, appends an empty card and edits it. */
function AddCardTile({columnId}: {columnId: string})
{
	const append = useAppendChild(columnId);
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a mouse shortcut; keyboard users add a card with Enter at the end of the column title
		<div
			className={ADD_CARD_TILE_CLASS}
			onClick={() =>
			{
				useOutlineStore.getState().expand(columnId);
				append();
			}}
		>
			<FaIcon icon="fal:plus" />
		</div>
	);
}

/** A collapsed column with children shows this link instead of its cards. */
function ExpandColumnLink({columnId}: {columnId: string})
{
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/anchor-is-valid -- upstream's link has no href; the column arrow is the keyboard path
		<a
			className={EXPAND_COLUMN_LINK_CLASS}
			onClick={() =>
			{
				useOutlineStore.getState().toggleExpand(columnId);
			}}
		>
			<FaIcon icon="fal:eye-slash" />
			Expand column
		</a>
	);
}

/** What fills a column under its title: the cards, the Expand column link, or the add-card tile. */
export function BoardColumnBody({
	columnId,
	expanded,
	hasChildren,
}: {
	columnId: string;
	expanded: boolean;
	hasChildren: boolean;
})
{
	const {data: nodes} = useChildren(columnId);
	const search = useOutlineSearchFilter();
	const instance = useContext(MirrorInstanceContext);
	const {showCompleted, animatingCompletionIds} = useOutlineStore(
		useShallow((state) => (
		{
			showCompleted: state.showCompleted,
			animatingCompletionIds: state.animatingCompletionIds,
		})),
	);
	const cards = (nodes ?? []).filter((node) =>
		rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, search),
	);
	if (!hasChildren || (expanded && nodes !== undefined && cards.length === 0))
	{
		return <AddCardTile columnId={columnId} />;
	}
	if (!expanded)
	{
		return <ExpandColumnLink columnId={columnId} />;
	}
	return (
		<div className={BOARD_COLUMN_CHILDREN_CLASS}>
			{cards.map((card) => (
				<OutlineRow key={card.id} boardRole="card" depth={2} node={card} />
			))}
			<AddCardTile columnId={columnId} />
		</div>
	);
}

/** Upstream's `HorizontalResizeHandle`: drag the column's right edge; the width persists per browser. */
export function ColumnResizeHandle({columnId}: {columnId: string})
{
	const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) =>
	{
		const column = event.currentTarget.parentElement;
		if (column === null)
		{
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const startX = event.clientX;
		const initial = column.getBoundingClientRect().width;
		const move = (moveEvent: MouseEvent) =>
		{
			column.style.width = `${nextWidth(initial, moveEvent.clientX - startX, MIN_COLUMN_WIDTH)}px`;
		};
		const up = (upEvent: MouseEvent) =>
		{
			document.removeEventListener("mousemove", move);
			document.removeEventListener("mouseup", up);
			const width = nextWidth(initial, upEvent.clientX - startX, MIN_COLUMN_WIDTH);
			column.style.width = `${width}px`;
			saveColumnWidth(columnId, width, safeStorage());
		};
		document.addEventListener("mousemove", move);
		document.addEventListener("mouseup", up);
	};
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- a pointer-only drag handle, as upstream's
		<div className={RESIZE_HANDLE_CLASS} onMouseDown={handleMouseDown} />
	);
}

/** Zoomed: the board spans the page edge to edge; `.page` gets upstream's full-width boundary while it is mounted. */
export function useZoomedFullBleed(
	ref:
	{
		current: HTMLDivElement | null;
	},
	active: boolean,
): void
{
	useLayoutEffect(() =>
	{
		const element = ref.current;
		const page = element?.closest(".page");
		if (!active || !element || !page)
		{
			return () =>
			{
			};
		}
		page.setAttribute("data-full-width-active", "true");
		let style = document.getElementById("fullWidthBoundaryStyle");
		const created = style === null;
		if (style === null)
		{
			style = document.createElement("style");
			style.id = "fullWidthBoundaryStyle";
			style.textContent = FULL_WIDTH_BOUNDARY_CSS;
			document.head.append(style);
		}
		const computed = getComputedStyle(page);
		const padLeft = px(computed.paddingLeft);
		const padRight = px(computed.paddingRight);
		element.style.marginLeft = `-${padLeft}px`;
		element.style.marginRight = `-${padRight}px`;
		element.style.paddingLeft = `${padLeft}px`;
		return () =>
		{
			page.removeAttribute("data-full-width-active");
			if (created)
			{
				style.remove();
			}
		};
	}, [ref, active]);
}

/** Inline: after the page position holds for 10 frames, the strip spans the viewport and becomes visible. */
function useInlineBleed(
	ref:
	{
		current: HTMLDivElement | null;
	},
	active: boolean,
	depth: number,
): CSSProperties | null
{
	const [style, setStyle] = useState<CSSProperties | null>(null);
	useLayoutEffect(() =>
	{
		if (!active)
		{
			return () =>
			{
			};
		}
		let frame = 0;
		let stable = 0;
		let last = Number.NaN;
		const tick = () =>
		{
			const page = ref.current?.closest(".page");
			if (page)
			{
				const left = page.getBoundingClientRect().left;
				stable = left === last ? stable + 1 : 0;
				last = left;
				if (stable >= 10)
				{
					const bleed = inlineBoardBleed(
						{
							innerWidth: globalThis.innerWidth,
							leftBarOffset: useOutlineStore.getState().leftBarOffset(),
							scrollbar: globalThis.innerWidth - document.documentElement.clientWidth,
							pageLeft: left,
							pagePadLeft: px(getComputedStyle(page).paddingLeft),
							depth,
						},
					);
					setStyle(
						{
							position: "relative",
							...bleed,
						},
					);
					return;
				}
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () =>
		{
			cancelAnimationFrame(frame);
		};
	}, [ref, active, depth]);
	return style;
}

/**
 * A board's columns as a horizontal scroller, then the add-column tile. Zoomed it is full width; inline (an expanded
 * board row) it is a full-bleed strip at most 60vh tall. Under a search every column stays: unmatched ones collapse.
 * A childless zoomed board is only the tile, with no `.children` and no full-width page.
 */
export function BoardChildren({boardId, zoomed, depth = 1}: {boardId: string; zoomed: boolean; depth?: number})
{
	const {data: nodes} = useChildren(boardId);
	const search = useOutlineSearchFilter();
	const instance = useContext(MirrorInstanceContext);
	const {showCompleted, animatingCompletionIds} = useOutlineStore(
		useShallow((state) => (
		{
			showCompleted: state.showCompleted,
			animatingCompletionIds: state.animatingCompletionIds,
		})),
	);
	const ref = useRef<HTMLDivElement>(null);
	const columns = (nodes ?? []).filter((node) =>
		rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, null),
	);
	const hasColumns = columns.length > 0;
	useZoomedFullBleed(ref, zoomed && hasColumns);
	const bleed = useInlineBleed(ref, !zoomed && hasColumns, depth);
	if (!hasColumns && zoomed)
	{
		return <AddColumnTile boardId={boardId} />;
	}
	const modes = new Map(
		search === null
			? []
			: boardColumnsVisibleInSearch(
					columns.map((column) => (
					{
						id: column.id,
						childCount: rowHasChildren(column, showCompleted) ? 1 : 0,
					})),
					Object.fromEntries(columns.map((column) => [column.id, searchShowsNode(column, search)])),
				).map((entry) => [entry.id, entry.mode] as const),
	);
	return (
		<InComplexLayoutContext.Provider value>
			<BoardZoomedContext.Provider value={zoomed}>
				<div
					ref={ref}
					className={boardChildrenClass(zoomed, zoomed || bleed !== null)}
					style={zoomed ? undefined : (bleed ?? undefined)}
				>
					{columns.map((column) => (
						<OutlineRow
							key={column.id}
							boardRole="column"
							columnMode={modes.get(column.id)}
							depth={depth + 1}
							node={column}
						/>
					))}
					<AddColumnTile boardId={boardId} scroller={ref} />
				</div>
			</BoardZoomedContext.Provider>
		</InComplexLayoutContext.Provider>
	);
}
