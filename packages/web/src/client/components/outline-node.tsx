// fallow-ignore-file circular-dependency
// Mutual recursion between OutlineRow and OutlineChildren is intentional.
import {selectionExportRequest} from "../export-entry.js";
import {plainText} from "../rich-text.js";
import {CopyCodeButton} from "./copy-code-button.js";
import {canHaveNote} from "../layout-types.js";
import type {BacklinkCrumb, NodeResponse} from "../../node-types.js";
import {getHoveredRowId, setHoveredRowId} from "../hovered-row.js";
import {useIsRowHovered} from "../hooks/use-row-hover.js";
import type {ReactNode, CSSProperties} from "react";
import {memo, useContext, useMemo, useEffect, useLayoutEffect, useState, useSyncExternalStore} from "react";
import {IS_MOBILE} from "../is-mobile.js";
import {getFontSize, mobileRowMetrics, subscribeFontSize} from "../mobile-font-size.js";
import {childInstance, expansionId, isCyclical} from "../../mirror-path.js";
import {MirrorInstanceContext} from "../mirror-instance-context.js";
import {browserSlideDeps, slideDown, slideUp} from "../animate.js";
import {useNodeNavigation} from "../navigation.js";
import {bulletInSelection, clearSelectionFromBullet, useContentMouseDown} from "../hooks/use-drag-select.js";
import {useBulletDrag} from "../hooks/use-bullet-drag.js";
import {useCheckboxComplete} from "../hooks/use-checkbox-complete.js";
import {useZoomTo} from "../hooks/use-zoom-to.js";
import {useMoveTo} from "../hooks/use-move-to.js";
import {useDetachMirror, useMirrorCopy, useMirrorTo} from "../hooks/use-mirror-to.js";
import {useQueryClient} from "@tanstack/react-query";
import
{
	toggleComplete,
	useCreateNode,
	useDeleteNode,
	useExpandAll,
	useMoveNode,
	useUpdateNode,
} from "../hooks/use-nodes.js";
import {useCopyLink, useSortChildren} from "../hooks/use-item-actions.js";
import {outlineActions, useOutlineStore} from "../stores/outline.js";
import {useOutlineSearchFilter} from "../search-filter-context.js";
import type {ClickPosition} from "../stores/outline.js";
import {useRowState} from "../hooks/use-row-state.js";
import {isSearchExpanded} from "../search-filter.js";
import {SLIDE_WAIT_MS, expansionSlide, pendingSlideAction} from "../children-slide.js";
import {isSearchHalfExpanded, searchClasses, withClasses} from "../search-classes.js";
import {FlatCrumbs, LeftCollapsingCrumbs} from "./breadcrumbs.js";
import {EditableNote} from "./editable-note.js";
import {DayTitlePrefix} from "./day-title-prefix.js";
import {editableText} from "./editable-text.js";
import {expandArrow} from "./expand-arrow.js";
import {DividerLine} from "./divider-line.js";
import {ItemCheckbox, itemPrefix, NumberPiece} from "./item-prefix.js";
import {resolveLayoutMode} from "./layout-mode.js";
import {CARD_PLACEHOLDER, dashboardClasses, dashboardsOn, isDashboard} from "../dashboard.js";
import {itemMenuLeft} from "../item-menu-model.js";
import {openInPane} from "../pane-commands.js";
import {ItemMenuTrigger} from "./node-context-menu.js";
import type {DropHover} from "../bullet-drag-state.js";
import {OutlineChildren} from "./outline-tree.js";
import {BoardChildren, BoardColumnBody, ColumnResizeHandle, safeStorage} from "./board-view.js";
import {BoardZoomedContext} from "./board-context.js";
import type {BoardRowRole} from "./board-context.js";
import
{
	BOARD_CARD_CHILDREN_CLASS,
	BOARD_CARD_CLASS,
	BOARD_CARD_EXPAND_CLASS,
	BOARD_CARD_NAME_CLASS,
	BOARD_COLUMN_EXPAND_CLASS,
	boardColumnClass,
	boardColumnNameClass,
} from "./board-classes.js";
import {TableChildren, TableColumnResizeHandle, TableRowMenuSlot} from "./table-view.js";
import type {TableCellInfo} from "./table-view.js";
import {InComplexLayoutContext} from "./complex-layout-context.js";
import {TABLE_CELL_EXPAND_CLASS, tableCellClass, tableCellNameClass} from "./table-classes.js";
import {isTable} from "../table.js";
import {cellDelete, duplicateColumn} from "../table-actions.js";
import {locateCell} from "../table-cache.js";
import {makeTableDeps} from "../hooks/use-table-actions.js";
import {columnWidth, isBoard} from "../board.js";
import type {ColumnSearchMode} from "../board.js";
import {PaneContext, usePaneId} from "./pane-context.js";
import {isPreviewable, previewKind} from "./file-preview-kind.js";
import {RowFilePreview} from "./row-file-preview.js";
import {EmbedView, firstLinkHref} from "./embeds.js";
import {useRowEmbed} from "../hooks/use-preferences.js";
import {nodeBullet} from "./node-bullet.js";
import {hasMirrorsClass, isMirrorRoot, nameClassName, projectClassName} from "./row-classes.js";
import {rowClickResumesEditing} from "./row-click.js";
import {planDuplicate, rowHasChildren} from "../tree-ops.js";

