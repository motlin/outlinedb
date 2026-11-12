// Mutual recursion between OutlineRow and OutlineChildren is intentional.
import {plainText} from "../rich-text.js";
import {IS_MOBILE} from "../is-mobile.js";
import {CopyCodeButton} from "./copy-code-button.js";
import type {ReactNode, Ref} from "react";
import type {BacklinkItem, FoundDateItem, FoundDatesResponse, NodeResponse} from "../../node-types.js";
import {hideLoadingScreenOnce} from "../loading-screen.js";
import {RootEmptyOutline} from "./empty-outline.js";
import {useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {backlinksLabel, isBacklinksSectionVisible} from "../backlinks.js";
import
{
	useBacklinks,
	useChildren,
	useCreateNode,
	useFoundDates,
	useNode,
	useToggleComplete,
} from "../hooks/use-nodes.js";
import {nodeUrl} from "../navigation.js";
import {outlineRootToShow} from "../show-zoom.js";
import {isEntry} from "../item-selection.js";
import {currentSelectionView, HOME_ROOT} from "../hooks/use-selection-keymap.js";
import {dropHoverOf} from "../bullet-drag-state.js";
import {rendersInstanceRow, rowLimit} from "../render-window.js";
import {childInstance, instanceKey} from "../../mirror-path.js";
import {MirrorInstanceContext} from "../mirror-instance-context.js";
import {usePaneSearchQuery, usePrefetchSearchAncestors, useSearchFilter} from "../hooks/use-tree-search.js";
import {RowLimitsContext, useRowLimits} from "../hooks/use-row-limits.js";
import {useOutlineViewPending} from "../hooks/use-outline-view.js";
import {restorePoppedScroll} from "../scroll-restoration.js";
import {restoreShownView} from "../view-restore.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {rootSearchClasses, shouldRenderAddChildButton} from "../search-classes.js";
import {useOutlineStore} from "../stores/outline.js";
import {SearchFilterContext, useOutlineSearchFilter} from "../search-filter-context.js";
import {useShallow} from "zustand/react/shallow";
import {lastChildShapeLayout, planAddChild, planAddSibling, rowHasChildren} from "../tree-ops.js";
import {useZoomTo} from "../hooks/use-zoom-to.js";
import {currentNavigableIds} from "../hooks/use-visible-nodes.js";
import {horizontalTarget, planVerticalCross} from "../caret-navigation.js";
import {placeCaretAtTextOffset} from "../caret-dom.js";
import {expandArrow} from "./expand-arrow.js";
import {FaIcon} from "./fa-icons.js";
import {IconButton} from "./icon-button.js";
import {InComplexLayoutContext} from "./complex-layout-context.js";
import {DashboardBottomButton, DashboardTopButton} from "./dashboard-controls.js";
import {dashboardsOn, isDashboard} from "../dashboard.js";
import {CalendarStrip} from "./calendar-strip.js";
import {DayTitlePrefix} from "./day-title-prefix.js";
import {EditableNote} from "./editable-note.js";
import {editableText} from "./editable-text.js";
import {resolveLayoutMode} from "./layout-mode.js";
import {NodeItemMenu, OutlineRow} from "./outline-node.js";
import {BoardChildren} from "./board-view.js";
import {BOARD_ROOT_ZOOMED_SUFFIX} from "./board-classes.js";
import {isBoard} from "../board.js";
import {TableChildren} from "./table-view.js";
import {TABLE_ROOT_ZOOMED_SUFFIX, TABLE_TITLE_CLASS} from "./table-classes.js";
import {isTable} from "../table.js";
import {DividerLine} from "./divider-line.js";
import {useCheckboxComplete} from "../hooks/use-checkbox-complete.js";
import {ItemCheckbox, itemPrefix, NumberPiece} from "./item-prefix.js";
import {renderedNumbers, siblingNumber} from "../numbered-list.js";
import {PaneContext, useInActivePane, usePaneExpandedIds, usePaneId} from "./pane-context.js";
import {itemMenuLeft} from "../item-menu-model.js";
import {hasMirrorsClass, nameClassName, projectClassName} from "./row-classes.js";
import {planBlankSpaceClick} from "../blank-space-click.js";
import {DOCUMENT_END_HEIGHT} from "../page-style.js";
import {rowClickResumesEditing} from "./row-click.js";
import {isPreviewable, previewKind} from "./file-preview-kind.js";
import {RowFilePreview} from "./row-file-preview.js";

interface OutlineTreeProps
{
	parentId: string | null;
	/** `"page"` renders the rows and `.document-end` as fragments for the main `.page`; `"pane"` keeps its own scroller. */
	shell?: "page" | "pane";
}

/** Upstream's top-level `.children`: no margin, padding, or guide border. */
const ROOT_CHILDREN_CLASS =
	"children relative [.addedToSelection_&]:border-l-transparent [.item--zooming-in-progress_&]:border-l-transparent";

/** Upstream's nested `.children`: indented 36px past the parent bullet, the guide line is its left border. */
const NESTED_CHILDREN_CLASS =
	"children relative ml-[10px] pl-[25px] border-l-[length:var(--wf-border-width-s)] border-solid border-l-secondary [.addedToSelection_&]:border-l-transparent [.item--zooming-in-progress_&]:border-l-transparent";

/** The outline's own padding and gutters, not any row: a click there is a blank-space click. */
const BLANK_OUTLINE_SELECTOR = ".outline-tree-container, .scroller, .project.root, .project.root > .children";

/** Upstream's add-child button wrapper, rendered once after the zoomed page's root `.children`. */
const ADD_CHILD_CONTAINER_CLASS = "mt-m mobile:ml-[-6px] [.item--zooming-in-progress_&]:hidden print:hidden";

/**
 * Upstream's "+" add-child button: appends an empty last child to the zoomed item,
 * shaped like the previous visible row, and puts the caret in it. Uses no React
 * built-in hooks so tests can invoke its click handler directly.
 */
export function AddChildButton({parentId}: {parentId: string | null})
{
	const queryClient = useQueryClient();
	const createNode = useCreateNode();
	const {data: nodes} = useChildren(parentId);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const resumeEditing = useOutlineStore((state) => state.resumeEditing);

	const handleClick = (event?: {
		currentTarget:
		{
			blur: () => void;
		};
	}) =>
	{
		const children = nodes ?? [];
		const visible = showCompleted ? children : children.filter((node) => node.completedAt === null);
		const plan = planAddChild(
			{
				childCount: children.length,
				zoomedId: parentId,
				shapeLayout: lastChildShapeLayout(queryClient, parentId, visible.at(-1)),
			},
		);
		// A client-generated id lets the caret enter the new row now, not after the round-trip;
		// blurring the button keeps Space/Enter typed meanwhile from clicking it again.
		const id = crypto.randomUUID();
		event?.currentTarget.blur();
		createNode.mutate(
			{
				id,
				parent_id: plan.parent_id,
				name: plan.name,
				index: plan.index,
				at_end: plan.at_end,
				...(plan.layoutMode === null
					? {}
					:
						{
							layoutMode: plan.layoutMode,
						}),
			},
		);
		resumeEditing(id, 0);
	};

	return (
		<div className={ADD_CHILD_CONTAINER_CLASS}>
			<IconButton
				aria-label="Add new item"
				className="addChildButton cursor-pointer desktop:hover:!bg-tertiary"
				onClick={handleClick}
				shape="circle"
				size="ms"
			>
				<FaIcon icon="fal:plus" />
			</IconButton>
		</div>
	);
}

/**
 * Upstream's `.addSiblingButton`: a "+" at the bottom of a nested `.children` guide
 * line that creates an empty sibling right after `owner` (the row whose `.children`
 * holds it) and puts the caret in it. Clicking hides it with an inline opacity
 * until the next mouseenter. Uses no React built-in hooks so tests can invoke its
 * handlers directly.
 */
export function AddSiblingButton({owner}: {owner?: NodeResponse})
{
	const createNode = useCreateNode();
	const {data: siblings} = useChildren(owner?.parent_id ?? null, owner !== undefined);
	const resumeEditing = useOutlineStore((state) => state.resumeEditing);

	const handleClick = (event: {
		currentTarget:
		{
			style:
			{
				opacity: string;
			};
		};
	}) =>
	{
		// The Backlinks section's references root is read-only: upstream draws the button, but it adds nothing.
		if (owner === undefined)
		{
			return;
		}
		const plan = planAddSibling(
			{
				owner,
				siblings: siblings ?? [owner],
			},
		);
		const id = crypto.randomUUID();
		event.currentTarget.style.opacity = "0";
		createNode.mutate(
			{
				id,
				...plan,
			},
		);
		resumeEditing(id, 0);
	};

	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's markup is a bare svg; keyboard users add a sibling with Enter at the end of a row
		<svg
			viewBox="0 0 20 20"
			className="absolute left-[-11px] bottom-[3px] w-[20px] h-[20px] block opacity-0 hover:opacity-70 active:opacity-100 addSiblingButton"
			onClick={handleClick}
			onMouseEnter={(event: {
				currentTarget:
				{
					style:
					{
						opacity: string;
					};
				};
			}) =>
			{
				event.currentTarget.style.opacity = "";
			}}
		>
			<circle cx="10.5" cy="10.5" r="9" fill="var(--wf-background-quaternary)" />
			<line x1="6" y1="10.5" x2="15" y2="10.5" stroke="var(--wf-text-quaternary)" strokeWidth="1" />
			<line x1="10.5" y1="6" x2="10.5" y2="15" stroke="var(--wf-text-quaternary)" strokeWidth="1" />
		</svg>
	);
}

