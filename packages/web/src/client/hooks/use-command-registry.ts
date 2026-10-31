import {selectionExportRequest} from "../export-entry.js";
import {makeTableDeps} from "./use-table-actions.js";
import {cellDelete, duplicateColumn, moveCell, structureTable} from "../table-actions.js";
import type {TableDeps} from "../table-actions.js";
import {locateCell} from "../table-cache.js";
import {HOME_TARGET} from "@workflowy/shared/types";
import {useCallback} from "react";
import {flushSync} from "react-dom";
import {notifyManager, useQueryClient} from "@tanstack/react-query";
import {closeMainPane, goToNode, movePane, nodeUrl, stepNav} from "../navigation.js";
import {FIT_REVEAL_BUFFER, MOVE_REVEAL_BUFFER, revealRowsAfterPaint} from "../reveal-row.js";
import type {RevealBuffer} from "../reveal-row.js";
import {cachedResolvedId, nodeKeys, readChildren, readItemNode, readNode, renderedCopyIds} from "../node-cache.js";
import type {NodeResponse} from "../../node-types.js";
import {useStableNavigate} from "./use-stable-navigate.js";
import {useCustomizeCommands} from "./use-customize-commands.js";
import {
	activeCommittedQuery,
	activePaneView,
	activeZoomedId,
	flushEditing,
	useOutlineStore,
} from "../stores/outline.js";
import {sortByPriority} from "../tree-position.js";
import {caretTextOffset, editorElement, placeCaretAtTextOffset, rowContent, selectionTextRange} from "../caret-dom.js";
import {currentSearchFilter} from "./use-tree-search.js";
import {focusableSiblingIds} from "../render-window.js";
import {focusCenterNext} from "../quiet-focus.js";
import type {SearchFilter} from "../search-filter.js";
import {editingAfterRemoval, firstLastNavigable, planCompleteFocus} from "../caret-navigation.js";
import type {CompleteFocus} from "../caret-navigation.js";
import {selectCompletedVisibility} from "../completed-visibility.js";
import {
	cacheMoveTree,
	needsChildrenBeforeMove,
	rowHasChildren,
	nextPotentiallyVisibleSibling,
	planBlockMove,
	planDuplicate,
	planFocusParent,
	planFocusSibling,
	planIndent,
	planOutdent,
	planToggleComplete,
	planVerticalMove,
} from "../tree-ops.js";
import type {BlockMoveDirection, MoveNodePayload} from "../tree-ops.js";
import {
	fetchChildren,
	sendBlockMoves,
	useChildren,
	useCreateNode,
	useDeleteNode,
	useMoveNode,
	useMoveNodes,
	useNode,
	useToggleComplete,
	undoAdapter,
	useExpandAll,
	useUpdateNode,
} from "./use-nodes.js";
import {collectVisibleNodeIds, currentExpansionRows, currentNavigableIds} from "./use-visible-nodes.js";
import {createDoublePressDetector, planExpandKey} from "../expansion.js";
import type {ExpandKey} from "../expansion.js";
import {useNavigateToToday} from "./use-navigate-to-today.js";
import {useZoomTo} from "./use-zoom-to.js";
import {useMoveTo} from "./use-move-to.js";
import {useMoveToDate} from "./use-move-to-date.js";
import {MOVE_TO_DATE_COMMANDS} from "../move-to-date.js";
import {inlineMirrorInsertion} from "../inline-mirror.js";
import {planInsertInlineLink} from "../inline-link.js";
import {
	isMirrorRootId,
	useDetachMirror,
	useMirrorCopy,
	useMirrorHere,
	useMirrorTo,
	useSwapMirrorOrigin,
} from "./use-mirror-to.js";
import {scheduleCompletionHide, zoomOutDelayMs} from "../completion-animation.js";
import {presentCommand, printCommand} from "../keys/dispatch.js";
import {toggleZenMode} from "./use-zen-mode.js";
import {IS_MOBILE} from "../is-mobile.js";
import type {Command, CommandContext, CommandRegistry} from "../keys/dispatch.js";
import {saveAndSyncCommand} from "../save-and-sync.js";
import {renderEditorHtml, serializeEditorHtml} from "../editor-html.js";
import {planLayoutHotkey, todoModeAvailable} from "../layout-hotkeys.js";
import {lineSplitRequests} from "../line-split.js";
import {canHaveNote} from "../layout-types.js";
import type {LayoutToggleCommand} from "../layout-types.js";
import {insertColumnSubject, insertColumnTarget} from "../board.js";
import {cachedCanRender} from "../layouts-cache.js";
import type {BoardTreeReader} from "../board.js";
import {toggleBoardOrTable} from "../item-type-select.js";
import type {ItemTypeSelectDeps} from "../item-type-select.js";
import {useCopyLink, useSortChildren} from "./use-item-actions.js";
import {useAccount} from "./use-account.js";
import {useDateSettings} from "./use-preferences.js";
import {
	plainLength,
	plainText,
	planItemsAttrToggle,
	planItemsCodeToggle,
	planItemsColorClear,
	planItemsColorToggle,
} from "../rich-text.js";
import * as latestColor from "../latest-color.js";
import {openItemColorPopup} from "../item-color-popup.js";
import {planDeleteDates} from "../date-pills.js";
import type {ColorChoice, InlineAttr, ItemField} from "../rich-text.js";
import {applyOps, captureOutlineView, runInUndoBatch, settleUndoNow} from "../undo-batch.js";
import {undoHistory} from "../undo-history.js";
import {queueUndo} from "../undo-view-state.js";
import {holdUndoReplay, previewUndoOps} from "../undo-cache.js";
import {deleteSelectedItems} from "./use-selection-keymap.js";
import {starCurrentItemCommand} from "../star-commands.js";
import {useStarActions} from "./use-starred.js";
import {useShowCompletedToggle} from "./use-show-completed-toggle.js";
import {showCompletedCommand} from "../show-completed-toggle.js";
import {readLinkPopupTarget} from "../link-popup-open.js";
import {switcherCommandAction, switcherStepCommand} from "../switcher-keys.js";
import {openInPane, paneCommands, paneNavCommands, paneNumberCommands} from "../pane-commands.js";
import {scrollPaneToTop} from "../components/pane-context.js";
import {requestPaneFocus} from "../pane-focus.js";
import {MAIN_PANE_ID, findPane} from "../pane-ids.js";
import type {UndoDirection, UndoRunner} from "../undo-view-state.js";

/** Pairs two ⌃Space presses on the same row (upstream's 250ms window). */
const toggleDetector = createDoublePressDetector();

/**
 * The ids of `nodes` the outline can show, in priority order. `search` is the filter the rows are shown under; zooming
 * lands on a new page with the search cleared, so those callers pass null.
 */
function potentiallyVisibleIds(nodes: NodeResponse[] | undefined, search: SearchFilter | null): string[] {
	const {showCompleted, animatingCompletionIds} = useOutlineStore.getState();
	return focusableSiblingIds(nodes, {showCompleted, animatingCompletionIds, search});
}

/** Upstream `JM4`: whether the row's box overlaps the viewport. */
function isRowInView(id: string): boolean {
	const rect = rowContent(id)?.closest(".project")?.getBoundingClientRect();
	if (rect === undefined) {
		return false;
	}
	return rect.bottom > 0 && rect.top < Math.max(document.documentElement.clientHeight, globalThis.innerHeight);
}