interface NodeItemMenuProps
{
	node: NodeResponse;
	left?: string;
	onComplete: () => void;
	onOpenChange: (open: boolean) => void;
}

/** The bullet-menu trigger wired to the node's outline actions. */
export function NodeItemMenu({node, left, onComplete, onOpenChange}: NodeItemMenuProps)
{
	const queryClient = useQueryClient();
	const {navigateToNode} = useNodeNavigation();
	const expandAll = useExpandAll();
	const {focusNote, focusName, openPresentation, openExportDialog, requestDatePicker} = outlineActions();
	const createNode = useCreateNode();
	const deleteNode = useDeleteNode();
	const updateNode = useUpdateNode();
	const moveTo = useMoveTo();
	const mirrorTo = useMirrorTo();
	const mirrorCopy = useMirrorCopy();
	const detachMirror = useDetachMirror();
	const copyLink = useCopyLink();
	const sortChildren = useSortChildren();
	const moveNode = useMoveNode();
	const tableDeps = () =>
		makeTableDeps(
			queryClient,
			{
				create: createNode.mutate,
				remove: deleteNode.mutate,
				move: moveNode.mutate,
				update: updateNode.mutate,
			},
		);
	return (
		<ItemMenuTrigger
			actions={
			{
				onOpenInPane: () =>
				{
					openInPane(useOutlineStore.getState(), node.id);
				},
				onComplete,
				onAddNote: () =>
				{
					// Upstream: "Add note" from inside the note moves the caret to the end of the name.
					if (useOutlineStore.getState().editingNoteId === node.id)
					{
						focusName(node.id, "end");
					}
					else if (canHaveNote(node.data.layoutMode))
					{
						focusNote(node.id);
					}
				},
				onAddDate: () =>
				{
					requestDatePicker(node.id);
				},
				onPresent: () =>
				{
					navigateToNode(node.id);
					openPresentation(node.id);
				},
				onMoveTo: () =>
				{
					void moveTo([node.id]);
				},
				onMirrorTo: () =>
				{
					void mirrorTo([node.id]);
				},
				onMirror: () =>
				{
					mirrorCopy([node.id]);
				},
				onDetachMirror: () =>
				{
					void detachMirror(node.id);
				},
				onDuplicate: () =>
				{
					// Same mutation as ⇧⌘D, without moving focus into the copy.
					createNode.mutate(planDuplicate(queryClient, node));
				},
				onDuplicateColumn: () =>
				{
					const cell = locateCell(queryClient, node.id);
					if (cell !== null)
					{
						void duplicateColumn(tableDeps(), cell);
					}
				},
				onDeleteColumn: () =>
				{
					const cell = locateCell(queryClient, node.id);
					if (cell !== null)
					{
						void cellDelete(tableDeps(), cell, []);
					}
				},
				onExport: () =>
				{
					openExportDialog(selectionExportRequest([node.id]));
				},
				onCopyLink: () =>
				{
					void copyLink(node.id);
				},
				onMakeTemplate: () =>
				{
					updateNode.mutate(
						{
							nodeId: node.id,
							name: `${node.name ?? ""} #template`,
						},
					);
				},
				onDelete: () =>
				{
					deleteNode.mutate(node.id);
				},
				onExpandAll: () =>
				{
					expandAll(node.id, true);
				},
				onCollapseAll: () =>
				{
					expandAll(node.id, false);
				},
				onSort: (direction) =>
				{
					void sortChildren(node.id, direction);
				},
			}}
			left={left}
			node={node}
			onOpenChange={onOpenChange}
		/>
	);
}