/**
 * Upstream's zoom-root `.project.selected.root`: the zoomed node's title, edited in place
 * like any row (`editingId === nodeId`), in a `.name--main` row, its `.notes--main` note, then the root `.children`. At the main-tree root (no zoom) it is
 * `.mainTreeRoot` with a title-less `.name--root` row.
 */
function ZoomRootRow({nodeId, children}: {nodeId: string | null; children: ReactNode})
{
	const {data: node} = useNode(nodeId);
	const toggleComplete = useToggleComplete();
	const [isHovered, setIsHovered] = useState(false);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const editingId = useOutlineStore((state) => state.editingId);
	const editingClickPosition = useOutlineStore((state) => state.editingClickPosition);
	const resumeEditing = useOutlineStore((state) => state.resumeEditing);
	// Editing and the item selection show only in the active pane, as for rows.
	const inActivePane = useInActivePane();
	const isEditingNote = useOutlineStore((state) => inActivePane && nodeId !== null && state.editingNoteId === nodeId);
	const isAddedToSelection = useOutlineStore(
		(state) => inActivePane && nodeId !== null && isEntry(state.itemSelection, nodeId),
	);
	const isMainTreeRoot = nodeId === null;
	const paneId = usePaneId();
	const isDragHoveredIn = useOutlineStore(
		(state) => dropHoverOf(state.dropIndicator, nodeId ?? HOME_ROOT, paneId) === "in",
	);
	// A references root is read-only: its name is the "N Backlinks" label, never editable.
	const isReferencesRoot = node?.isReferencesRoot === true;
	const isEditing = inActivePane && !isMainTreeRoot && !isReferencesRoot && editingId === nodeId;
	const searchRootClasses = rootSearchClasses(useOutlineSearchFilter());
	const nameHtml = isMainTreeRoot ? "" : (node?.name ?? "");
	const layout = resolveLayoutMode(node?.data.layoutMode);
	const zoomDashboard = isDashboard(node?.data.layoutMode, dashboardsOn());
	const handleComplete = () =>
	{
		if (node)
		{
			toggleComplete.mutate(
				{
					nodeId: node.id,
					isCurrentlyCompleted: node.completedAt !== null,
				},
			);
		}
	};

	// Upstream's `LK4` sibling walk numbers a numbered zoom root; the siblings are only fetched for one.
	const rootIsNumbered = node?.data.layoutMode === "numbered";
	const {data: rootSiblings} = useChildren(node?.parent_id ?? null, rootIsNumbered);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const rootNumber =
		node && rootIsNumbered && rootSiblings
			? siblingNumber(numberingRows(rootSiblings.filter((s) => showCompleted || s.completedAt === null)), node.id)
			: undefined;
	const checkboxComplete = useCheckboxComplete();
	const prefixPieces: ReactNode[] = [];
	if (rootNumber !== undefined && rootNumber > 0)
	{
		prefixPieces.push(<NumberPiece key="numbered" number={rootNumber} />);
	}
	if (node && layout.isTodo)
	{
		prefixPieces.push(
			<ItemCheckbox
				key="todo"
				isCompleted={node.completedAt !== null}
				isZoomRoot
				onComplete={() =>
				{
					checkboxComplete(node, true);
				}}
			/>,
		);
	}
	const dividerLine =
		node?.data.layoutMode === "divider" ? (
			<DividerLine
				onActivate={() =>
				{
					if (nodeId !== null)
					{
						resumeEditing(nodeId, 0);
					}
				}}
			/>
		) : null;

	const copyCodeButton =
		node?.data.layoutMode === "code-block" ? <CopyCodeButton plainText={plainText(nameHtml, "")} /> : null;

	// Like a row, the root's `.notes--main` mounts once noted, note-focused, or title-focused, and stays mounted.
	const [noteMounted, setNoteMounted] = useState(false);
	const shouldMountNote = !isMainTreeRoot && (Boolean(node?.note) || isEditingNote || isEditing);
	if (shouldMountNote && !noteMounted)
	{
		setNoteMounted(true);
	}

	// Clicking the title row outside its text edits the title with the caret at the end.
	const handleTitleClick = (event: React.MouseEvent<HTMLDivElement>) =>
	{
		const target = event.target instanceof Element ? event.target : null;
		if (nodeId !== null && rowClickResumesEditing(target, event.currentTarget))
		{
			resumeEditing(nodeId, Number.MAX_SAFE_INTEGER);
		}
	};

	return (
		<div
			projectid={node?.id}
			className={
				[
					projectClassName(
						{
							hasChildren: node === undefined || rowHasChildren(node, showCompleted),
							expanded: true,
							completed: node !== undefined && node.completedAt !== null,
							hasNote: Boolean(node?.note),
							noteFocused: isEditingNote,
							isZoomRoot: true,
							hasMirrors: node !== undefined && hasMirrorsClass(node),
							highlighted: false,
							addedToSelection: isAddedToSelection,
							layoutClasses: layout.projectClasses,
							withImage: isPreviewable(node?.attachment),
							dragHoveredIn: isDragHoveredIn,
						},
					),
					isMainTreeRoot && "mainTreeRoot",
					isReferencesRoot && "references",
					...searchRootClasses,
				]
					.filter(Boolean)
					.join(" ") +
				(isBoard(node?.data.layoutMode)
					? BOARD_ROOT_ZOOMED_SUFFIX
					: isTable(node?.data.layoutMode)
						? TABLE_ROOT_ZOOMED_SUFFIX
						: "")
			}
		>
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- hover mounts the bullet-menu trigger; click is a mouse shortcut for editing the title, which keyboard users reach with the arrow keys */}
			<div
				tabIndex={-1}
				// Upstream's phone title carries only the padding variable (no font-size variable).
				style={
					IS_MOBILE
						?
							{
								["--name-padding-left" as string]: "30px",
							}
						: undefined
				}
				className={nameClassName(
					{
						focused: isEditing,
						isZoomRoot: !isMainTreeRoot,
						isMainRoot: isMainTreeRoot,
						empty: !isMainTreeRoot && nameHtml === "",
						tail: !isMainTreeRoot && isTable(node?.data.layoutMode) ? TABLE_TITLE_CLASS : undefined,
					},
				)}
				onClick={isMainTreeRoot ? undefined : handleTitleClick}
				onMouseEnter={() =>
				{
					setIsHovered(true);
				}}
				onMouseLeave={() =>
				{
					setIsHovered(false);
				}}
			>
				{zoomDashboard && node ? <DashboardTopButton parentId={node.id} /> : null}
				{!isMainTreeRoot && !isReferencesRoot && nameHtml === "" && node?.data.layoutMode !== "numbered" ? (
					<div className="contentEditablePlaceholderWrapper">
						<div className="contentEditablePlaceholder">Untitled</div>
					</div>
				) : null}
				{itemPrefix(prefixPieces)}
				{node?.calendar?.level === "day" ? <DayTitlePrefix node={node} /> : null}
				{dividerLine}
				<div className="notranslate content whitespace-pre-wrap">
					{isReferencesRoot ? (
						<span className="innerContentContainer">{node.backlinksLabel}</span>
					) : node && (nameHtml !== "" || isEditing) ? (
						editableText(
							{
								clickPosition: isEditing ? (editingClickPosition ?? undefined) : undefined,
								initialValue: nameHtml,
								isEditing,
								layoutMode: node.data.layoutMode,
								nodeId: node.id,
								parentId: node.parent_id,
								priority: node.priority,
							},
						)
					) : null}
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
				{node && !isMainTreeRoot && (isHovered || isMenuOpen) ? (
					<NodeItemMenu
						left={itemMenuLeft(true, 1)}
						node={node}
						onComplete={handleComplete}
						onOpenChange={setIsMenuOpen}
					/>
				) : null}
			</div>
			{node && previewKind(node.attachment) !== "none" ? <RowFilePreview node={node} zoomedIn /> : null}
			{node && (noteMounted || shouldMountNote) ? (
				<EditableNote initialValue={node.note ?? ""} isFocused={isEditingNote} isMain nodeId={node.id} />
			) : null}
			{/* Upstream renders the day strip at `ui.item.note.afterend` for the zoomed calendar node, never a mirror. */}
			{node?.calendar && node.isMirror !== true ? <CalendarStrip node={node} /> : null}
			<div className="drop-line">
				<div className="line" />
			</div>
			{children}
		</div>
	);
}