/** Whether completed rows render now: the preference, or a revealing search forcing them. */
function completedRowsShown(): boolean {
	return selectCompletedVisibility(useOutlineStore.getState()).shown;
}

/** Whether items are selected, so `ctx.items` is the selection rather than the edited row. */
function hasItemSelection(): boolean {
	return useOutlineStore.getState().itemSelection.entries.length > 0;
}

/** A command on the single item, as upstream's palette-only item commands. */
function singleItemCommand(run: (nodeId: string) => void): Command {
	return {
		available: (ctx) => ctx.items.length === 1,
		execute(ctx) {
			const [nodeId] = ctx.items;
			if (nodeId !== undefined) {
				run(nodeId);
			}
		},
	};
}

function isJumpMenuOpen(): boolean {
	return useOutlineStore.getState().jumpMenuOpen;
}

/**
 * The outline's commands, keyed by upstream command id, for the global keymap to dispatch.
 *
 * Every item command acts on `ctx.items`: the item selection in display order, else the edited node, else nothing.
 * Complete, delete and export act on every selected item and clear the selection; duplicate keeps it; indent,
 * outdent and moves move the selection as blocks and keep it. Moving between nodes is caret movement
 * (Up/Down at a node's edge, handled by editableText, which also owns Enter, Backspace and Escape).
 *
 * Navigation commands commit the edited text before leaving. Structural commands keep the caret and unsaved text
 * in place: they hold editing across the re-render so the edited row keeps (or regains) focus.
 *
 * As upstream, `navigate_to_prev_item` / `navigate_to_next_item` (⇧⌘9 / ⇧⌘0) zoom to the zoomed page's sibling,
 * and `focus_prev_sibling` / `focus_next_sibling` (⌥⌘↑ / ⌥⌘↓) move the caret to the edited row's sibling; the
 * layout commands set the layout rather than toggling it.
 */