interface NodeNameProps
{
	/** The row is a card of a dashboard. */
	dashboardCard?: boolean;
	node: NodeResponse;
	/** Whether this row's name is being edited in the active pane. */
	isEditing: boolean;
	/** Where the editing click landed, while `isEditing`. */
	editingClickPosition: ClickPosition | null;
	isExpanded: boolean;
	hasChildren: boolean;
	/** The row's `.children` is sliding up, so upstream shows no bullet halo yet. */
	collapsing: boolean;
	/** The account's `always_visible_controls`. */
	alwaysVisibleControls: boolean;
	depth: number;
	withEmbedder: boolean;
	/** Whether a search is filtering the outline; the arrow then writes the search expansion. */
	searching: boolean;
	/** Classes the search appends to `.name`. */
	searchNameClasses: readonly string[];
	/** The row's list number when it is a numbered row. */
	number?: number;
	/** The row is a board column or card: upstream's ring bullet, hover-only arrow and name classes. */
	boardRole?: BoardRowRole;
	/** The row is a table cell: upstream's hover-only ring bullet, hidden arrow and name classes. */
	tableCell?: TableCellInfo;
}

/**
 * Upstream's `.name` row: bullet, todo checkbox, `.content` holding the text,
 * an always-empty `.nameButtons`, the expand control, then the bullet-menu trigger,
 * which is mounted only while `.name` is hovered or its menu is open.
 */
/** Upstream's arrow click leaves the caret at the start of the row's text (`WF.Caret.set(content, 0)` next frame). */
function focusRowStart(id: string): void
{
	requestAnimationFrame(() =>
	{
		useOutlineStore.getState().focusName(id, 0);
	});
}