/**
 * Zero-height marker after the outline's last rendered row while the row budget is spent; scrolling it into view
 * raises the budget. Keyed by the budget, so each step re-arms it while it stays in view. Local adaptation with no
 * upstream class equivalent.
 */
function RenderSentinel({onReached}: {onReached: () => void})
{
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() =>
	{
		const observer = new IntersectionObserver((entries) =>
		{
			if (entries.some((entry) => entry.isIntersecting))
			{
				onReached();
			}
		});
		if (ref.current)
		{
			observer.observe(ref.current);
		}
		return () =>
		{
			observer.disconnect();
		};
	}, [onReached]);

	return <div className="render-sentinel" ref={ref} />;
}

/**
 * The references row's label. The caret can enter it (arrows walk the rows like any other), but upstream's name setter
 * is a no-op: typing, Enter and Backspace change nothing here.
 */
function ReferencesLabel({rootId, label}: {rootId: string; label: string})
{
	const queryClient = useQueryClient();
	const inActivePane = useInActivePane();
	const editing = useOutlineStore((state) => inActivePane && state.editingId === rootId);
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() =>
	{
		const content = ref.current;
		if (!editing || content === null)
		{
			return;
		}
		content.focus(
			{
				preventScroll: true,
			},
		);
		placeCaretAtTextOffset(content, useOutlineStore.getState().editingCaretOffset ?? 0);
	}, [editing]);
	if (!editing)
	{
		return <span className="innerContentContainer">{label}</span>;
	}
	const cross = (key: string): boolean =>
	{
		const ids = currentNavigableIds(queryClient);
		const {resumeEditing} = useOutlineStore.getState();
		if (key === "ArrowUp" || key === "ArrowDown")
		{
			const plan = planVerticalCross(ids, rootId, key === "ArrowUp" ? "up" : "down");
			if (plan.kind === "move")
			{
				resumeEditing(plan.nodeId, plan.caretOffset);
			}
			return plan.kind !== "native";
		}
		const selection = globalThis.getSelection();
		const content = ref.current;
		if (content === null || selection?.isCollapsed !== true)
		{
			return false;
		}
		const offset = selection.anchorOffset;
		const left = key === "ArrowLeft";
		if (offset !== (left ? 0 : label.length))
		{
			return false;
		}
		const target = horizontalTarget(ids, rootId, left ? "left" : "right");
		if (target === null)
		{
			return false;
		}
		resumeEditing(target.nodeId, target.caretOffset);
		return true;
	};
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- contentEditable makes this an implicit textbox, which the rule does not model
		<span
			ref={ref}
			className="innerContentContainer editing"
			data-node-id={rootId}
			contentEditable
			suppressContentEditableWarning
			onBeforeInput={(event) =>
			{
				event.preventDefault();
			}}
			onPaste={(event) =>
			{
				event.preventDefault();
			}}
			onKeyDown={(event) =>
			{
				if (event.key === "Enter")
				{
					event.preventDefault();
				}
				else if (
					["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
					!event.shiftKey &&
					!event.altKey &&
					!event.metaKey &&
					!event.ctrlKey &&
					cross(event.key)
				)
				{
					event.preventDefault();
				}
			}}
			onBlur={() =>
			{
				if (useOutlineStore.getState().editingId === rootId && !useOutlineStore.getState().editingHeld)
				{
					useOutlineStore.getState().stopEditing();
				}
			}}
		>
			{label}
		</span>
	);
}