export function useCommandRegistry(): CommandRegistry {
	const navigate = useStableNavigate();
	const queryClient = useQueryClient();
	const customizeCommands = useCustomizeCommands((url) => {
		void navigate(url);
	});
	const zoomedNodeId = useOutlineStore(activeZoomedId);
	const editingId = useOutlineStore((state) => state.editingId);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const resumeEditing = useOutlineStore((state) => state.resumeEditing);
	const stopEditing = useOutlineStore((state) => state.stopEditing);
	const holdEditing = useOutlineStore((state) => state.holdEditing);
	const releaseEditing = useOutlineStore((state) => state.releaseEditing);
	const flashMoving = useOutlineStore((state) => state.flashMoving);
	const toggleLeftBar = useOutlineStore((state) => state.toggleLeftBar);
	const toggleRightBar = useOutlineStore((state) => state.toggleRightBar);
	const toggleShowCompleted = useShowCompletedToggle();
	const {toggleStar} = useStarActions();
	const openJumpMenu = useOutlineStore((state) => state.openJumpMenu);
	const expand = useOutlineStore((state) => state.expand);
	const collapse = useOutlineStore((state) => state.collapse);
	const toggleExpand = useOutlineStore((state) => state.toggleExpand);
	const replaceExpanded = useOutlineStore((state) => state.replaceExpanded);
	const expandAll = useExpandAll();
	const openLinkPopup = useOutlineStore((state) => state.openLinkPopup);
	const openExportDialog = useOutlineStore((state) => state.openExportDialog);
	const zoomTo = useZoomTo();
	const moveTo = useMoveTo();
	const {moveToPreset, moveItemsToDate, mirrorItemsToDate, mirrorToToday} = useMoveToDate();
	const moveToPresetCommand = (key: Parameters<typeof moveToPreset>[0]): Command => ({
		available: (ctx) => ctx.items.length > 0,
		execute(ctx) {
			void moveToPreset(key, ctx.items);
		},
	});
	const mirrorTo = useMirrorTo();
	const mirrorHere = useMirrorHere();
	const mirrorCopy = useMirrorCopy();
	const detachMirror = useDetachMirror();
	const swapMirrorOrigin = useSwapMirrorOrigin();
	const openMirrorsDialog = useOutlineStore((state) => state.openMirrorsDialog);
	const zoomPane = useOutlineStore((state) => state.zoomPane);
	const navigateToToday = useNavigateToToday();
	// ⌃T in an open pane zooms that pane: the active pane is read when today's page resolves.
	const navigateActivePaneToToday = useNavigateToToday((id) => {
		const {activePaneId} = useOutlineStore.getState();
		zoomPane(activePaneId, id);
	});
	const createNodeMutation = useCreateNode();
	const moveNodeMutation = useMoveNode();
	const moveNodesMutation = useMoveNodes();
	const deleteNodeMutation = useDeleteNode();
	const toggleCompleteMutation = useToggleComplete();
	const updateNodeMutation = useUpdateNode();
	const dateSettings = useDateSettings();
	const account = useAccount();
	const copyLink = useCopyLink();
	const sortChildren = useSortChildren();

	// The zoomed node's parent and siblings, for zooming out and to its siblings
	const {data: zoomedNode} = useNode(zoomedNodeId);
	const {data: zoomedNodeSiblings} = useChildren(zoomedNode?.parent_id ?? null);

	// The edited node is the only item commands act on
	const {data: editedNode} = useNode(editingId);

	/** The loaded node of the command's item, or undefined with no item. */
	const itemNode = (ctx: CommandContext): NodeResponse | undefined =>
		readItemNode(queryClient, ctx.items[0], editedNode);

	/** Commit the edited text and stop editing, exactly as clicking away would. */
	const commitEdit = useCallback(() => {
		if (editingId !== null) {
			editorElement(editingId)?.blur();
		}
	}, [editingId]);

	/**
	 * Move the edited node, keeping its caret and unsaved text through the re-render,
	 * after expanding its new parent when the plan asks for it.
	 */
	const moveEditedNode = useCallback(
		(
			plan: (MoveNodePayload & {expandParentId?: string | null}) | null,
			reveal: RevealBuffer = FIT_REVEAL_BUFFER,
		) => {
			if (plan === null) {
				return;
			}
			const {expandParentId, ...payload} = plan;
			if (expandParentId !== undefined && expandParentId !== null) {
				expand(expandParentId);
			}
			const editor = editorElement(payload.nodeId);
			if (editor) {
				const {start, end, reversed} = selectionTextRange(editor);
				holdEditing(start, end, reversed);
			} else {
				holdEditing(Number.MAX_SAFE_INTEGER);
			}
			moveNodeMutation.mutate(payload, {onSettled: releaseEditing});
			revealRowsAfterPaint([payload.nodeId], reveal);
		},
		[expand, holdEditing, releaseEditing, moveNodeMutation],
	);

	/**
	 * Runs `then` once `parentId`'s children are cached, holding the edited row's selection meanwhile (a move into a
	 * never-opened collapsed row would otherwise vanish until the children landed). A failed load changes nothing.
	 */
	const loadChildrenThen = async (parentId: string | null, then: () => void): Promise<void> => {
		const editor = editingId === null ? null : editorElement(editingId);
		if (editor !== null) {
			const {start, end, reversed} = selectionTextRange(editor);
			holdEditing(start, end, reversed);
		}
		try {
			await queryClient.query({
				queryKey: nodeKeys.children(parentId),
				queryFn: async () => fetchChildren(parentId),
				staleTime: "static",
			});
		} catch {
			releaseEditing();
			return;
		}
		then();
	};

	/**
	 * Move the item selection as blocks (`planBlockMove`) in one undo step, keeping it selected and expanding each
	 * new parent.
	 */
	const moveSelection = (ctx: CommandContext, direction: BlockMoveDirection): void => {
		const state = useOutlineStore.getState();
		const tree = cacheMoveTree(queryClient, state);
		const moves = planBlockMove(ctx.items, direction, tree, zoomedNodeId);
		const unloaded = moves.find(({parentId}) => needsChildrenBeforeMove(tree, parentId));
		if (unloaded !== undefined) {
			// Planned again once the target's children are cached, so the block lands among them.
			void loadChildrenThen(unloaded.parentId, () => {
				moveSelection(ctx, direction);
			});
			return;
		}
		// Each new parent expands in the same render as its optimistic splice, never a frame before it.
		const expanding = moves.map((move) => ({
			...move,
			expandParent:
				move.parentId !== null &&
				move.parentId !== zoomedNodeId &&
				!activePaneView().expandedIds.has(move.parentId),
		}));
		if (moves.length > 0) {
			void runInUndoBatch(captureOutlineView, async () => sendBlockMoves(expanding, moveNodesMutation.mutate));
			// Upstream `WF.Scroll.fit`: both ends of the moved selection stay in view.
			revealRowsAfterPaint(
				[ctx.items[0], ctx.items.at(-1)].filter((id) => id !== undefined),
				FIT_REVEAL_BUFFER,
			);
		}
	};

	/** Swap with a sibling or cross into the parent's sibling, expanding it. */
	const moveEditedNodeVertically = (ctx: CommandContext, direction: "up" | "down"): void => {
		if (hasItemSelection()) {
			moveSelection(ctx, direction);
			return;
		}
		const [nodeId] = ctx.items;
		if (nodeId === undefined) {
			return;
		}
		const tree = cacheMoveTree(queryClient, useOutlineStore.getState());
		const plan = planVerticalMove({nodeId, direction, zoomRootId: zoomedNodeId, tree});
		if (plan === null) {
			return;
		}
		if (needsChildrenBeforeMove(tree, plan.parentId)) {
			void loadChildrenThen(plan.parentId, () => {
				moveEditedNodeVertically(ctx, direction);
			});
			return;
		}
		moveEditedNode(
			{nodeId: plan.nodeId, parent_id: plan.parentId, index: plan.index, expandParentId: plan.expandParentId},
			MOVE_REVEAL_BUFFER,
		);
		flashMoving([plan.nodeId]);
	};

	/** Tab: the selection as blocks, else the edited row as the last child of its previous sibling. */
	const indentItem = (ctx: CommandContext): void => {
		if (hasItemSelection()) {
			moveSelection(ctx, "indent");
			return;
		}
		const node = itemNode(ctx);
		if (node === undefined) {
			return;
		}
		const plan = planIndent(queryClient, node, activePaneView().expandedIds);
		const tree = cacheMoveTree(queryClient, useOutlineStore.getState());
		if (plan !== null && needsChildrenBeforeMove(tree, plan.parent_id)) {
			// Without the previous sibling's children the row could not be placed after them.
			void loadChildrenThen(plan.parent_id, () => {
				indentItem(ctx);
			});
			return;
		}
		moveEditedNode(plan);
	};

	/** Continue editing beside the edited node, which is about to leave the view. */
	const editBesideRemovedNode = (nodeId: string): void => {
		const next = editingAfterRemoval(currentNavigableIds(queryClient), nodeId);
		if (next === null) {
			stopEditing();
		} else {
			resumeEditing(next.nodeId, next.caretOffset);
		}
	};

	/**
	 * Upstream's layout toggles (`planLayoutToggle`) over the command targets, in one undo step. While editing, the
	 * unsaved text is committed first and the editor stays open with the caret in place, showing any rewritten name.
	 */
	const toggleLayout = (ctx: CommandContext, command: LayoutToggleCommand): void => {
		const nodes = ctx.items.flatMap((id) => readNode(queryClient, id) ?? []);
		if (nodes.length === 0) {
			return;
		}
		const editor = editingId !== null && !hasItemSelection() ? editorElement(editingId) : null;
		const edited =
			editor !== null && editingId !== null
				? {nodeId: editingId, name: serializeEditorHtml(editor.innerHTML)}
				: undefined;
		const plan = planLayoutHotkey(command, nodes, edited);
		if (editor !== null && edited !== undefined) {
			flushEditing();
			let caret = caretTextOffset(editor);
			const renamed = plan.updates.find((update) => update.nodeId === edited.nodeId)?.name;
			if (renamed !== undefined) {
				caret = Math.max(0, caret - (plainLength(edited.name) - plainLength(renamed)));
				editor.innerHTML = renderEditorHtml(renamed, dateSettings, account);
				placeCaretAtTextOffset(editor, caret);
			}
			holdEditing(caret);
		}
		void runInUndoBatch(captureOutlineView, () => {
			for (const update of plan.updates) {
				updateNodeMutation.mutate(update, {onSettled: releaseEditing});
			}
			for (const nodeId of plan.deletes) {
				deleteNodeMutation.mutate(nodeId);
			}
			for (const request of lineSplitRequests(queryClient, plan.creates)) {
				createNodeMutation.mutate(request);
			}
		});
		if (plan.clearSelection) {
			useOutlineStore.getState().clearItemSelection();
		}
	};

	const layoutCommand = (command: LayoutToggleCommand): Command => ({
		execute(ctx) {
			toggleLayout(ctx, command);
		},
	});

	/** The table commands' effects over this registry's mutations. */
	const tableDeps = (): TableDeps =>
		makeTableDeps(queryClient, {
			create: createNodeMutation.mutate,
			remove: deleteNodeMutation.mutate,
			move: moveNodeMutation.mutate,
			update: updateNodeMutation.mutate,
		});

	/** The table cell a keyboard command acts on: the single caret item, when no item selection is up. */
	const tableCellOf = (ctx: CommandContext) => {
		const [nodeId] = ctx.items;
		return hasItemSelection() || ctx.items.length !== 1 || nodeId === undefined
			? null
			: locateCell(queryClient, nodeId);
	};

	const itemTypeDeps: ItemTypeSelectDeps = {
		structureTable: (nodeId, on) => {
			void structureTable(tableDeps(), nodeId, on);
		},
		update: (nodeId, layoutMode, extra) => {
			updateNodeMutation.mutate({nodeId, layoutMode, ...extra});
		},
		plainName: (nodeId) => plainText(readNode(queryClient, nodeId)?.name ?? "", ""),
		createAfter: (nodeId, lines) => {
			for (const request of lineSplitRequests(
				queryClient,
				lines.map((line) => ({afterId: nodeId, ...line})),
			)) {
				createNodeMutation.mutate(request);
			}
		},
		hasNote: (nodeId) => (readNode(queryClient, nodeId)?.note ?? "") !== "",
		expandAll: (ids) => {
			replaceExpanded(new Set([...activePaneView().expandedIds, ...ids]));
		},
		childIds: (nodeId) => (readChildren(queryClient, nodeId) ?? []).map((child) => child.id),
		createChild: (parentId) => {
			const id = crypto.randomUUID();
			createNodeMutation.mutate({
				id,
				parent_id: parentId === HOME_TARGET ? undefined : parentId,
				name: "",
				index: 0,
			});
			return id;
		},
		startEditing: (nodeId) => {
			useOutlineStore.getState().resumeEditing(nodeId, 0);
		},
		layoutMode: (nodeId) => readNode(queryClient, nodeId)?.data.layoutMode ?? null,
	};

	/** Upstream `toggle_board` / `toggle_table` on the single item, in one undo step. */
	const boardOrTableCommand = (command: "toggle_board" | "toggle_table"): Command =>
		singleItemCommand((nodeId) => {
			void runInUndoBatch(captureOutlineView, () => {
				toggleBoardOrTable(command, nodeId, itemTypeDeps);
			});
		});

	/** Upstream `insert_board_column_left/right`: a new empty column beside the board, column or card. */
	const insertColumnCommand = (kind: "left" | "right"): Command => {
		const tree: BoardTreeReader = {
			node: (id) => {
				const node = readNode(queryClient, id);
				return node === undefined
					? undefined
					: {parent_id: node.parent_id, layoutMode: node.data.layoutMode ?? null};
			},
			childIds: (parentId) => (readChildren(queryClient, parentId) ?? []).map((child) => child.id),
			renders: (id) => cachedCanRender(queryClient, id, "board"),
		};
		return {
			available: (ctx) =>
				ctx.items.length === 1 && ctx.items.every((id) => insertColumnSubject(id, tree) !== null),
			execute(ctx) {
				const [nodeId] = ctx.items;
				const subject = nodeId === undefined ? null : insertColumnSubject(nodeId, tree);
				if (subject === null) {
					return;
				}
				const target = insertColumnTarget(kind, subject);
				const id = crypto.randomUUID();
				void runInUndoBatch(captureOutlineView, () => {
					createNodeMutation.mutate({id, parent_id: target.parentId, name: "", index: target.index});
				});
				useOutlineStore.getState().resumeEditing(id, 0);
			},
		};
	};

	/**
	 * Upstream `navigate_to_next_item` / `prev_item`: zoom to the zoomed page's potentially visible sibling `step`
	 * places away, scroll to the top, then edit its first visible child (or its title) at offset 0. In an open pane
	 * (`paneId`) it zooms the pane and scrolls the pane's scroller.
	 */
	const jumpToSibling = async (step: -1 | 1, paneId: string | null): Promise<void> => {
		if (zoomedNodeId === null || zoomedNode === undefined) {
			return;
		}
		const siblings = readChildren(queryClient, zoomedNode.parent_id) ?? zoomedNodeSiblings ?? [];
		const targetId = nextPotentiallyVisibleSibling(siblings, zoomedNodeId, step, showCompleted);
		if (targetId === null) {
			return;
		}
		commitEdit();
		if (paneId === null) {
			void navigate(nodeUrl(targetId));
			scrollPaneToTop(MAIN_PANE_ID);
		} else {
			zoomPane(paneId, targetId);
			scrollPaneToTop(paneId);
		}
		const children = await queryClient.query({
			queryKey: nodeKeys.children(targetId),
			queryFn: async () => fetchChildren(targetId),
			staleTime: "static",
		});
		resumeEditing(potentiallyVisibleIds(children, null)[0] ?? targetId, 0);
	};

	/**
	 * Upstream `focus_next_sibling` / `prev`: edit the edited row's focusable sibling at offset 0, honoring the search.
	 * With nothing focused, the first child in the viewport. Going down centers the target.
	 */
	const focusSibling = (ctx: CommandContext, step: -1 | 1): void => {
		const currentId = ctx.items[0] ?? null;
		const currentNode =
			currentId === null || currentId === zoomedNodeId ? undefined : readNode(queryClient, currentId);
		const search = currentSearchFilter(queryClient);
		const children = potentiallyVisibleIds(readChildren(queryClient, zoomedNodeId), search);
		const targetId = planFocusSibling(
			{
				zoomedId: zoomedNodeId,
				currentId,
				firstChildId: children[0] ?? null,
				firstInViewChildId: currentId === null ? (children.find(isRowInView) ?? null) : null,
				siblings:
					currentNode === undefined
						? []
						: potentiallyVisibleIds(readChildren(queryClient, currentNode.parent_id), search),
			},
			step,
		);
		if (targetId !== null) {
			commitEdit();
			if (step === 1 || currentId === null) {
				focusCenterNext(targetId);
			}
			resumeEditing(targetId, 0);
		}
	};

	/** Upstream `focus_parent` (unbound): edit the row's parent at offset 0, centered; the title from a top-level row. */
	const focusParent = (ctx: CommandContext): void => {
		const currentId = ctx.items[0] ?? null;
		const parentId = currentId === null ? null : (readNode(queryClient, currentId)?.parent_id ?? null);
		const targetId = planFocusParent({
			zoomedId: zoomedNodeId,
			currentId,
			parentOf: currentId === null || parentId === null ? {} : {[currentId]: parentId},
		});
		if (targetId !== null) {
			commitEdit();
			focusCenterNext(targetId);
			resumeEditing(targetId, 0);
		}
	};

	/**
	 * Upstream `focus_first` / `focus_last`: caret at the start of the first navigable node or the end of the last.
	 * `skipTitle` skips the zoomed title, for upstream's `WF.Focus.firstChildOfSelected`.
	 */
	const focusEdge = (edge: "first" | "last", skipTitle = false): void => {
		const state = activePaneView();
		const visibleIds = collectVisibleNodeIds(
			queryClient,
			state.zoomedNodeId,
			state.expandedIds,
			state.showCompleted,
			state.animatingCompletionIds,
		);
		const targets = firstLastNavigable(
			visibleIds,
			state.zoomedNodeId === null || skipTitle
				? {titleEditable: false}
				: {titleEditable: true, zoomedId: state.zoomedNodeId},
		);
		if (targets === null) {
			return;
		}
		const targetId = targets[edge];
		const offset = edge === "first" ? 0 : Number.MAX_SAFE_INTEGER;
		const editor = targetId === state.editingId ? editorElement(targetId) : null;
		if (editor === null) {
			commitEdit();
			resumeEditing(targetId, offset);
		} else {
			placeCaretAtTextOffset(editor, offset);
		}
	};

	/** `"column"` when the node's parent is a board. */
	const columnRole = (node: NodeResponse): "column" | null => {
		const parent = node.parent_id === null ? undefined : readNode(queryClient, node.parent_id);
		return parent !== undefined && cachedCanRender(queryClient, parent.id, "board") ? "column" : null;
	};

	/**
	 * Upstream ⌘↓ / ⌘↑ / ⌃Space: act on the edited row, or on the zoom root when its title is edited or nothing is.
	 * The caret stays where it is.
	 */
	const expandKey = (ctx: CommandContext, key: ExpandKey): void => {
		const [itemId] = ctx.items;
		const isRoot = itemId === undefined || itemId === ctx.zoomedId;
		const node = itemNode(ctx);
		const {expandedIds, showCompleted: completedShown} = activePaneView();
		const rowId = itemId ?? "";
		const plan = planExpandKey({
			key,
			target: isRoot ? "root" : "row",
			id: rowId,
			isOpen: expandedIds.has(rowId),
			hasVisibleChildren: node === undefined || rowHasChildren(node, completedShown),
			now: performance.now(),
			detector: toggleDetector,
			rows: isRoot ? currentExpansionRows(queryClient) : [],
			expanded: expandedIds,
			role: node === undefined ? null : columnRole(node),
		});
		switch (plan.type) {
			case "none":
				return;
			case "expand":
				expand(plan.id);
				return;
			case "collapse":
				collapse(plan.id);
				return;
			case "toggle":
				toggleExpand(plan.id);
				return;
			case "all":
				expandAll(isRoot ? ctx.zoomedId : plan.id, plan.open);
				return;
			case "level": {
				const next = new Set(expandedIds);
				for (const id of plan.ids) {
					if (plan.open) {
						next.add(id);
					} else {
						next.delete(id);
					}
				}
				replaceExpanded(next);
			}
		}
	};

	/** Rewrites the name and non-empty note of every selected item as one undo step; the selection stays. */
	const editSelectionFields = (ctx: CommandContext, plan: (fields: ItemField[]) => ItemField[]): void => {
		commitEdit();
		const fields: ItemField[] = [];
		for (const id of new Set(ctx.items)) {
			const node = readNode(queryClient, id);
			if (node === undefined) {
				continue;
			}
			fields.push({id, field: "name", html: node.name ?? ""});
			if (node.note !== null && node.note !== "") {
				fields.push({id, field: "note", html: node.note});
			}
		}
		const changed = plan(fields);
		const updates = new Map<string, {nodeId: string; name?: string; note?: string}>();
		for (const {id, field, html} of changed) {
			updates.set(id, {...updates.get(id), nodeId: id, [field]: html});
		}
		if (updates.size === 0) {
			return;
		}
		void runInUndoBatch(captureOutlineView, () => {
			for (const update of updates.values()) {
				updateNodeMutation.mutate(update);
			}
		});
	};

	const formatSelection = (ctx: CommandContext, attr: InlineAttr): void => {
		editSelectionFields(ctx, (fields) =>
			attr === "code" ? planItemsCodeToggle(fields) : planItemsAttrToggle(fields, attr),
		);
	};

	/** Upstream's `toggleAttributeForItems` with a color: the selected items' names and notes. */
	const colorSelection = (ctx: CommandContext, choice: ColorChoice): void => {
		editSelectionFields(ctx, (fields) => planItemsColorToggle(fields, choice));
	};

	/** Upstream's `openForItems`: the color popup under the last selected item's content. */
	const openColorPopupForItems = (ctx: CommandContext): void => {
		const [last] = ctx.items.toReversed();
		const box = (last === undefined ? null : rowContent(last))?.getBoundingClientRect();
		if (box === undefined) {
			return;
		}
		openItemColorPopup({
			left: box.left,
			top: box.bottom,
			onPick: (kind, color) => {
				// Upstream `ItemSelectColor` on a table cell writes the cell's `table.bg` instead of a text color.
				const cells = ctx.items.filter((id) => locateCell(queryClient, id) !== null);
				for (const nodeId of cells) {
					updateNodeMutation.mutate({nodeId, tableSet: [{path: ["table", "bg"], value: color ?? undefined}]});
				}
				const rest: CommandContext = {...ctx, items: ctx.items.filter((id) => !cells.includes(id))};
				if (rest.items.length === 0) {
					return;
				}
				if (color === null) {
					// "remove color" leaves the latest color alone and strips both kinds from every item.
					editSelectionFields(rest, planItemsColorClear);
					return;
				}
				latestColor.change(kind, color);
				colorSelection(rest, {kind, color});
			},
		});
	};

	/** Upstream's `dL2` blocks read-only items and backlink roots. */
	const isCompleteBlocked = (id: string): boolean => readNode(queryClient, id)?.readOnly === true;

	/** Where the caret goes after toggling completion on `ids`, which must be in display order. */
	const planCompletionFocus = (ids: readonly string[], completing: boolean): CompleteFocus => {
		const visibleRows = currentNavigableIds(queryClient);
		return planCompleteFocus({
			ids,
			completing,
			showCompleted: completedRowsShown(),
			zoomRootId: zoomedNodeId,
			siblingsOf: (id) =>
				sortByPriority(
					queryClient.getQueryData<NodeResponse[]>(
						nodeKeys.children(readNode(queryClient, id)?.parent_id ?? null),
					) ?? [],
				).map((sibling) => sibling.id),
			visibleRows,
			completedIds: new Set(visibleRows.filter((id) => readNode(queryClient, id)?.completedAt != null)),
		});
	};

	/** Upstream zooms a completed zoom root out on a timer that does not wait for the server. */
	const scheduleZoomOut = (): void => {
		const parentOfZoomed = zoomedNode?.parent_id ?? null;
		setTimeout(() => {
			void navigate(parentOfZoomed === null ? "/" : nodeUrl(parentOfZoomed));
		}, zoomOutDelayMs(completedRowsShown()));
	};

	/** Toggle complete on every selected item as one undo step, then clear the selection. */
	const completeSelection = (ids: readonly string[]): void => {
		const store = useOutlineStore.getState();
		store.clearItemSelection();
		const order = currentNavigableIds(queryClient);
		const sortedIds = ids.toSorted((x, y) => order.indexOf(x) - order.indexOf(y));
		const plan = planToggleComplete(
			sortedIds.map((id) => readNode(queryClient, id)).filter((node) => node !== undefined),
			isCompleteBlocked,
		);
		if (plan.action === "none") {
			return;
		}
		const completing = plan.action === "complete";
		const focus = planCompletionFocus(plan.ids, completing);
		if (completing && !completedRowsShown()) {
			scheduleCompletionHide(
				renderedCopyIds(queryClient, plan.ids),
				store,
				(id) => !completedRowsShown() && readNode(queryClient, id)?.completedAt !== null,
			);
		}
		void runInUndoBatch(captureOutlineView, () => {
			for (const nodeId of plan.ids) {
				toggleCompleteMutation.mutate({nodeId, isCurrentlyCompleted: !completing});
			}
		});
		const [first] = plan.ids;
		if (focus.kind === "row") {
			resumeEditing(focus.id, focus.offset);
		} else if (focus.kind === "zoomTitle" && zoomedNodeId !== null) {
			resumeEditing(zoomedNodeId, 0);
		} else if (focus.kind === "zoomOut") {
			scheduleZoomOut();
		} else if (!completing && first !== undefined) {
			resumeEditing(first, 0);
		}
	};

	/** Toggle complete on the edited node and move the caret as upstream does, or on the whole selection. */
	const complete = (ctx: CommandContext): void => {
		if (hasItemSelection()) {
			completeSelection(ctx.items);
			return;
		}
		const node = itemNode(ctx);
		if (node === undefined) {
			return;
		}
		const plan = planToggleComplete([node], isCompleteBlocked);
		if (plan.action === "none") {
			return;
		}
		const completing = plan.action === "complete";
		const focus = planCompletionFocus(plan.ids, completing);

		// Pending text is its own undo step (upstream `saveFocused()` before `startOperationBatch`); the command's step
		// then captures the view BEFORE the caret moves, so undo returns to the completed row.
		flushEditing();
		void runInUndoBatch(captureOutlineView, () => {
			// The text is saved above. Upstream leaves the caret alone when it stays in the edited row or the title
			// is being completed, and otherwise blurs it before moving.
			const staysInPlace =
				focus.kind === "stay" || focus.kind === "zoomOut" || (focus.kind === "row" && focus.id === editingId);
			if (!staysInPlace) {
				commitEdit();
			}
			if (focus.kind === "row" && focus.id === editingId) {
				const editor = editorElement(focus.id);
				if (editor === null) {
					resumeEditing(focus.id, focus.offset);
				} else {
					placeCaretAtTextOffset(editor, focus.offset);
				}
			} else if (focus.kind === "row") {
				resumeEditing(focus.id, focus.offset);
			} else if (focus.kind === "zoomTitle" && zoomedNodeId !== null) {
				resumeEditing(zoomedNodeId, 0);
			}

			// Hidden completed rows stay for upstream's deferred hide; the caret has already moved
			if (completing && !completedRowsShown()) {
				scheduleCompletionHide(renderedCopyIds(queryClient, plan.ids), useOutlineStore.getState(), (id) => {
					const current = readNode(queryClient, id);
					return !completedRowsShown() && current?.completedAt !== null;
				});
			}
			for (const nodeId of plan.ids) {
				toggleCompleteMutation.mutate({nodeId, isCurrentlyCompleted: !completing});
			}
			if (focus.kind === "zoomOut") {
				scheduleZoomOut();
			}
		});
	};

	/**
	 * ⌘K: with a selection clear of links or a caret inside a link, upstream's Text/Link popup; otherwise the Jump menu
	 * (a selection touching a link falls through to it).
	 */
	const showSwitcher = (ctx: CommandContext): void => {
		const [itemId] = ctx.items;
		const target = itemId === undefined ? null : readLinkPopupTarget(itemId);
		if (target !== null) {
			openLinkPopup(target);
			return;
		}
		if (switcherCommandAction(isJumpMenuOpen()) === "open") {
			openJumpMenu();
		}
	};

	const undoRunner: UndoRunner = {
		flush: flushEditing,
		settled: settleUndoNow,
		pop: (direction, match) =>
			direction === "undo"
				? match === undefined
					? undoHistory.popUndo()
					: undoHistory.popUndoWhere(match)
				: undoHistory.popRedo(),
		blur() {
			// Committed at once, so the editor unmounts: a row edited both before and after the undo would otherwise keep
			// its held text, since stopping and resuming in one render never leaves editing.
			flushSync(() => {
				const {editingId: editedId, editingNoteId: editedNoteId} = useOutlineStore.getState();
				if (editedId !== null) {
					editorElement(editedId)?.blur();
				}
				// A focused note holds its typed HTML, so it must blur to re-render the restored text.
				const active = document.activeElement;
				if (active instanceof HTMLElement && active.isContentEditable && active.closest(".notes") !== null) {
					active.blur();
				}
				if (editedNoteId !== null) {
					useOutlineStore.getState().blurNote(editedNoteId);
				}
				stopEditing();
			});
		},
		hold(ops) {
			return holdUndoReplay(queryClient, ops);
		},
		preview(ops) {
			// A refetch still in flight from the forward action would land over the previewed rows.
			void queryClient.cancelQueries({queryKey: nodeKeys.all});
			previewUndoOps(queryClient, ops);
		},
		async apply(ops) {
			await applyOps(ops, undoAdapter);
		},
		async reconcile() {
			await queryClient.invalidateQueries();
		},
		current: captureOutlineView,
		editorFocused() {
			const active = document.activeElement;
			return (
				active instanceof HTMLElement &&
				(active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")
			);
		},
		select(ids) {
			useOutlineStore.getState().restoreItemSelection(ids);
		},
		textLength(nodeId, field) {
			const node = readNode(queryClient, nodeId);
			return plainLength((field === "name" ? node?.name : node?.note) ?? "");
		},
		zoomTo(nodeId) {
			goToNode(navigate, nodeId);
		},
		focus({nodeId, field, start, end, reversed}) {
			// Queued behind the preview's cache notifications, so the editor mounts on the restored text.
			notifyManager.schedule(() => {
				if (field === "name") {
					resumeEditing(nodeId, start, {end, reversed});
				} else {
					useOutlineStore.getState().focusNote(nodeId, start);
				}
			});
		},
	};

	/** Upstream ⌘Z / ⇧⌘Z: claimed even with an empty stack, so the browser's native undo never runs. */
	const undoCommand = (direction: UndoDirection) => ({
		execute(ctx?: CommandContext) {
			queueUndo(direction, undoRunner, ctx?.undoMatch).catch((error: unknown) => {
				useOutlineStore
					.getState()
					.addErrorNotification(
						`Couldn't ${direction}: ${error instanceof Error ? error.message : String(error)}`,
					);
			});
		},
	});

	const selectionFormatCommand = (attr: InlineAttr): Command => ({
		available: (ctx) => hasItemSelection() && ctx.items.length > 0,
		execute: (ctx) => {
			formatSelection(ctx, attr);
		},
	});

	return {
		undo: undoCommand("undo"),
		redo: undoCommand("redo"),
		save_and_sync: saveAndSyncCommand(() => {
			void queryClient.invalidateQueries();
		}),
		zoom_in: {
			execute(ctx) {
				const [nodeId] = ctx.items;
				if (nodeId !== undefined) {
					void zoomTo(nodeId, "first_child");
				}
			},
		},
		zoom_out: {
			execute() {
				void zoomTo(null, "last_selected");
			},
		},
		focus_prev_sibling: {
			execute(ctx) {
				focusSibling(ctx, -1);
			},
		},
		focus_next_sibling: {
			execute(ctx) {
				focusSibling(ctx, 1);
			},
		},
		focus_parent: {
			execute(ctx) {
				focusParent(ctx);
			},
		},
		focus_first: {
			execute() {
				focusEdge("first");
			},
		},
		focus_last: {
			execute() {
				focusEdge("last");
			},
		},
		expand: {
			execute(ctx) {
				expandKey(ctx, "expand");
			},
		},
		// The editor owns these keys while it has the caret; with an item selection they format the whole items.
		toggle_bold: selectionFormatCommand("b"),
		toggle_italic: selectionFormatCommand("i"),
		toggle_underline: selectionFormatCommand("u"),
		toggle_strikethrough: selectionFormatCommand("s"),
		toggle_code: selectionFormatCommand("code"),
		// ⇧⌘H over an item selection reapplies the latest color, or opens the popup when none was picked. The editor
		// handles it itself while it has the caret.
		highlight_selected: {
			available: (ctx) => hasItemSelection() && ctx.items.length > 0,
			execute: (ctx) => {
				const latest = latestColor.get();
				if (latest === undefined) {
					openColorPopupForItems(ctx);
				} else {
					colorSelection(ctx, latest);
				}
			},
		},
		show_color_popup: {
			available: (ctx) =>
				ctx.items.length > 0 && ctx.items.every((id) => readNode(queryClient, id)?.readOnly !== true),
			execute: openColorPopupForItems,
		},
		print: printCommand(),
		show_command_palette: {
			execute(ctx) {
				useOutlineStore.getState().openCommandPalette(ctx);
			},
		},
		toggle_full_width_page: {
			execute() {
				useOutlineStore.getState().toggleFullWidthPage();
			},
		},
		zen_mode: {
			available: () => !IS_MOBILE,
			execute: toggleZenMode,
		},
		present_it: {
			execute(ctx) {
				presentCommand({
					open: (nodeId) => {
						useOutlineStore.getState().openPresentation(nodeId);
					},
					expand: (nodeId) => {
						expandKey({items: [nodeId], zoomedId: ctx.zoomedId}, "expand");
					},
				}).execute(ctx);
			},
		},
		collapse: {
			execute(ctx) {
				expandKey(ctx, "collapse");
			},
		},
		expand_or_collapse: {
			execute(ctx) {
				expandKey(ctx, "toggle");
			},
		},
		indent: {execute: indentItem},
		outdent: {
			execute(ctx) {
				if (hasItemSelection()) {
					moveSelection(ctx, "outdent");
					return;
				}
				const node = itemNode(ctx);
				if (node !== undefined) {
					moveEditedNode(planOutdent(queryClient, node, zoomedNodeId));
				}
			},
		},
		move_up: {
			execute(ctx) {
				const cell = tableCellOf(ctx);
				if (cell !== null) {
					flushEditing();
					void moveCell(tableDeps(), cell, "up");
					return;
				}
				moveEditedNodeVertically(ctx, "up");
			},
		},
		move_down: {
			execute(ctx) {
				const cell = tableCellOf(ctx);
				if (cell !== null) {
					flushEditing();
					void moveCell(tableDeps(), cell, "down");
					return;
				}
				moveEditedNodeVertically(ctx, "down");
			},
		},
		duplicate_table_column: {
			available: (ctx) => tableCellOf(ctx) !== null,
			execute(ctx) {
				const cell = tableCellOf(ctx);
				if (cell !== null) {
					flushEditing();
					void duplicateColumn(tableDeps(), cell);
				}
			},
		},
		delete_table_column: {
			available: (ctx) => tableCellOf(ctx)?.rowIndex === 0,
			execute(ctx) {
				const cell = tableCellOf(ctx);
				if (cell !== null) {
					flushEditing();
					void cellDelete(tableDeps(), cell, []);
				}
			},
		},
		move_to: {
			available: (ctx) => ctx.items.length > 0 && ctx.items.every((id) => id !== ctx.zoomedId),
			execute(ctx) {
				void moveTo(ctx.items);
			},
		},
		move_to_today: moveToPresetCommand("move_to_today"),
		move_to_tomorrow: moveToPresetCommand("move_to_tomorrow"),
		move_to_next_week: moveToPresetCommand("move_to_next_week"),
		move_7_days_out: moveToPresetCommand("move_7_days_out"),
		move_to_date: {
			available: (ctx) => ctx.items.length > 0,
			execute(ctx) {
				const [first] = ctx.items;
				if (first !== undefined) {
					useOutlineStore.getState().requestDatePicker(first, undefined, {
						headerText: MOVE_TO_DATE_COMMANDS.move_to_date.label,
						onSelect: ([date]) => {
							if (date !== undefined) {
								void moveItemsToDate(ctx.items, date);
							}
						},
					});
				}
			},
		},
		mirror_to_today: {
			available: (ctx) => ctx.items.length > 0,
			execute(ctx) {
				void mirrorToToday(ctx.items);
			},
		},
		mirror_to_date: {
			available: (ctx) => ctx.items.length > 0,
			execute(ctx) {
				const [first] = ctx.items;
				if (first !== undefined) {
					useOutlineStore.getState().requestDatePicker(first, undefined, {
						headerText: MOVE_TO_DATE_COMMANDS.mirror_to_date.label,
						onSelect: ([date]) => {
							if (date !== undefined) {
								void mirrorItemsToDate(ctx.items, date);
							}
						},
					});
				}
			},
		},
		mirror: {
			available: (ctx) => ctx.items.length > 0,
			execute(ctx) {
				mirrorCopy(ctx.items);
			},
		},
		mirror_to: {
			available: (ctx) => ctx.items.length > 0,
			execute(ctx) {
				void mirrorTo(ctx.items);
			},
		},
		mirror_to_child: {
			available: (ctx) => ctx.items.length > 0,
			execute(ctx) {
				void mirrorTo(ctx.items);
			},
		},
		mirror_here: {
			available: (ctx) => ctx.items.length === 1,
			execute(ctx) {
				const [itemId] = ctx.items;
				if (itemId !== undefined) {
					void mirrorHere(itemId);
				}
			},
		},
		show_mirror_breadcrumbs: {
			available: (ctx) => ctx.items.length === 1 && ctx.items.every((id) => isMirrorRootId(queryClient, id)),
			execute(ctx) {
				const [itemId] = ctx.items;
				const node = itemId === undefined ? undefined : readNode(queryClient, itemId);
				if (node !== undefined) {
					openMirrorsDialog(node.isMirror === true ? (node.originalNodeId ?? node.id) : node.id);
				}
			},
		},
		detach_mirror: {
			available: (ctx) => ctx.items.length === 1 && ctx.items.every((id) => isMirrorRootId(queryClient, id)),
			execute(ctx) {
				const [itemId] = ctx.items;
				if (itemId !== undefined) {
					void detachMirror(itemId);
				}
			},
		},
		swap_mirror_origin: {
			// Upstream: one mirror whose original is known, or one original that has mirrors.
			available: (ctx) => ctx.items.length === 1 && ctx.items.every((id) => isMirrorRootId(queryClient, id)),
			execute(ctx) {
				const [itemId] = ctx.items;
				if (itemId !== undefined) {
					void swapMirrorOrigin(itemId);
				}
			},
		},
		insert_inline_mirror: {
			available: () => editingId !== null,
			execute() {
				const editor = editingId === null ? null : editorElement(editingId);
				if (editor === null) {
					return;
				}
				const text = inlineMirrorInsertion(editor.textContent.slice(0, caretTextOffset(editor)));
				const selection = globalThis.getSelection();
				if (selection === null || selection.rangeCount === 0) {
					return;
				}
				const range = selection.getRangeAt(0);
				range.deleteContents();
				const inserted = document.createTextNode(text);
				range.insertNode(inserted);
				selection.collapse(inserted, text.length);
				// The input event arms the `((` popup like typed characters.
				editor.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: text}));
			},
		},
		insert_inline_link: {
			available: () => editingId !== null,
			execute() {
				const editor = editingId === null ? null : editorElement(editingId);
				if (editor === null) {
					return;
				}
				const caret = caretTextOffset(editor);
				const before = editor.textContent.slice(0, caret);
				const text = planInsertInlineLink(before, before.length).text.slice(before.length);
				const selection = globalThis.getSelection();
				if (selection === null || selection.rangeCount === 0) {
					return;
				}
				const range = selection.getRangeAt(0);
				range.deleteContents();
				const inserted = document.createTextNode(text);
				range.insertNode(inserted);
				selection.collapse(inserted, text.length);
				// The input event closes the pair with "]]" and opens the popup, like typed characters.
				editor.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: "["}));
			},
		},
		complete: {
			available: (ctx) => !ctx.items.some((id) => isCompleteBlocked(id)),
			execute: complete,
		},
		duplicate: {
			execute(ctx) {
				const cell = tableCellOf(ctx);
				if (cell !== null) {
					flushEditing();
					void duplicateColumn(tableDeps(), cell);
					return;
				}
				if (hasItemSelection()) {
					void runInUndoBatch(captureOutlineView, () => {
						for (const id of ctx.items) {
							const selected = readNode(queryClient, id);
							if (selected !== undefined) {
								createNodeMutation.mutate(planDuplicate(queryClient, selected));
							}
						}
					});
					return;
				}
				const node = itemNode(ctx);
				if (node === undefined) {
					return;
				}
				// Copy the unsaved text too
				const editor = editorElement(node.id);
				const name = editor === null ? node.name : serializeEditorHtml(editor.innerHTML);
				flushEditing();
				void runInUndoBatch(captureOutlineView, () => {
					commitEdit();
					createNodeMutation.mutate(planDuplicate(queryClient, {...node, name}), {
						onSuccess(createdNode) {
							resumeEditing(createdNode.id, Number.MAX_SAFE_INTEGER);
						},
					});
				});
			},
		},
		delete: {
			execute(ctx) {
				const cell = tableCellOf(ctx);
				if (cell !== null) {
					flushEditing();
					void cellDelete(tableDeps(), cell, []);
					return;
				}
				if (hasItemSelection()) {
					deleteSelectedItems(queryClient, ctx.items, deleteNodeMutation.mutate, navigate);
					return;
				}
				const [nodeId] = ctx.items;
				if (nodeId !== undefined) {
					flushEditing();
					void runInUndoBatch(captureOutlineView, () => {
						editBesideRemovedNode(nodeId);
						deleteNodeMutation.mutate(nodeId);
					});
				}
			},
		},
		toggle_h1: layoutCommand("toggle_h1"),
		toggle_h2: layoutCommand("toggle_h2"),
		toggle_h3: layoutCommand("toggle_h3"),
		toggle_paragraph: layoutCommand("toggle_paragraph"),
		toggle_code_block: layoutCommand("toggle_code_block"),
		toggle_quote_block: layoutCommand("toggle_quote_block"),
		toggle_bullet: layoutCommand("toggle_bullet"),
		toggle_todo: layoutCommand("toggle_todo"),
		// The selection menu's row: shown only while some selected item can take the to-do layout.
		toggle_todo_mode: {
			available: (ctx) => todoModeAvailable(ctx.items.flatMap((id) => readNode(queryClient, id) ?? [])),
			execute(ctx) {
				toggleLayout(ctx, "toggle_todo");
			},
		},
		toggle_numbered: layoutCommand("toggle_numbered"),
		toggle_divider: layoutCommand("toggle_divider"),
		toggle_board: boardOrTableCommand("toggle_board"),
		insert_board_column_left: insertColumnCommand("left"),
		insert_board_column_right: insertColumnCommand("right"),
		toggle_table: boardOrTableCommand("toggle_table"),
		// Upstream: "Add note" from inside the note moves the caret to the end of the name.
		add_note: singleItemCommand((nodeId) => {
			const {editingNoteId, focusName, focusNote} = useOutlineStore.getState();
			if (editingNoteId === nodeId) {
				focusName(nodeId, "end");
			} else if (canHaveNote(readNode(queryClient, nodeId)?.data.layoutMode)) {
				focusNote(nodeId);
			}
		}),
		add_date: {
			available: (ctx) => ctx.items.length === 1,
			execute(ctx) {
				const [nodeId] = ctx.items;
				if (nodeId !== undefined) {
					useOutlineStore.getState().requestDatePicker(nodeId, ctx.anchorRect);
				}
			},
		},
		delete_dates: {
			available: (ctx) =>
				ctx.items.length > 0 && ctx.items.every((id) => readNode(queryClient, id)?.readOnly !== true),
			execute: (ctx) => {
				editSelectionFields(ctx, (fields) => {
					const byId = new Map<string, {id: string; name: string; note: string}>();
					for (const {id, field, html} of fields) {
						const node = byId.get(id) ?? {id, name: "", note: ""};
						node[field] = html;
						byId.set(id, node);
					}
					return planDeleteDates([...byId.values()]).flatMap(({id, name, note}) => [
						...(name === undefined ? [] : [{id, field: "name" as const, html: name}]),
						...(note === undefined ? [] : [{id, field: "note" as const, html: note}]),
					]);
				});
			},
		},
		open_in_pane: singleItemCommand((nodeId) => {
			openInPane(useOutlineStore.getState(), nodeId);
		}),
		expand_all: singleItemCommand((nodeId) => {
			expandAll(nodeId, true);
		}),
		collapse_all: singleItemCommand((nodeId) => {
			expandAll(nodeId, false);
		}),
		sort_children_asc: singleItemCommand((nodeId) => {
			void sortChildren(nodeId, "asc");
		}),
		sort_children_desc: singleItemCommand((nodeId) => {
			void sortChildren(nodeId, "desc");
		}),
		copy_link: singleItemCommand((nodeId) => {
			void copyLink(nodeId);
		}),
		toggle_leftbar: {execute: toggleLeftBar},
		toggle_rightbar: {execute: toggleRightBar},
		...paneCommands({
			getState: useOutlineStore.getState,
			closeMainPane: () => {
				closeMainPane(navigate);
			},
			movePane: (paneId, index) => {
				movePane(navigate, paneId, index, (id) => cachedResolvedId(queryClient, id) ?? id);
			},
		}),
		...paneNumberCommands({
			getState: useOutlineStore.getState,
			focusPane: (paneId, caret) => {
				commitEdit();
				useOutlineStore.getState().setActivePane(paneId);
				if (caret === "first_child") {
					focusEdge("first", true);
					return;
				}
				const state = useOutlineStore.getState();
				const zoomedId = paneId === MAIN_PANE_ID ? null : (findPane(state.panes, paneId)?.zoomedId ?? null);
				requestPaneFocus({paneId, zoomedId, reveal: true}, {resumeEditing: state.resumeEditing});
			},
			zoomPaneTo: (paneId, nodeId) => {
				commitEdit();
				const state = useOutlineStore.getState();
				state.setActivePane(paneId);
				if (paneId === MAIN_PANE_ID) {
					goToNode(navigate, nodeId);
					requestPaneFocus({paneId, zoomedId: nodeId, reveal: true}, {resumeEditing: state.resumeEditing});
				} else {
					// The store's pane focus request moves the caret to the new title.
					state.zoomPane(paneId, nodeId);
				}
			},
		}),
		...paneNavCommands({
			getState: useOutlineStore.getState,
			commitEdit,
			goHome: () => {
				void navigate("/");
			},
			stepMain: (direction) => {
				stepNav(navigate, direction, (id) => cachedResolvedId(queryClient, id));
			},
			navigateToToday: async (paneId) => (paneId === null ? navigateToToday() : navigateActivePaneToToday()),
			jumpToSibling,
		}),
		// The open search panel stands in for upstream's search-in-progress until search-filtering SF3
		show_or_hide_completed: showCompletedCommand(
			toggleShowCompleted,
			() => useOutlineStore.getState().searchQuery !== "",
		),
		star_current_item: starCurrentItemCommand(toggleStar, () => activeCommittedQuery(useOutlineStore.getState())),
		show_switcher: {execute: showSwitcher},
		/** Upstream "Changelog: Show": the What's New dialog. */
		show_changelog: {
			execute() {
				useOutlineStore.getState().openChangelog();
			},
		},
		_select_next_in_switcher: switcherStepCommand("next", isJumpMenuOpen, openJumpMenu),
		_select_prev_in_switcher: switcherStepCommand("prev", isJumpMenuOpen, openJumpMenu),
		show_export: {
			execute(ctx) {
				if (ctx.items.length > 0) {
					commitEdit();
					openExportDialog(selectionExportRequest(ctx.items));
					useOutlineStore.getState().clearItemSelection();
				}
			},
		},
		...customizeCommands,
	};
}