function NodeName({
	node,
	isEditing,
	editingClickPosition,
	isExpanded,
	hasChildren,
	collapsing,
	alwaysVisibleControls,
	depth,
	withEmbedder,
	searching,
	searchNameClasses,
	number,
	boardRole,
	tableCell,
	dashboardCard = false,
}: NodeNameProps)
{
	const boardZoomed = useContext(BoardZoomedContext);
	const search = useOutlineSearchFilter();
	const isHovered = useIsRowHovered(node.id);
	// A phone row sizes itself from the font setting (upstream's `AppSettings.font_size`); board and table rows keep their own.
	const fontSize = useSyncExternalStore(subscribeFontSize, getFontSize, getFontSize);
	const mobileMetrics =
		IS_MOBILE && boardRole === undefined && tableCell === undefined ? mobileRowMetrics(fontSize) : null;
	const mobileNameStyle: CSSProperties | undefined =
		mobileMetrics === null
			? undefined
			:
				{
					["--name-padding-left" as string]: `${mobileMetrics.namePaddingLeft}px`,
					["--name-font-size" as string]: `${fontSize}px`,
				};
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const {setItemMenuOpen, toggleExpand, toggleSearchExpansion, resumeEditing} = outlineActions();
	const rowInstance = useContext(MirrorInstanceContext);
	const cyclical = isCyclical(node, rowInstance);
	const rowExpansionId = expansionId(node.id, rowInstance);
	// A row unmounted with its menu open (collapsed parent, deleted row) must not leave a stale highlight.
	useEffect(
		() => () =>
		{
			setItemMenuOpen(node.id, false);
		},
		[node.id, setItemMenuOpen],
	);
	const queryClient = useQueryClient();
	const expandAll = useExpandAll();
	const mainZoomTo = useZoomTo();
	const pane = useContext(PaneContext);
	const handleBulletMouseDown = useBulletDrag(node.id);
	// Inside a side pane a bullet zooms that pane; the main outline zooms by navigating.
	const zoomIn = () =>
	{
		if (pane === null)
		{
			void mainZoomTo(node.id, "first_child", rowInstance);
		}
		else
		{
			pane.zoom(node.id);
		}
	};
	const isCompleted = node.completedAt !== null;
	const layout = resolveLayoutMode(node.data.layoutMode);
	const name = node.name ?? "";

	const handleContentMouseDown = useContentMouseDown(node.id);

	// Clicking the row outside its text edits the node with the caret at the end;
	// clicks inside an editor (the text or note being edited) belong to that editor.
	const handleRowClick = (event: React.MouseEvent<HTMLDivElement>) =>
	{
		const target = event.target instanceof Element ? event.target : null;
		if (rowClickResumesEditing(target, event.currentTarget))
		{
			resumeEditing(node.id, Number.MAX_SAFE_INTEGER);
		}
	};

	const handleComplete = () =>
	{
		toggleComplete(
			queryClient,
			{
				nodeId: node.id,
				isCurrentlyCompleted: isCompleted,
			},
		);
	};

	const checkboxComplete = useCheckboxComplete();
	const prefixPieces: ReactNode[] = [];
	if (number !== undefined)
	{
		prefixPieces.push(<NumberPiece key="numbered" number={number} />);
	}
	if (layout.isTodo)
	{
		prefixPieces.push(
			<ItemCheckbox
				key="todo"
				isCompleted={isCompleted}
				onComplete={() =>
				{
					checkboxComplete(node, false);
				}}
			/>,
		);
	}
	const isDivider = node.data.layoutMode === "divider";
	const dividerLine = isDivider ? (
		<DividerLine
			onActivate={() =>
			{
				resumeEditing(node.id, 0);
			}}
		/>
	) : null;

	const copyCodeButton =
		node.data.layoutMode === "code-block" ? <CopyCodeButton plainText={plainText(name, "")} /> : null;

	const nameClasses = withClasses(
		nameClassName(
			{
				focused: isEditing,
				empty: name === "",
				withEmbedder,
				isZoomRoot: boardRole === "column",
				tailBeforeEmpty: tableCell !== undefined,
				tail:
					tableCell === undefined
						? boardRole === "column"
							? boardColumnNameClass(boardZoomed)
							: boardRole === "card"
								? BOARD_CARD_NAME_CLASS
								: dashboardCard
									? "group/name"
									: undefined
						: tableCellNameClass(tableCell.header),
			},
		),
		searchNameClasses,
	);

	return (
		// Mouse shortcut for editing; keyboard users reach nodes by moving the caret with the arrow keys.
		<div
			tabIndex={-1}
			className={nameClasses}
			style={mobileNameStyle}
			onClick={handleRowClick}
			onMouseEnter={() =>
			{
				setHoveredRowId(node.id);
			}}
			onMouseLeave={() =>
			{
				if (getHoveredRowId() === node.id)
				{
					setHoveredRowId(null);
				}
			}}
			role="presentation"
		>
			{boardRole === "column" && name === "" ? (
				<div className="contentEditablePlaceholderWrapper">
					<div className="contentEditablePlaceholder">Untitled</div>
				</div>
			) : null}
			{dashboardCard && name === "" && !isDivider ? (
				<div className="contentEditablePlaceholderWrapper">
					<div className="contentEditablePlaceholder">{CARD_PLACEHOLDER}</div>
				</div>
			) : null}
			{nodeBullet(
				{
					board: boardRole,
					dashboardCard,
					tableCell: tableCell !== undefined,
					shared: (tableCell !== undefined || dashboardCard) && isMirrorRoot(node),
					mobile:
						mobileMetrics === null
							? undefined
							:
								{
									size: mobileMetrics.bulletSize,
									left: mobileMetrics.bulletLeft,
								},
					nodeId: node.id,
					instance: rowInstance,
					isMirror: isMirrorRoot(node),
					showHalo:
						hasChildren &&
						!collapsing &&
						(!isExpanded || (search !== null && isSearchHalfExpanded(node.id, search))),
					keepBullet: hasChildren && !collapsing && !isExpanded,
					onMouseDown: handleBulletMouseDown,
					onZoom: zoomIn,
					isInSelection: () => bulletInSelection(queryClient, node.id),
					onClearSelection: () =>
					{
						clearSelectionFromBullet(queryClient, node.id);
					},
				},
			)}
			{itemPrefix(prefixPieces)}
			{/* Upstream's `ui.item.name.afterbegin` friendly day name; mounted only on day rows to keep other rows cheap. */}
			{node.calendar?.level === "day" ? <DayTitlePrefix node={node} /> : null}
			{dividerLine}
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- mouse-only item selection (⌘/⌥/⇧-press, drag); keyboard users select with ⇧↑/⇧↓ */}
			<div className="notranslate content whitespace-pre-wrap" onMouseDown={handleContentMouseDown}>
				{/* Called, not mounted: it only picks the editing or resting text, so it needs no fiber of its own. */}
				{name !== "" || isEditing
					? editableText(
							{
								clickPosition: isEditing ? (editingClickPosition ?? undefined) : undefined,
								initialValue: name,
								isEditing,
								layoutMode: node.data.layoutMode,
								nodeId: node.id,
								parentId: node.parent_id,
								priority: node.priority,
							},
						)
					: null}
			</div>
			{copyCodeButton}
			<div
				className="wf-menu nameButtons"
				style={
				{
					marginLeft: 0,
				}}
			/>
			{dividerLine}
			{/* Hook-free, so called as a plain element rather than mounted as a component. */}
			{expandArrow(
				{
					hasChildren,
					isExpanded,
					mobile: mobileMetrics !== null,
					nodeId: node.id,
					alwaysVisible: boardRole === undefined ? alwaysVisibleControls : true,
					extraClassName:
						tableCell === undefined
							? boardRole === "column"
								? BOARD_COLUMN_EXPAND_CLASS
								: boardRole === "card"
									? BOARD_CARD_EXPAND_CLASS
									: undefined
							: TABLE_CELL_EXPAND_CLASS,
					onFocusRow: focusRowStart,
					onExpandAll: searching || cyclical ? undefined : expandAll,
					onToggle: searching
						? (id) =>
							{
								toggleSearchExpansion(id, isExpanded);
							}
						: () =>
							{
								// Expansion is per mirror instance, so a toggle inside a mirror leaves the original alone.
								toggleExpand(rowExpansionId);
							},
				},
			)}
			{isHovered || isMenuOpen ? (
				<NodeItemMenu
					left={itemMenuLeft(hasChildren, depth)}
					node={node}
					onComplete={handleComplete}
					onOpenChange={(open) =>
					{
						setIsMenuOpen(open);
						setItemMenuOpen(node.id, open);
					}}
				/>
			) : null}
		</div>
	);
}