/**
 * Upstream's Backlinks section (`children_extra.backlink_root`): the item's
 * references root as a collapsible `.project.references` row labelled
 * "N Backlinks", whose children are the backlink items, each a mirror row
 * preceded by its source's crumbs. The label counts every backlink with a
 * current source; completed sources hide like any completed row.
 */
function BacklinksSection({rootId, items, depth}: {rootId: string; items: BacklinkItem[]; depth: number})
{
	const isExpanded = usePaneExpandedIds().has(rootId);
	const mainZoomTo = useZoomTo();
	const pane = useContext(PaneContext);
	// Upstream's bullet click is the standard one: it zooms into the references root (the arrow toggles).
	const zoomIn = () =>
	{
		if (pane === null)
		{
			void mainZoomTo(rootId, "first_child");
		}
		else
		{
			pane.zoom(rootId);
		}
	};
	const toggleExpand = useOutlineStore((state) => state.toggleExpand);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const visibleItems = items.filter((item) => showCompleted || item.node.completedAt === null);
	return (
		<div
			className={projectClassName(
				{
					references: true,
					hasChildren: true,
					expanded: isExpanded,
					completed: false,
					hasNote: false,
					noteFocused: false,
					isZoomRoot: false,
					hasMirrors: false,
					highlighted: false,
					addedToSelection: false,
				},
			)}
		>
			<div
				tabIndex={-1}
				className={nameClassName(
					{
						empty: true,
					},
				)}
				role="presentation"
			>
				{/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- upstream's bullet anchor is unlabelled; the "N Backlinks" label beside it names the row */}
				<a
					href={nodeUrl(rootId)}
					data-handbook="bullet.handle"
					data-item-id={rootId}
					className={
						isExpanded
							? "bullet bullet--backlink-root"
							: "bullet bullet--show-halo bullet--backlink-root keep-bullet"
					}
					style={
					{
						left: "calc(var(--name-left-overhang) + 1px)",
						width: "18px",
						// Upstream keeps the bullet hidden at rest in both states; hovering the row shows it.
						opacity: 0,
						["--bullet-size" as string]: "18px",
					}}
					onClick={(event) =>
					{
						event.preventDefault();
						zoomIn();
					}}
					onKeyDown={(event) =>
					{
						if (event.key === "Enter" || event.key === " ")
						{
							event.preventDefault();
							zoomIn();
						}
					}}
				>
					<span className="bulletHalo">
						<svg
							width="100%"
							height="100%"
							viewBox="0 0 18 18"
							fill="currentColor"
							className="zoomBulletIcon"
						>
							<circle cx="9" cy="9" r="3.5" />
						</svg>
					</span>
				</a>
				<div className="notranslate content whitespace-pre-wrap">
					<ReferencesLabel rootId={rootId} label={backlinksLabel(items.length)} />
				</div>
				<div
					className="wf-menu nameButtons"
					style={
					{
						marginLeft: 0,
					}}
				/>
				{expandArrow(
					{
						hasChildren: true,
						isExpanded,
						nodeId: rootId,
						onToggle: toggleExpand,
					},
				)}
			</div>
			<div className="drop-line">
				<div className="line" />
			</div>
			{isExpanded && visibleItems.length > 0 ? (
				<div className={NESTED_CHILDREN_CLASS}>
					{visibleItems.map((item) => (
						<OutlineRow
							key={item.node.id}
							backlinkCrumbs={item.crumbs}
							fitCrumbs
							depth={depth + 1}
							node={item.node}
						/>
					))}
					<AddSiblingButton />
				</div>
			) : null}
		</div>
	);
}

/** Upstream's Found Dates project classes, copied literally (`open` swaps for `collapsed`). */
const FOUND_DATES_CLASS = "font-custom project open [&_>.name>.itemMenu]:hidden [&_>.name]:text-tertiary";

/**
 * Upstream's Found Dates (`calendar.non-calendar-mirrors.wire`): a virtual,
 * collapsible project after a day page's children, named "Found Dates" with an
 * invisible mirror bullet, whose children are the found items as mirror rows
 * under their crumbs. Its name is not editable; Enter on it adds an empty item
 * at the end of the day, as upstream does.
 */
function FoundDatesSection({dayId, items, depth}: {dayId: string; items: FoundDateItem[]; depth: number})
{
	const [isExpanded, setIsExpanded] = useState(true);
	const queryClient = useQueryClient();
	const createNode = useCreateNode();
	const {data: dayChildren} = useChildren(dayId);
	const resumeEditing = useOutlineStore((state) => state.resumeEditing);
	const addItemToDay = () =>
	{
		const children = dayChildren ?? [];
		const plan = planAddChild(
			{
				childCount: children.length,
				zoomedId: dayId,
				shapeLayout: lastChildShapeLayout(queryClient, dayId, children.at(-1)),
			},
		);
		const id = crypto.randomUUID();
		createNode.mutate(
			{
				id,
				parent_id: plan.parent_id,
				name: plan.name,
				index: plan.index,
				at_end: plan.at_end,
				...(plan.layoutMode === null
					? {}
					:
						{
							layoutMode: plan.layoutMode,
						}),
			},
		);
		resumeEditing(id, 0);
	};
	return (
		<div className={isExpanded ? FOUND_DATES_CLASS : FOUND_DATES_CLASS.replace(" open ", " collapsed ")}>
			<div tabIndex={-1} className="name" role="presentation">
				<span
					data-handbook="bullet.handle"
					className="bullet diamond"
					style={
					{
						left: "calc(var(--name-left-overhang) + 1px)",
						width: "18px",
						opacity: 1e-8,
						["--bullet-size" as string]: "18px",
					}}
					aria-hidden="true"
				>
					<span className="bulletHalo">
						<svg
							width="100%"
							height="100%"
							viewBox="0 0 16 16"
							fill="currentColor"
							className="mirrorDiamondIcon"
						>
							<path d="M8 4 L4 8 L8 12 L12 8 Z" />
						</svg>
					</span>
				</span>
				<div
					className="notranslate content whitespace-pre-wrap"
					// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- upstream's name is a `.content` div that takes the caret but not edits; Enter there adds an item to the day
					role="button"
					tabIndex={0}
					onKeyDown={(event) =>
					{
						if (event.key === "Enter")
						{
							event.preventDefault();
							addItemToDay();
						}
					}}
				>
					<span className="innerContentContainer">Found Dates</span>
				</div>
				<div
					className="wf-menu nameButtons"
					style={
					{
						marginLeft: 0,
					}}
				/>
				{expandArrow(
					{
						hasChildren: true,
						isExpanded,
						nodeId: `found-dates-${dayId}`,
						onToggle: () =>
						{
							setIsExpanded((open) => !open);
						},
					},
				)}
			</div>
			<div className="drop-line">
				<div className="line" />
			</div>
			{isExpanded ? (
				<div className={NESTED_CHILDREN_CLASS}>
					{items.map((item) => (
						<OutlineRow
							key={item.node.id}
							backlinkCrumbs={item.crumbs}
							fitCrumbs
							depth={depth + 1}
							node={item.node}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

function numberingRows(nodes: readonly NodeResponse[])
{
	return nodes.map((node) => (
	{
		id: node.id,
		layoutMode: node.data.layoutMode,
		numberedStart: node.numberedStart,
	}));
}

/**
 * List numbers of the numbered children: rendered order in the outline, but the true sibling position during a
 * search (upstream's `LK4` walk, which ignores the search filter and skips hidden completed rows).
 */
function childNumbers(
	nodes: readonly NodeResponse[],
	visibleNodes: readonly NodeResponse[],
	searching: boolean,
	showCompleted: boolean,
	animatingCompletionIds: ReadonlySet<string>,
): Map<string, number>
{
	if (!nodes.some((node) => node.data.layoutMode === "numbered"))
	{
		return new Map();
	}
	if (!searching)
	{
		return renderedNumbers(numberingRows(visibleNodes));
	}
	const siblings = numberingRows(
		nodes.filter((node) => showCompleted || node.completedAt === null || animatingCompletionIds.has(node.id)),
	);
	const numbers = new Map<string, number>();
	for (const node of visibleNodes)
	{
		const number = siblingNumber(siblings, node.id);
		if (number > 0)
		{
			numbers.set(node.id, number);
		}
	}
	return numbers;
}

/**
 * Upstream's `div.children`: the visible children of `parentId` that the outline's row
 * budget reaches, each a recursive `OutlineRow`, then, once every child is rendered,
 * the item's Backlinks section and (nested only) the add-sibling button.
 * Renders nothing when no row shows, so a collapsed or empty parent, or one past the
 * budget, has no `.children` in the DOM. During a search, rows the search does not show are
 * removed, and the Backlinks section is left out.
 */
export function OutlineChildren({
	parentId,
	owner,
	ownerDashboard = false,
	isRoot = false,
	depth = 1,
	found = null,
	containerRef,
	addChild,
	className,
}: {
	parentId: string | null;
	/** Replaces the nested `.children` class (a board card's nested rows). */
	className?: string;
	/** The root's add-child wrapper: inside `.children` after the rows, or alone when no `.children` renders. */
	addChild?: ReactNode;
	/** The `.children` element, for the expand/collapse slide. */
	containerRef?: Ref<HTMLDivElement>;
	/** The row whose `.children` this is; a nested `.children` ends with its add-sibling button. */
	owner?: NodeResponse;
	/** The owner is a dashboard that renders as one (the zoom root always does), so these rows are its cards. */
	ownerDashboard?: boolean;
	isRoot?: boolean;
	depth?: number;
	/** The zoomed day page's Found Dates (root only): its day id and the cached list, or null elsewhere. */
	found?:
	{
		dayId: string;
		response: FoundDatesResponse | undefined;
	} | null;
}): ReactNode
{
	const search = useOutlineSearchFilter();
	const instance = useContext(MirrorInstanceContext);
	// The root's view loads in one request already; an expanded row's first load brings its whole expanded subtree.
	const {data: nodes} = useChildren(parentId, true, !isRoot && search === null && instance === null);
	const dashboard = parentId !== null && ownerDashboard;
	// A search leaves the Backlinks section out, so its rows skip the fetch; the rest wait for the children load,
	// which a subtree load seeds the section with.
	const {data: backlinks} = useBacklinks(search === null && nodes !== undefined ? parentId : null);
	const {showCompleted, animatingCompletionIds} = useOutlineStore(
		useShallow((state) => (
		{
			showCompleted: state.showCompleted,
			animatingCompletionIds: state.animatingCompletionIds,
		})),
	);
	const visibleNodes = nodes?.filter((node) =>
		rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, search),
	);
	// The outline spends one row budget across the whole tree (see render-window.ts).
	const rowLimits = useContext(RowLimitsContext);
	const total = visibleNodes?.length ?? 0;
	const limit = rowLimits === null ? total : rowLimit(rowLimits, instanceKey(parentId, instance));
	const backlinksRootId =
		search === null && total <= limit && isBacklinksSectionVisible(backlinks, showCompleted)
			? backlinks?.rootId
			: null;
	// Only the zoomed day page shows Found Dates, after every child is rendered and outside a search.
	const dayId = found?.dayId ?? null;
	const foundDates = found?.response;
	const foundItems =
		search === null && total <= limit
			? (foundDates?.items ?? []).filter((item) => showCompleted || item.node.completedAt === null)
			: [];

	if (
		!visibleNodes ||
		(total > 0 && limit === 0) ||
		(total === 0 && backlinksRootId == null && foundItems.length === 0)
	)
	{
		return dashboard && visibleNodes !== undefined && total === 0 ? (
			<div ref={containerRef} className={isRoot ? ROOT_CHILDREN_CLASS : (className ?? NESTED_CHILDREN_CLASS)}>
				<DashboardBottomButton parentId={parentId} />
			</div>
		) : isRoot ? (
			<>
				{parentId === null && search === null && instance === null && visibleNodes !== undefined ? (
					<RootEmptyOutline />
				) : null}
				{addChild ?? null}
			</>
		) : null;
	}

	const numbers = childNumbers(nodes ?? [], visibleNodes, search !== null, showCompleted, animatingCompletionIds);
	const tree = (
		<div ref={containerRef} className={isRoot ? ROOT_CHILDREN_CLASS : (className ?? NESTED_CHILDREN_CLASS)}>
			{visibleNodes.slice(0, limit).map((node) => (
				<OutlineRow
					key={node.id}
					dashboardCard={dashboard}
					depth={depth}
					node={node}
					number={numbers.get(node.id)}
				/>
			))}
			{isRoot && !dashboard ? addChild : null}
			{isRoot || owner === undefined || limit < total || total === 0 ? null : <AddSiblingButton owner={owner} />}
			{dashboard && !isRoot ? <div className="dashboard-grid-spacer" /> : null}
			{dashboard ? <DashboardBottomButton parentId={parentId} /> : null}
			{backlinksRootId == null ? null : (
				<BacklinksSection depth={depth} items={backlinks?.items ?? []} rootId={backlinksRootId} />
			)}
			{dayId === null || foundItems.length === 0 ? null : (
				<FoundDatesSection dayId={dayId} depth={depth} items={foundItems} />
			)}
		</div>
	);
	return dashboard ? <InComplexLayoutContext.Provider value>{tree}</InComplexLayoutContext.Provider> : tree;
}

/**
 * The zoomed references root's `.children`: the target's backlink items, each preceded by its source's crumbs (which
 * collapse from the left like Found Dates'), then the add-child wrapper.
 */
function ReferencesRootChildren({targetId, addChild}: {targetId: string; addChild?: ReactNode})
{
	const {data: backlinks} = useBacklinks(targetId);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const items = (backlinks?.items ?? []).filter((item) => showCompleted || item.node.completedAt === null);
	return (
		<div className={ROOT_CHILDREN_CLASS}>
			{items.map((item) => (
				<OutlineRow key={item.node.id} backlinkCrumbs={item.crumbs} fitCrumbs depth={1} node={item.node} />
			))}
			{addChild}
		</div>
	);
}

/**
 * The zoom root's `.children`, with the zoomed day page's Found Dates. Only the root reads the zoomed node and its
 * Found Dates, so the nested `.children` of every expanded row hold no query for them.
 */
export function RootOutlineChildren({parentId, addChild}: {parentId: string | null; addChild?: ReactNode})
{
	const {data: zoomed} = useNode(parentId);
	const dayId = zoomed?.calendar?.level === "day" ? zoomed.id : null;
	const {data: response} = useFoundDates(dayId);
	if (zoomed?.isReferencesRoot === true && zoomed.parent_id !== null)
	{
		return <ReferencesRootChildren targetId={zoomed.parent_id} addChild={addChild} />;
	}
	// A zoomed board is its columns; upstream never draws the add-child button on one.
	if (parentId !== null && isBoard(zoomed?.data.layoutMode))
	{
		return <BoardChildren boardId={parentId} zoomed />;
	}
	// A zoomed table is its rows; the add-row button replaces the add-child button.
	if (zoomed !== undefined && isTable(zoomed.data.layoutMode))
	{
		return <TableChildren table={zoomed} zoomed />;
	}
	return (
		<OutlineChildren
			addChild={addChild}
			found={
				dayId === null
					? null
					:
						{
							dayId,
							response,
						}
			}
			isRoot
			owner={zoomed}
			ownerDashboard={isDashboard(zoomed?.data.layoutMode, dashboardsOn())}
			parentId={parentId}
		/>
	);
}

/**
 * Renders the outline under `parentId` as nested `.project` / `.children` elements,
 * matching upstream's DOM: each expanded row holds its children inline.
 */
export function OutlineTree({parentId: requestedId, shell = "pane"}: OutlineTreeProps)
{
	// The whole expanded view loads in one request before the swap; the root's own query then reads the cache.
	const viewPending = useOutlineViewPending(requestedId);
	const children = useChildren(requestedId, !viewPending);
	const {error} = children;
	const isLoading = viewPending || children.isPending;
	const [lastShown, setLastShown] = useState<string | null | undefined>(undefined);
	const parentId = outlineRootToShow(requestedId, isLoading, lastShown);
	const shownLoading = isLoading && parentId === requestedId;
	if (!shownLoading && lastShown !== parentId)
	{
		setLastShown(parentId);
	}
	const queryClient = useQueryClient();
	const search = useSearchFilter();
	usePrefetchSearchAncestors(search);
	const {rowLimits, budgetRows, growBudget} = useRowLimits(parentId, search);
	// The main outline scrolls the document while no pane is open: Back/Forward restore its scroll in the swap's frame.
	const paneId = usePaneId();
	const panesClosed = useOutlineStore((state) => state.panes.length === 0);
	const scrollsWindow = paneId === MAIN_PANE_ID && panesClosed;
	useLayoutEffect(() =>
	{
		if (scrollsWindow && !shownLoading)
		{
			restorePoppedScroll(parentId);
			restoreShownView(queryClient, parentId);
		}
	}, [parentId, queryClient, scrollsWindow, shownLoading]);
	const showsAddChild = shouldRenderAddChildButton(usePaneSearchQuery());
	// The main outline zoomed into a row met inside a mirror renders its children as that instance's rows.
	const zoomedInstance = useOutlineStore((state) =>
		paneId === MAIN_PANE_ID && state.zoomedNodeId === parentId ? state.zoomedInstance : null,
	);
	const rootInstance = useMemo(
		() =>
			zoomedInstance === null || parentId === null
				? null
				: childInstance(
						{
							id: parentId,
						},
						zoomedInstance,
					),
		[parentId, zoomedInstance],
	);

	const createNode = useCreateNode();
	// A click on blank outline space (below or beside the rows) clears any item selection and edits the end of the
	// last visible row.
	const handleBlankClick = (event: React.MouseEvent<HTMLDivElement>) =>
	{
		if (!(event.target instanceof Element) || !event.target.matches(BLANK_OUTLINE_SELECTOR))
		{
			return;
		}
		const last = currentSelectionView(queryClient).rows.at(-1);
		const {clearItemSelection, resumeEditing} = useOutlineStore.getState();
		if (last === undefined)
		{
			clearItemSelection();
		}
		else
		{
			resumeEditing(last.id, Number.MAX_SAFE_INTEGER);
		}
	};

	// Upstream's `xy4`, wired to `.document-end` only.
	const handleDocumentEndClick = () =>
	{
		const {itemSelection, resumeEditing} = useOutlineStore.getState();
		const view = currentSelectionView(queryClient);
		const rows = view.rows.filter((row) => row.id !== parentId);
		const store = useOutlineStore.getState();
		const visibleChildCount = (children.data ?? []).filter(
			(node) => store.showCompleted || node.completedAt === null,
		).length;
		const plan = planBlankSpaceClick(
			{
				selectionActive: itemSelection.entries.length > 0,
				lastVisibleRowId: rows.at(-1)?.id ?? null,
				searching: search !== null,
				visibleChildCount,
			},
		);
		if (plan.kind === "edit-end")
		{
			resumeEditing(plan.id, Number.MAX_SAFE_INTEGER);
		}
		else if (plan.kind === "add-child")
		{
			const visible = (children.data ?? []).filter((node) => store.showCompleted || node.completedAt === null);
			const addPlan = planAddChild(
				{
					childCount: (children.data ?? []).length,
					zoomedId: parentId,
					shapeLayout: lastChildShapeLayout(queryClient, parentId, visible.at(-1)),
				},
			);
			const id = crypto.randomUUID();
			createNode.mutate(
				{
					id,
					parent_id: addPlan.parent_id,
					name: addPlan.name,
					index: addPlan.index,
					...(addPlan.layoutMode === null
						? {}
						:
							{
								layoutMode: addPlan.layoutMode,
							}),
				},
			);
			resumeEditing(id, 0);
		}
	};

	useEffect(() =>
	{
		if (!shownLoading || error)
		{
			hideLoadingScreenOnce();
		}
	}, [shownLoading, error]);

	if (shownLoading)
	{
		return <div className="outline-tree-loading">Loading...</div>;
	}

	if (error)
	{
		return <div className="outline-tree-error">Error loading nodes: {error.message}</div>;
	}

	const rows = (
		<SearchFilterContext.Provider value={search}>
			<RowLimitsContext.Provider value={rowLimits}>
				<ZoomRootRow nodeId={parentId}>
					<MirrorInstanceContext.Provider value={rootInstance}>
						<RootOutlineChildren
							addChild={showsAddChild ? <AddChildButton parentId={parentId} /> : undefined}
							parentId={parentId}
						/>
					</MirrorInstanceContext.Provider>
				</ZoomRootRow>
			</RowLimitsContext.Provider>
		</SearchFilterContext.Provider>
	);
	const sentinel = rowLimits.remaining === 0 ? <RenderSentinel key={budgetRows} onReached={growBudget} /> : null;

	if (shell === "page")
	{
		return (
			<>
				{rows}
				{sentinel}
				{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a mouse shortcut to the last row; keyboard users move the caret with the arrow keys */}
				<div
					className="document-end flex-grow flex-shrink-0 print:hidden"
					style={
					{
						height: DOCUMENT_END_HEIGHT,
					}}
					onClick={handleDocumentEndClick}
				/>
			</>
		);
	}

	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a mouse shortcut to the last row; keyboard users move the caret with the arrow keys
		<div className="outline-tree-container" onClick={handleBlankClick}>
			<div className="scroller">
				{rows}
				{sentinel}
			</div>
		</div>
	);
}