function rowProjectClassName(
	node: NodeResponse,
	hasChildren: boolean,
	isExpanded: boolean,
	isEditingNote: boolean,
	slidingUp: boolean,
	slidingDown: boolean,
	moving: boolean,
	animatingShowChildren: boolean,
	collapsingChildren: boolean,
	addedToSelection: boolean,
	highlighted: boolean,
	dragHover: DropHover,
	boardRole?: BoardRowRole,
	boardZoomed = true,
	tableCell?: TableCellInfo,
	tableRenders = false,
	boardRenders = false,
	dashboardCard = false,
	dashboardRenders = false,
): string
{
	const flagOn = dashboardsOn();
	const dashboardExtras = dashboardClasses(
		{
			layoutMode: node.data.layoutMode,
			renders: dashboardRenders,
			parentRenders: dashboardCard,
			isZoomRoot: false,
			flagOn,
		},
	).project.filter((name) => name !== "dashboard");
	return projectClassName(
		{
			selectedColumn: boardRole === "column" && boardZoomed,
			hasChildren,
			hasAnyChildren: node.hasChildren === true,
			collapsingChildren,
			// A cell never shows its children, so it is never open.
			expanded: tableCell === undefined && isExpanded,
			completed: node.completedAt !== null,
			hasNote: Boolean(node.note),
			noteFocused: isEditingNote,
			isZoomRoot: false,
			hasMirrors: hasMirrorsClass(node),
			highlighted,
			addedToSelection: addedToSelection || tableCell?.rowSelected === true,
			withImage: isPreviewable(node.attachment),
			layoutClasses: [
				...resolveLayoutMode(node.data.layoutMode, flagOn).projectClasses.flatMap((layoutClass) =>
					layoutClass === "tableItem"
						? tableRenders
							? [isExpanded ? "tableItem " : "tableItem"]
							: []
						: layoutClass === "board"
							? boardRenders
								? [layoutClass]
								: []
							: [layoutClass],
				),
				...dashboardExtras,
				...(tableCell === undefined
					? boardRole === "column"
						? [boardColumnClass(boardZoomed)]
						: boardRole === "card"
							? [BOARD_CARD_CLASS]
							: []
					: [
							tableCellClass(
								{
									header: tableCell.header,
									nested: hasChildren,
									bg: node.table?.bg,
								},
							),
						]),
			],
			slidingUp,
			slidingDown,
			moving,
			animatingShowChildren,
			dragHoveredIn: dragHover === "in",
			dragHoveredAt: dragHover === "at",
		},
	);
}

/**
 * Upstream's backlink breadcrumbs (`ui.item.name.beforebegin.backlink_breadcrumbs`):
 * the source's ancestors in gray above the backlink row, with Home only for a
 * top-level source. A local adaptation lays backlink crumbs out flat, without the
 * header's truncation engine; Found Dates crumbs (`fitted`) collapse from the left to fit.
 */
function BacklinkCrumbs({crumbs, fitted}: {crumbs: BacklinkCrumb[]; fitted: boolean})
{
	const items =
		crumbs.length === 0
			? [
					{
						id: "None",
						isRoot: true,
					},
				]
			: crumbs.map(({id, name}) => (
				{
					id,
					name,
					isRoot: false,
				}));
	return (
		<div className="text-xs mobile:text-s text-tertiary mt-m ml-xl mobile:ml-2xl leading-s">
			{fitted ? <LeftCollapsingCrumbs crumbs={items} /> : <FlatCrumbs crumbs={items} />}
		</div>
	);
}

/**
 * Upstream's `div.project`: `.name`, `.notes`, `.drop-line`, then, when expanded,
 * the node's `.children`. Indentation and guide lines come from the enclosing
 * `.children` container, so the row carries no inline style. `depth` is the
 * visual depth below the zoom root, 1 for its children. Memoized: the cache keeps an unchanged node's object, so a
 * sibling list that changes elsewhere does not re-render this row.
 */
export const OutlineRow = memo(function OutlineRow({
	node,
	depth = 1,
	backlinkCrumbs,
	fitCrumbs = false,
	number,
	boardRole,
	columnMode,
	tableCell,
	dashboardCard = false,
}: {
	node: NodeResponse;
	/** The row is a direct child of a dashboard: a card. */
	dashboardCard?: boolean;
	/** The row's list number when it is a numbered row. */
	number?: number;
	depth?: number;
	/** A backlink item's source crumbs, rendered before `.name`. */
	backlinkCrumbs?: BacklinkCrumb[];
	/** Collapse the crumbs from the left to fit the row, as Found Dates rows do. */
	fitCrumbs?: boolean;
	/** The row is a column or card of a board. */
	boardRole?: BoardRowRole;
	/** A column's search mode: unmatched columns render collapsed (see `boardColumnsVisibleInSearch`). */
	columnMode?: ColumnSearchMode;
	/** The row is a cell of a table. */
	tableCell?: TableCellInfo;
})
{
	const boardZoomed = useContext(BoardZoomedContext);
	const inComplexLayout = useContext(InComplexLayoutContext);
	const embed = useRowEmbed(node.name);
	// Upstream `WF.Table.isRenderable`: a table inside a board, a table or a cell is a plain list.
	const tableRenders = isTable(node.data.layoutMode) && !inComplexLayout && boardRole === undefined;
	// Likewise `WF.Board.is`: a board inside a board card, a table or a cell is a plain list.
	const boardRenders =
		isBoard(node.data.layoutMode) && !inComplexLayout && boardRole === undefined && tableCell === undefined;
	const dashboardRenders =
		isDashboard(node.data.layoutMode, dashboardsOn()) &&
		!inComplexLayout &&
		boardRole === undefined &&
		tableCell === undefined;
	const search = useOutlineSearchFilter();
	const paneId = usePaneId();
	const instance = useContext(MirrorInstanceContext);
	const
	{
		isPersistentlyExpanded,
		isEditingNote,
		isEditingName,
		editingClickPosition,
		isSlidingUp,
		isMoving,
		isAddedToSelection,
		isHighlighted,
		isSlidingDown,
		dragHover,
		showCompleted,
		alwaysVisibleControls,
	} = useRowState(node.id, paneId, expansionId(node.id, instance));
	// A row inside a mirror is an instance with its own expansion key, collapsed until that instance is expanded; a
	// cyclical instance has no saved state of its own, so it starts collapsed too (upstream's default-state pipe).
	const nestedInstance = useMemo(() => childInstance(node, instance), [node, instance]);
	const isExpanded =
		columnMode !== undefined && search !== null
			? columnMode === "matches"
			: search === null
				? isPersistentlyExpanded
				: isSearchExpanded(node.id, search);
	const rowSearchClasses = searchClasses(
		{
			id: node.id,
			parentId: node.parent_id,
		},
		search,
	);
	const {endCompletionAnimation} = outlineActions();
	const hasChildren = rowHasChildren(node, showCompleted);

	// Upstream mounts `.notes` once the note is non-empty, has had focus, or the name was edited, and never unmounts it.
	const [noteMounted, setNoteMounted] = useState(false);
	const shouldMountNote = Boolean(node.note) || isEditingNote || isEditingName;
	if (shouldMountNote && !noteMounted)
	{
		setNoteMounted(true);
	}

	// Expanding slides `.children` down; collapsing removes `open` at once but keeps `.children` mounted while it
	// slides up. A row that mounts expanded, or whose expansion a search entering or leaving changed, does not slide.
	const expansion =
	{
		expanded: isExpanded,
		searching: search !== null,
	};
	const [prevExpansion, setPrevExpansion] = useState(expansion);
	const [childrenSlide, setChildrenSlide] = useState<"down" | "up" | null>(null);
	if (expansion.expanded !== prevExpansion.expanded || expansion.searching !== prevExpansion.searching)
	{
		setPrevExpansion(expansion);
		setChildrenSlide(expansionSlide(prevExpansion, expansion));
	}
	// A state ref, not an object ref: a first expand fetches its rows, so `.children` mounts after the slide is due.
	const [childrenEl, setChildrenEl] = useState<HTMLDivElement | null>(null);
	useLayoutEffect(() =>
	{
		const done = () =>
		{
			setChildrenSlide(null);
		};
		if (childrenSlide === null)
		{
			return () =>
			{
			};
		}
		const action = pendingSlideAction(childrenSlide, childrenEl !== null, 0);
		if (action === "drop")
		{
			const frame = requestAnimationFrame(done);
			return () =>
			{
				cancelAnimationFrame(frame);
			};
		}
		if (action === "wait" || childrenEl === null)
		{
			// Slides once the children mount; gives up after SLIDE_WAIT_MS.
			const timer = setTimeout(done, SLIDE_WAIT_MS);
			return () =>
			{
				clearTimeout(timer);
			};
		}
		return (childrenSlide === "down" ? slideDown : slideUp)(childrenEl, browserSlideDeps(), done);
	}, [childrenSlide, childrenEl]);

	// The slideUp's own transition ending hides the row; a child's transition does not.
	const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) =>
	{
		if (isSlidingUp && event.target === event.currentTarget)
		{
			endCompletionAnimation([node.id]);
		}
	};

	return (
		<div
			projectid={node.id}
			className={withClasses(
				rowProjectClassName(
					node,
					hasChildren,
					isExpanded,
					isEditingNote,
					isSlidingUp,
					isSlidingDown,
					isMoving,
					childrenSlide === "down",
					childrenSlide === "up",
					isAddedToSelection,
					isHighlighted,
					dragHover,
					boardRole,
					boardZoomed,
					tableCell,
					tableRenders,
					boardRenders,
					dashboardCard,
					dashboardRenders,
				),
				rowSearchClasses.project,
			)}
			onTransitionEnd={handleTransitionEnd}
			style={
				boardRole === "column"
					?
						{
							width: columnWidth(node.id, safeStorage()),
						}
					: tableCell?.width === undefined
						? undefined
						:
							{
								width: tableCell.width,
							}
			}
		>
			{backlinkCrumbs ? <BacklinkCrumbs crumbs={backlinkCrumbs} fitted={fitCrumbs} /> : null}
			<NodeName
				depth={depth}
				editingClickPosition={editingClickPosition}
				isEditing={isEditingName}
				hasChildren={hasChildren}
				isExpanded={tableCell === undefined && isExpanded}
				collapsing={childrenSlide === "up"}
				alwaysVisibleControls={alwaysVisibleControls}
				node={node}
				searchNameClasses={rowSearchClasses.name}
				searching={search !== null}
				withEmbedder={backlinkCrumbs !== undefined || embed !== null}
				number={number}
				boardRole={boardRole}
				tableCell={tableCell}
				dashboardCard={dashboardCard}
			/>
			{embed === null ? null : <EmbedView key={firstLinkHref(node.name)} embed={embed} />}
			{previewKind(node.attachment) === "none" ? null : <RowFilePreview node={node} zoomedIn={false} />}
			{noteMounted || shouldMountNote ? (
				<EditableNote
					extraClasses={rowSearchClasses.note}
					initialValue={node.note ?? ""}
					isFocused={isEditingNote}
					nodeId={node.id}
				/>
			) : null}
			<div className="drop-line">
				<div className="line" />
			</div>
			{tableCell === undefined ? (
				boardRole === "column" ? (
					<MirrorInstanceContext.Provider value={nestedInstance}>
						<BoardColumnBody columnId={node.id} expanded={isExpanded} hasChildren={hasChildren} />
						<ColumnResizeHandle columnId={node.id} />
					</MirrorInstanceContext.Provider>
				) : isExpanded && boardRenders && search === null ? (
					<MirrorInstanceContext.Provider value={nestedInstance}>
						<BoardChildren boardId={node.id} zoomed={false} depth={depth} />
					</MirrorInstanceContext.Provider>
				) : isExpanded && tableRenders ? (
					<MirrorInstanceContext.Provider value={nestedInstance}>
						<TableChildren table={node} zoomed={false} depth={depth} />
					</MirrorInstanceContext.Provider>
				) : isExpanded || childrenSlide === "up" ? (
					<MirrorInstanceContext.Provider value={nestedInstance}>
						<OutlineChildren
							className={boardRole === "card" ? BOARD_CARD_CHILDREN_CLASS : undefined}
							containerRef={setChildrenEl}
							depth={depth + 1}
							owner={node}
							ownerDashboard={dashboardRenders}
							parentId={node.id}
						/>
					</MirrorInstanceContext.Provider>
				) : null
			) : (
				<>
					{tableCell.header ? <TableColumnResizeHandle cellId={node.id} tableId={tableCell.tableId} /> : null}
					{tableCell.firstBody ? (
						<TableRowMenuSlot
							onToggle={tableCell.onToggleRow}
							rowId={node.parent_id ?? ""}
							rowIndex={tableCell.rowIndex}
							selected={tableCell.rowSelected}
							tableId={tableCell.tableId}
						/>
					) : null}
				</>
			)}
		</div>
	);
});
