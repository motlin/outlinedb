import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {
	activePaneView,
	isModalOpen,
	outlineActions,
	registerEditFlush,
	shouldCommitOnBlur,
	useOutlineStore,
} from "../stores/outline.js";
import {rowEnterRole} from "../board.js";
import {cachedCanRender} from "../layouts-cache.js";
import {cellBackspace, cellEnter} from "../table-actions.js";
import {locateCell} from "../table-cache.js";
import {planCellKey} from "../table.js";
import {makeTableDeps} from "../hooks/use-table-actions.js";
import {
	applySplitPlan,
	indentChildrenToLoad,
	isEmptyForReturn,
	planBackspaceAtStart,
	planDeleteAtEnd,
	planOutdent,
	planSplit,
	rowShapeLayout,
} from "../tree-ops.js";
import type {MergeRow} from "../tree-ops.js";
import {planBlockPrefix, prefixedName} from "../block-prefix.js";
import {sortByPriority} from "../tree-position.js";
import type {NodeResponse} from "../../node-types.js";
import {
	backspaceDeleteTarget,
	horizontalTarget,
	isCaretOnBoundaryLine,
	navigableIds,
	planNoteBoundary,
	planVerticalCross,
} from "../caret-navigation.js";
import type {HorizontalDirection, VerticalDirection} from "../caret-navigation.js";
import {
	caretTextOffset,
	placeCaretAtTextOffset,
	placeSelectionAtTextOffsets,
	selectionTextOffsets,
	textUnitLength,
} from "../caret-dom.js";
import {openLinkAtCaret} from "../content-link-click.js";
import {toolbarLinkTarget} from "../link-popup-open.js";
import {classifyEditorKey, classifyFormatKey, isHighlightKey, isMacPlatform} from "../editable-text-keys.js";
import type {EditorKeyAction} from "../editable-text-keys.js";
import {nodeKeys, patchCachedNode, readChildren, readDetail, readNode} from "../node-cache.js";
import {collectVisibleNodeIds} from "../hooks/use-visible-nodes.js";
import {currentSelectionView, freshSelection, scrollRowIntoView} from "../hooks/use-selection-keymap.js";
import {editorSelectAllTakesOver, editorShiftArrowTakesOver} from "../item-selection.js";
import {
	fetchChildren,
	toggleComplete,
	useCreateNode,
	useDeleteNode,
	useMoveNode,
	useUpdateNode,
} from "../hooks/use-nodes.js";
import {useLatest} from "../hooks/use-latest.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {createEditDebouncer, TEXT_SAVE_DEBOUNCE_MS} from "../edit-debouncer.js";
import type {TagColors} from "../hooks/use-tag-colors.js";
import {TagColorPicker} from "./tag-color-picker.js";
import {FaIcon} from "./fa-icons.js";
import {prefetchPickerMonths} from "../hooks/use-calendar-event-days.js";
import {applyDatePhrase, planDateInsertion, planPillReplacement, replacePill} from "../date-pills.js";
import {deleteAdjacentPill as deleteAdjacentPillInEditor} from "../pill-delete.js";
import {
	isComposingInput,
	renderCodeBlockHtml,
	renderEditorHtml,
	retagEditor,
	serializeEditorHtml,
} from "../editor-html.js";
import {formatPillLabel} from "@workflowy/shared";
import type {TimeAttrs} from "@workflowy/shared";
import {useBangDatePicker} from "./bang-date-picker.js";
import {useDateAutocomplete} from "./date-autocomplete.js";
import {routeTypedInput} from "../inline-input-router.js";
import {plainText, splitHtml} from "../rich-text.js";
import {lineSplitRequests} from "../line-split.js";
import {canHaveNote, normalizeLayoutMode} from "../layout-types.js";
import {applyInlineCodeInput} from "../inline-code-edit.js";
import {useColorPopup} from "../hooks/use-color-popup.js";
import {useInlineFormat} from "../hooks/use-inline-format.js";
import {useLatestColorClass} from "../latest-color.js";
import {useNamePaste} from "../hooks/use-name-paste.js";
import {
	toolbarFormatAttr,
	toolbarLayoutCommand,
	toolbarRefreshKey,
	useSelectionToolbar,
} from "../hooks/use-selection-toolbar.js";
import {planLayoutHotkey} from "../layout-hotkeys.js";
import type {LayoutHotkeyCommand} from "../layout-hotkeys.js";
import {SelectionToolbar} from "./selection-toolbar.js";
import type {SelectionToolbarAction} from "./selection-toolbar.js";
import {useTagPointer} from "../hooks/use-tag-pointer.js";
import {usePaneSearchQuery} from "../hooks/use-tree-search.js";
import {useTagAutocomplete} from "../hooks/use-tag-autocomplete.js";
import type {TagAcceptHandler} from "../hooks/use-tag-autocomplete.js";
import {spliceAcceptedTag} from "../tag-autocomplete.js";
import {clickedPill, offsetAfterPill, usePillDatePicker} from "./pill-date-picker.js";
import {highlightSearchMatches} from "../highlight-html.js";
import {useAccount} from "../hooks/use-account.js";
import {useDateSettings, useSlashDiscovered} from "../hooks/use-preferences.js";
import {renderLinks} from "../link-render.js";
import type {TagColorName} from "./tag-color-picker.js";
import {useMentionMenu} from "../hooks/use-mention-menu.js";
import {stripMirrorChip, useMirrorMenu} from "../hooks/use-mirror-menu.js";
import {useInlineMirrorPick} from "../hooks/use-inline-mirror-pick.js";
import {useInlineLinkPopup} from "../hooks/use-inline-link-popup.js";
import {useSlashMenu} from "../hooks/use-slash-menu.js";
import {stripMentionChip} from "../mention-trigger.js";
import {placeholderFor, stripSlashChip} from "../slash-trigger.js";
import {dashboardsOn, isDashboard} from "../dashboard.js";
import {focusCenters, focusKeepsScroll, focusScrolls} from "../quiet-focus.js";
import {scrollToCenter} from "../scroll-reveal.js";

/**
 * The caret's client rect at the edge of the current selection that the arrow key
 * moves from, or null when it cannot be measured (e.g. a caret in an empty node).
 */
function caretRect(direction: VerticalDirection): DOMRect | null {
	const selection = globalThis.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return null;
	}
	const range = selection.getRangeAt(0).cloneRange();
	range.collapse(direction === "up");
	const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
	return rect.height > 0 ? rect : null;
}

/** Stands in for a date pill, one caret unit, in the plain text the tag autocomplete reads. */
const PILL_UNIT = "\uFFFC";

interface EditableTextProps {
	nodeId: string;
	initialValue: string;
	parentId: string | null;
	priority: number;
	isEditing: boolean;
	clickPosition?: {x: number; y: number};
	/** The row's layout mode: a code block shows its name as plain text. */
	layoutMode?: string | null | undefined;
}

/** Caret actions named the way `planNoteBoundary` takes them. */
const CARET_ARROWS: Readonly<Partial<Record<EditorKeyAction, "Up" | "Down" | "Left" | "Right">>> = {
	CARET_UP: "Up",
	CARET_DOWN: "Down",
	CARET_LEFT: "Left",
	CARET_RIGHT: "Right",
};

/**
 * Inline editable text component using contenteditable.
 * - Supports HTML formatting (bold, italic preserved from node content)
 * - Saves after each 500ms pause in typing (one undo step per pause), and on blur
 * - Enter splits the row at the selection (or outdents an empty last row); see `planSplit`
 * - Shift+Enter commits the text and focuses the row's note (creating it) with the caret at its end
 * - Backspace in an empty, childless, note-less node deletes it and edits the previous node
 * - Backspace at the start merges the previous sibling's text in; Delete at the end
 *   merges this row's text into the next sibling (plain leaf siblings only)
 * - Down/Right leaving the end of the noted zoom title enter the root note at its start;
 *   Up/Left leaving the start of the first child's name enter it at its end
 * - Escape commits the text and opens search; dismissing search resumes editing here
 */

function EditingText({
	nodeId,
	initialValue,
	parentId,
	priority,
	isEditing,
	clickPosition,
	layoutMode,
}: EditableTextProps) {
	const contentRef = useRef<HTMLSpanElement>(null);
	const queryClient = useQueryClient();
	const {
		stopEditing,
		resumeEditing,
		focusNote,
		releaseEditing,
		setItemSelection,
		holdEditing,
		openSettings,
		openLinkPopup,
	} = outlineActions();
	const updateNodeMutation = useUpdateNode();
	const createNodeMutation = useCreateNode();
	const deleteNodeMutation = useDeleteNode();
	const moveNodeMutation = useMoveNode();
	const dateSettings = useDateSettings();
	const account = useAccount();
	const codeBlock = normalizeLayoutMode(layoutMode) === "code-block";
	// A code block shows its name as plain text: no tags, mentions, links or date pills.
	const renderName = useCallback(
		(html: string) => (codeBlock ? renderCodeBlockHtml(html) : renderEditorHtml(html, dateSettings, account)),
		[codeBlock, dateSettings, account],
	);

	// The HTML as of editing start, held while editing so saves and refetches never rewrite the DOM under the caret.
	const [editingHtml, setEditingHtml] = useState<string | null>(null);
	if (isEditing && editingHtml === null) {
		const override = outlineActions().editingHtmlOverride;
		setEditingHtml(override?.id === nodeId ? override.html : initialValue);
	} else if (!isEditing && editingHtml !== null) {
		setEditingHtml(null);
	}
	const storedEditorHtml = editingHtml ?? initialValue;
	// The override has served this editor; a later editing session must start from the stored name again.
	useEffect(() => {
		if (editingHtml !== null && outlineActions().editingHtmlOverride?.id === nodeId) {
			useOutlineStore.setState({editingHtmlOverride: null});
		}
	}, [editingHtml, nodeId]);
	// Pills are atomic in edit mode too; every save path serializes them back to stored `<time>` markup.
	const editorHtml = useMemo(() => renderName(storedEditorHtml), [storedEditorHtml, renderName]);
	// The saver's baseline is the name as the editor would store it, so auto-links the editor shows (and stores on the
	// next edit) do not make an untouched row look changed.
	const latestRenderName = useLatest(renderName);

	// Saves the name after each 500ms pause in typing (upstream `saveLater`): one undo step per pause.
	// One saver per node, so a pending save flushed after a node change still targets its own node.
	// The latest mutate, so the saver (and the editing-start effect that resets it) never depend on its identity.
	const updateNode = useLatest(updateNodeMutation.mutate);
	const nameSaver = useMemo(
		() =>
			createEditDebouncer({
				delay: TEXT_SAVE_DEBOUNCE_MS,
				save: ({after}) => {
					updateNode.current({nodeId, name: after});
				},
			}),
		[nodeId, updateNode],
	);

	// Focus and position cursor when entering edit mode
	useEffect(() => {
		if (isEditing && contentRef.current) {
			prefetchPickerMonths(queryClient);
			const centers = focusCenters(nodeId);
			contentRef.current.focus({
				preventScroll:
					!focusScrolls(nodeId) ||
					centers ||
					focusKeepsScroll(contentRef.current.getBoundingClientRect(), window.innerHeight),
			});
			if (centers) {
				scrollToCenter(contentRef.current);
			}
			nameSaver.reset(serializeEditorHtml(latestRenderName.current(storedEditorHtml)));

			const {editingId, editingCaretOffset, editingCaretEnd, editingCaretReversed} = useOutlineStore.getState();
			if (editingId === nodeId && editingCaretOffset !== null) {
				placeSelectionAtTextOffsets(
					contentRef.current,
					editingCaretOffset,
					editingCaretEnd ?? editingCaretOffset,
					editingCaretReversed,
				);
				return;
			}

			// If we have a click position, use caretPositionFromPoint to place the cursor there
			if (clickPosition && "caretPositionFromPoint" in document) {
				const position = document.caretPositionFromPoint(clickPosition.x, clickPosition.y);
				if (position && contentRef.current.contains(position.offsetNode)) {
					const range = document.createRange();
					range.setStart(position.offsetNode, position.offset);
					range.collapse(true);
					const selection = globalThis.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
					return;
				}
			}

			// Fallback: select all content (for keyboard navigation or when click position unavailable)
			const range = document.createRange();
			range.selectNodeContents(contentRef.current);
			const selection = globalThis.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
	}, [isEditing, storedEditorHtml, clickPosition, nodeId, nameSaver, queryClient, latestRenderName]);

	/** Save the edited text if it changed, keeping the caret (⌘S); returns false with no editor. */
	const saveInPlace = useCallback((): boolean => {
		if (!contentRef.current) {
			return false;
		}

		nameSaver.saveNow(
			stripMirrorChip(stripMentionChip(stripSlashChip(serializeEditorHtml(contentRef.current.innerHTML)))),
		);
		return true;
	}, [nameSaver]);

	useEffect(() => {
		const unregister = isEditing
			? registerEditFlush(() => {
					saveInPlace();
				})
			: undefined;
		return () => {
			unregister?.();
			// Leaving the row without a blur commit (a remount or a structural move) still saves the last pause.
			nameSaver.flush();
		};
	}, [isEditing, saveInPlace, nameSaver]);

	// Tab into a collapsed, never-opened previous sibling must first load its children; load them while the row is
	// edited, so Tab moves at once instead of after a round trip.
	useEffect(() => {
		const target = isEditing
			? indentChildrenToLoad(queryClient, {id: nodeId, parent_id: parentId, priority})
			: null;
		if (target !== null) {
			// A failed load is retried by the Tab that needs it.
			queryClient
				.query({
					queryKey: nodeKeys.children(target),
					queryFn: async () => fetchChildren(target),
					staleTime: "static",
				})
				.catch(() => {});
		}
	}, [isEditing, nodeId, parentId, priority, queryClient]);

	const insertDate = useCallback(
		(attrs: TimeAttrs, offset: number, replaceEnd?: number, addSpaceBefore?: boolean) => {
			const content = contentRef.current;
			if (content) {
				const html = serializeEditorHtml(content.innerHTML);
				const {before, after} =
					replaceEnd === undefined ? {before: html, after: ""} : splitHtml(html, offset, replaceEnd);
				const plan = planDateInsertion(before + after, offset, attrs, {addSpaceBefore});
				content.focus();
				content.innerHTML = renderName(plan.html);
				placeCaretAtTextOffset(content, plan.caretOffset);
				nameSaver.saveNow(plan.html);
			}
			releaseEditing();
		},
		[renderName, nameSaver, releaseEditing],
	);

	const cancelDate = useCallback(
		(offset: number) => {
			const content = contentRef.current;
			if (content) {
				content.focus();
				placeCaretAtTextOffset(content, offset);
			}
			releaseEditing();
		},
		[releaseEditing],
	);

	// `!!` opens the date picker; holding editing keeps the input's focus from committing this edit.
	const datePicker = useBangDatePicker({
		editorRef: contentRef,
		dateSettings,
		onOpen: holdEditing,
		onInsert: insertDate,
		onCancel: cancelDate,
	});
	const {handleInput: handleDateTrigger, openForPhrase, openAtCaret, isOpen: isDatePickerOpen} = datePicker;

	// "Add date" from the item menu focuses this name at its end, then opens the picker there.
	const datePickerRequestId = useOutlineStore((state) => state.datePickerRequest?.id);
	useEffect(() => {
		if (isEditing && datePickerRequestId === nodeId && document.activeElement === contentRef.current) {
			const anchor = useOutlineStore.getState().datePickerAnchor;
			const request = useOutlineStore.getState().takeDatePickerRequest(nodeId);
			if (request !== null) {
				openAtCaret(anchor, request);
			}
		}
	}, [isEditing, datePickerRequestId, nodeId, openAtCaret]);

	// Typing a natural-language date ("tomorrow") offers a flyout; Tab or a click converts it to a pill.
	const dateAutocomplete = useDateAutocomplete({
		editorRef: contentRef,
		dateSettings,
		isBlocked: isDatePickerOpen,
		onApply: (phrase) => {
			const content = contentRef.current;
			if (content) {
				const plan = applyDatePhrase(serializeEditorHtml(content.innerHTML), phrase);
				content.innerHTML = renderName(plan.html);
				placeCaretAtTextOffset(content, plan.caretOffset);
				nameSaver.saveNow(plan.html);
			}
		},
		onOpenPicker: (phrase, position) => {
			openForPhrase({
				offset: phrase.start,
				replaceEnd: phrase.end,
				position,
				term: formatPillLabel(phrase.attrs, {dateFormat: dateSettings.dateFormat}),
				isRange: phrase.attrs.endYear !== undefined,
			});
		},
		onOpenSettings: () => {
			openSettings("Dates");
		},
	});
	const {handleInput: handleDateAutocomplete, hide: hideDateAutocomplete} = dateAutocomplete;

	// A plain click on a pill edits or removes just that pill. At rest it saves the stored name; while editing,
	// holding editing keeps the picker's focus from committing, and the change lands in the live editor.
	const pillCaret = useRef(0);
	const pillPicker = usePillDatePicker({
		dateSettings,
		onChange: (pillIndex, attrs) => {
			const content = contentRef.current;
			if (content === null) {
				updateNodeMutation.mutate({nodeId, name: replacePill(initialValue, pillIndex, attrs)});
				return;
			}
			const plan = planPillReplacement(serializeEditorHtml(content.innerHTML), pillIndex, attrs);
			content.focus();
			content.innerHTML = renderName(plan.html);
			placeCaretAtTextOffset(content, plan.caretOffset);
			nameSaver.saveNow(plan.html);
			releaseEditing();
		},
		onDismiss: () => {
			const content = contentRef.current;
			if (content !== null) {
				content.focus();
				placeCaretAtTextOffset(content, pillCaret.current);
				releaseEditing();
			}
		},
	});
	const {open: openPillPicker} = pillPicker;
	const tagPointer = useTagPointer({
		getHtml: () => (contentRef.current ? serializeEditorHtml(contentRef.current.innerHTML) : ""),
		save: (html, caret) => {
			const content = contentRef.current;
			if (content) {
				content.innerHTML = renderName(html);
				placeCaretAtTextOffset(content, caret);
				nameSaver.saveNow(html);
			}
		},
	});
	const handleEditingClick = useCallback(
		(event: React.MouseEvent<HTMLSpanElement>) => {
			if (tagPointer.onClick(event)) {
				return;
			}
			const clicked = clickedPill(event, event.currentTarget);
			if (clicked === null) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			pillCaret.current = offsetAfterPill(event.currentTarget, clicked.pill);
			holdEditing(pillCaret.current);
			openPillPicker(clicked.pill, clicked.index);
		},
		[holdEditing, openPillPicker, tagPointer],
	);

	// Typing a #tag offers the zoom subtree's matching tags; Tab, Enter or a click accepts one.
	const readNamePlain = useCallback(
		() => (contentRef.current ? plainText(serializeEditorHtml(contentRef.current.innerHTML), PILL_UNIT) : ""),
		[],
	);
	const acceptTag = useCallback<TagAcceptHandler>(
		(edit) => {
			const content = contentRef.current;
			if (content) {
				const html = spliceAcceptedTag(serializeEditorHtml(content.innerHTML), edit);
				content.innerHTML = renderName(html);
				placeCaretAtTextOffset(content, edit.caret);
				nameSaver.saveNow(html);
			}
		},
		[renderName, nameSaver],
	);
	const tagAutocomplete = useTagAutocomplete({
		editorRef: contentRef,
		nodeId,
		field: "name",
		readPlain: readNamePlain,
		onAccept: acceptTag,
	});
	const {
		handleInput: handleTagAutocomplete,
		handleKeyDown: handleTagAutocompleteKey,
		detach: detachTagAutocomplete,
	} = tagAutocomplete;

	// ⌘B/⌘I/⌘U/⇧⌘X/⇧⌘C toggle the selection's format, or make it pending for the next typed character.
	const readNameHtml = useCallback(() => serializeEditorHtml(contentRef.current?.innerHTML ?? ""), []);
	const {applyInlineToggle, applyLatestColor, applyColorToggle} = useInlineFormat({
		editorRef: contentRef,
		active: isEditing,
		read: readNameHtml,
		render: (html) => renderName(html),
		onChange: (html) => {
			nameSaver.change(html);
		},
	});

	// Upstream's floating format toolbar over a stretched selection in the edited name.
	const {
		view: toolbarView,
		refresh: refreshToolbar,
		hide: hideToolbar,
	} = useSelectionToolbar({
		editorRef: contentRef,
		active: isEditing,
		read: readNameHtml,
		modalOpen: isModalOpen,
	});
	const lastColorClass = useLatestColorClass();
	const {
		popup: colorPopup,
		openPalette,
		applyLatestOrOpen,
	} = useColorPopup({
		editorRef: contentRef,
		read: readNameHtml,
		applyColorToggle,
		applyLatestColor,
		hideToolbar,
		refreshToolbar,
	});

	// An h1-p toggle re-renders the row at a new text size: re-measure the bar once that has landed.
	const rowLayoutMode = readNode(queryClient, nodeId)?.data.layoutMode;
	const refreshKey = toolbarRefreshKey(rowLayoutMode);
	const seenRefreshKey = useRef(refreshKey);
	useLayoutEffect(() => {
		if (seenRefreshKey.current !== refreshKey) {
			seenRefreshKey.current = refreshKey;
			refreshToolbar();
		}
	}, [refreshKey, refreshToolbar]);

	/** A toolbar type button: commit the text, then toggle this row's layout in one undo step, keeping the selection. */
	const toggleLayoutFromToolbar = useCallback(
		(command: LayoutHotkeyCommand) => {
			const content = contentRef.current;
			const node = readNode(queryClient, nodeId);
			if (!content || node === undefined) {
				return;
			}
			const name = serializeEditorHtml(content.innerHTML);
			const sel = selectionTextOffsets(content);
			nameSaver.saveNow(name);
			const plan = planLayoutHotkey(command, [node], {nodeId, name});
			const renamed = plan.updates.find((update) => update.nodeId === nodeId)?.name;
			if (renamed !== undefined && renamed !== name) {
				nameSaver.reset(renamed);
				content.innerHTML = renderName(renamed);
				const length = textUnitLength(content);
				placeSelectionAtTextOffsets(content, Math.min(sel.start, length), Math.min(sel.end, length));
			}
			void runInUndoBatch(captureOutlineView, () => {
				for (const update of plan.updates) {
					updateNodeMutation.mutate(update);
				}
				for (const deleteId of plan.deletes) {
					deleteNodeMutation.mutate(deleteId);
				}
				for (const request of lineSplitRequests(queryClient, plan.creates)) {
					createNodeMutation.mutate(request);
				}
			});
		},
		[renderName, createNodeMutation, deleteNodeMutation, nameSaver, nodeId, queryClient, updateNodeMutation],
	);

	const handleToolbarAction = useCallback(
		(action: SelectionToolbarAction) => {
			const attr = toolbarFormatAttr(action);
			const layout = toolbarLayoutCommand(action);
			if (attr !== null) {
				applyInlineToggle(attr);
			} else if (layout !== null) {
				toggleLayoutFromToolbar(layout);
			} else if (action === "link") {
				const target = toolbarLinkTarget(nodeId);
				if (target !== null) {
					openLinkPopup(target);
				}
			} else if (action === "latest-color") {
				applyLatestOrOpen();
			} else if (action === "show-palette") {
				openPalette();
			}
		},
		[applyInlineToggle, applyLatestOrOpen, nodeId, openLinkPopup, openPalette, toggleLayoutFromToolbar],
	);

	// Typing a first or standalone "/" opens the slash command menu under a chip; it never schedules a save while open.
	const changeName = useCallback(() => {
		if (contentRef.current) {
			nameSaver.change(
				stripMirrorChip(stripMentionChip(stripSlashChip(serializeEditorHtml(contentRef.current.innerHTML)))),
			);
		}
	}, [nameSaver]);
	const saveName = useCallback(() => {
		saveInPlace();
	}, [saveInPlace]);
	const slashMenu = useSlashMenu({editorRef: contentRef, nodeId, onChange: changeName, onSave: saveName});
	const slashDiscovered = useSlashDiscovered();
	// Typing a spaced "@" opens the mention popup (people and @tags) under a chip, like the slash menu.
	const acceptMention = useCallback(() => {
		const content = contentRef.current;
		if (content !== null) {
			retagEditor(content, renderName(serializeEditorHtml(content.innerHTML)));
		}
		saveInPlace();
	}, [renderName, saveInPlace]);
	const mentionMenu = useMentionMenu({editorRef: contentRef, onChange: changeName, onAccept: acceptMention});
	const {
		handleInput: handleMentionInput,
		handleKeyDown: handleMentionKey,
		detach: detachMentionMenu,
		isOpen: isMentionMenuOpen,
	} = mentionMenu;
	// Typing "((" opens the mirror popup; choosing a location puts a mirror where the "((...))" was.
	const resetSavedName = useCallback(
		(name: string) => {
			nameSaver.reset(name);
		},
		[nameSaver],
	);
	const acceptMirrorPick = useInlineMirrorPick({nodeId, parentId, contentRef, resetSaved: resetSavedName});
	const mirrorMenu = useMirrorMenu({editorRef: contentRef, onChange: changeName, onPick: acceptMirrorPick});
	const {
		handleInput: handleMirrorInput,
		handleKeyDown: handleMirrorKey,
		detach: detachMirrorMenu,
		isOpen: isMirrorMenuOpen,
	} = mirrorMenu;
	// Typing "[[" closes it with "]]" and, while the caret is inside, offers items to link to.
	const applyLink = useCallback(
		(html: string, caret: number) => {
			const content = contentRef.current;
			if (content === null) {
				return;
			}
			content.innerHTML = renderName(html);
			placeCaretAtTextOffset(content, caret);
			void runInUndoBatch(captureOutlineView, () => {
				saveInPlace();
			});
		},
		[renderName, saveInPlace],
	);
	const linkPopup = useInlineLinkPopup({nodeId, contentRef, dateSettings, account, applyLink});
	const {handleInput: handleLinkInput, handleKeyDown: handleLinkKey, handleBlur: handleLinkBlur} = linkPopup;
	const {
		handleInput: handleSlashInput,
		handleKeyDown: handleSlashKey,
		detach: detachSlashMenu,
		isOpen: isSlashMenuOpen,
	} = slashMenu;

	const handlePaste = useNamePaste({
		nodeId,
		parentId,
		contentRef,
		dateSettings,
		account,
		resetSaved: (name) => {
			nameSaver.reset(name);
		},
		changed: changeName,
	});

	/**
	 * Upstream's markdown-style block prefixes: a prefix typed at the very start of the name (`[] `, `# `, `> `, ...)
	 * turns the row into that block type. The strip, the type change, the completion and a divider's creation are one
	 * undo step. Returns true when the input was handled.
	 */
	const applyBlockPrefix = useCallback(
		(content: HTMLElement): boolean => {
			const node = readNode(queryClient, nodeId);
			const html = serializeEditorHtml(content.innerHTML);
			const text = plainText(html, PILL_UNIT);
			const offset = caretTextOffset(content);
			const currentLayoutMode = node?.data.layoutMode ?? null;
			const plan = planBlockPrefix({
				before: text.slice(0, offset),
				after: text.slice(offset),
				layoutMode: currentLayoutMode,
			});
			if (plan === null) {
				return false;
			}
			const name = prefixedName(html, plan, PILL_UNIT);
			content.innerHTML = renderName(name);
			nameSaver.reset(name);
			placeCaretAtTextOffset(content, 0);
			holdEditing(0);
			const slot = sortByPriority(readChildren(queryClient, parentId) ?? []).findIndex(
				(sibling) => sibling.id === nodeId,
			);
			void runInUndoBatch(captureOutlineView, () => {
				updateNodeMutation.mutate(
					{
						nodeId,
						name,
						...(plan.kind === "divider-above" ? {} : {layoutMode: plan.layoutMode}),
						...(plan.kind === "clear" && plan.layoutMode === "divider" && (node?.note ?? "") !== ""
							? {note: ""}
							: {}),
						...(plan.numberedStart === undefined ? {} : {numberedStart: plan.numberedStart}),
					},
					{onSettled: releaseEditing},
				);
				if (plan.complete && node?.completedAt === null) {
					toggleComplete(queryClient, {nodeId, isCurrentlyCompleted: false});
				}
				if (plan.kind === "divider-above") {
					createNodeMutation.mutate({
						parent_id: parentId ?? undefined,
						index: Math.max(slot, 0),
						name: "",
						layoutMode: "divider",
					});
				}
			});
			return true;
		},
		[
			createNodeMutation,
			renderName,
			holdEditing,
			nameSaver,
			nodeId,
			parentId,
			queryClient,
			releaseEditing,
			updateNodeMutation,
		],
	);

	const handleInput = useCallback(
		(event: React.SyntheticEvent<HTMLSpanElement>) => {
			const content = contentRef.current;
			if (
				content !== null &&
				!isComposingInput(event.nativeEvent) &&
				!isSlashMenuOpen() &&
				!isMentionMenuOpen() &&
				!isMirrorMenuOpen() &&
				applyBlockPrefix(content)
			) {
				return;
			}
			// Upstream's `code-block.disable-inline-popups`: a code block is plain text, so no tag, mention, date, slash or
			// inline-code rule runs in it.
			if (codeBlock) {
				changeName();
				return;
			}
			// Upstream's inline-code input rule: a closing backtick or a double space typed at the end of code.
			if (
				content !== null &&
				applyInlineCodeInput(content, event.nativeEvent, {
					read: readNameHtml,
					render: (html) => renderName(html),
				}) !== null
			) {
				changeName();
				return;
			}
			// The mention chip is handled first: a chip that is still armed keeps its text out of the tag re-render.
			const mention = isSlashMenuOpen()
				? {armedBefore: false, armedAfter: false}
				: handleMentionInput(event.nativeEvent);
			if (content !== null && !mention.armedAfter && !isComposingInput(event.nativeEvent)) {
				retagEditor(content, renderName(serializeEditorHtml(content.innerHTML)));
			}
			// Upstream's typed-input pipe: an armed chip swallows the input, including the one that disarms it.
			const slash =
				mention.armedBefore || mention.armedAfter
					? {armedBefore: false, armedAfter: false}
					: handleSlashInput(event.nativeEvent);
			const mirror =
				mention.armedBefore || mention.armedAfter || slash.armedBefore || slash.armedAfter
					? {armedBefore: false, armedAfter: false}
					: handleMirrorInput(event.nativeEvent);
			handleLinkInput(event.nativeEvent);
			const armedBefore = mention.armedBefore || slash.armedBefore || mirror.armedBefore;
			const armedAfter = mention.armedAfter || slash.armedAfter || mirror.armedAfter;
			const chipRoute = routeTypedInput({
				chipArmedBefore: armedBefore,
				chipArmedAfter: armedAfter,
				datePopupOpened: false,
			});
			let datePopupOpened = false;
			if (chipRoute.dateTrigger) {
				const wasOpen = isDatePickerOpen();
				handleDateTrigger(event.nativeEvent);
				datePopupOpened = !wasOpen && isDatePickerOpen();
			}
			const route = routeTypedInput({chipArmedBefore: armedBefore, chipArmedAfter: armedAfter, datePopupOpened});
			if (route.dateAutocomplete) {
				handleDateAutocomplete();
			}
			if (route.detachTags) {
				detachTagAutocomplete();
			}
			if (route.tagAutocomplete) {
				handleTagAutocomplete();
			}
			if (route.save) {
				changeName();
			}
		},
		[
			applyBlockPrefix,
			changeName,
			codeBlock,
			readNameHtml,
			renderName,
			handleLinkInput,
			handleSlashInput,
			handleMentionInput,
			handleMirrorInput,
			isSlashMenuOpen,
			isMentionMenuOpen,
			isMirrorMenuOpen,
			isDatePickerOpen,
			handleDateTrigger,
			handleDateAutocomplete,
			handleTagAutocomplete,
			detachTagAutocomplete,
		],
	);

	const saveChanges = useCallback(() => {
		if (!saveInPlace()) {
			return;
		}

		// A vertical move may already have handed editing to another node.
		if (useOutlineStore.getState().editingId === nodeId) {
			stopEditing();
		}
	}, [nodeId, saveInPlace, stopEditing]);

	/**
	 * Up on the first line / Down on the last line: commit this edit and start
	 * editing the neighboring visible node, keeping the caret's horizontal position.
	 * Returns false when the caret should move within this node's text instead.
	 */
	const moveToAdjacentNode = useCallback(
		(direction: VerticalDirection): boolean => {
			const content = contentRef.current;
			if (!content) {
				return false;
			}
			const caret = caretRect(direction);
			if (!isCaretOnBoundaryLine(direction, caret, content.getBoundingClientRect())) {
				return false;
			}
			const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
			const visibleIds = navigableIds(
				zoomedNodeId,
				collectVisibleNodeIds(queryClient, zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds),
			);
			const plan = planVerticalCross(visibleIds, nodeId, direction);
			if (plan.kind === "move") {
				saveChanges();
				resumeEditing(plan.nodeId, plan.caretOffset);
			}
			return plan.kind !== "native";
		},
		[nodeId, queryClient, resumeEditing, saveChanges],
	);

	/**
	 * Left at the text start / Right at the text end of a collapsed caret: commit this
	 * edit and continue at the end of the previous / start of the next visible node.
	 * Returns false when the caret should move natively (mid-text, a selection, or no
	 * neighbor in that direction).
	 */
	const crossRowHorizontally = useCallback(
		(direction: HorizontalDirection): boolean => {
			const content = contentRef.current;
			if (!content || globalThis.getSelection()?.isCollapsed !== true) {
				return false;
			}
			const edgeOffset = direction === "left" ? 0 : textUnitLength(content);
			if (caretTextOffset(content) !== edgeOffset) {
				return false;
			}
			const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
			const visibleIds = navigableIds(
				zoomedNodeId,
				collectVisibleNodeIds(queryClient, zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds),
			);
			const target = horizontalTarget(visibleIds, nodeId, direction);
			if (target === null) {
				return false;
			}
			saveChanges();
			resumeEditing(target.nodeId, target.caretOffset);
			return true;
		},
		[nodeId, queryClient, resumeEditing, saveChanges],
	);

	/**
	 * Arrow keys between the zoom title or first child's name and the zoom root's note.
	 * The leading edge is the first/last line for Up/Down and the text start/end for
	 * Left/Right. Returns false when the key should move the caret elsewhere.
	 */
	const enterRootNote = useCallback(
		(key: "Up" | "Down" | "Left" | "Right"): boolean => {
			const content = contentRef.current;
			const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
			if (!content || zoomedNodeId === null || globalThis.getSelection()?.isCollapsed !== true) {
				return false;
			}
			const rootNoted = Boolean(readDetail(queryClient, zoomedNodeId)?.note);
			const forward = key === "Down" || key === "Right";
			const vertical = key === "Up" || key === "Down";
			const direction: VerticalDirection = forward ? "down" : "up";
			const offset = caretTextOffset(content);
			const atEdge = vertical
				? isCaretOnBoundaryLine(direction, caretRect(direction), content.getBoundingClientRect())
				: offset === (forward ? textUnitLength(content) : 0);
			let plan: ReturnType<typeof planNoteBoundary> = null;
			if (nodeId === zoomedNodeId) {
				plan = atEdge ? planNoteBoundary({from: "rootTitleEnd", key, rootNoted}) : null;
			} else {
				const [firstChild] = collectVisibleNodeIds(
					queryClient,
					zoomedNodeId,
					expandedIds,
					showCompleted,
					animatingCompletionIds,
				);
				if (firstChild === nodeId) {
					plan = planNoteBoundary({from: "firstChildName", key, caret: atEdge ? 0 : offset || 1, rootNoted});
				}
			}
			if (plan === null) {
				return false;
			}
			saveChanges();
			focusNote(zoomedNodeId, plan.caret);
			return true;
		},
		[focusNote, nodeId, queryClient, saveChanges],
	);

	/**
	 * Enter (upstream `hK`): outdent an empty last row, else split the text around the
	 * selection into a new row created at its exact slot (one create per Enter), rename
	 * the current row when its text changed, and edit the focused row at its start.
	 */
	const splitAtSelection = useCallback(() => {
		const content = contentRef.current;
		if (!content) {
			return;
		}
		const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
		const visible = new Set(
			collectVisibleNodeIds(queryClient, zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds),
		);
		const allSiblings = sortByPriority(readChildren(queryClient, parentId) ?? []);
		const listed = allSiblings.find((sibling) => sibling.id === nodeId);
		const visibleSiblings = allSiblings.filter((sibling) => sibling.id === nodeId || visible.has(sibling.id));
		const children = readChildren(queryClient, nodeId);
		const grandparent = parentId === null ? undefined : readNode(queryClient, parentId)?.parent_id;
		const html = serializeEditorHtml(content.innerHTML);
		const outdent = planOutdent(queryClient, {id: nodeId, parent_id: parentId, priority}, zoomedNodeId);
		const plan = planSplit({
			node: {
				id: nodeId,
				parent_id: parentId,
				index: Math.max(
					allSiblings.findIndex((sibling) => sibling.id === nodeId),
					0,
				),
				hasVisibleChildren: (children ?? []).some((child) => visible.has(child.id)),
				isExpanded: expandedIds.has(nodeId),
				isZoomRoot: nodeId === zoomedNodeId,
				isEmpty: isEmptyForReturn({
					text: content.textContent,
					layoutMode: listed?.data.layoutMode,
					hasFile: Boolean(listed?.attachment),
					isCalendarContainer: Boolean(listed?.calendar),
					isTableCell:
						grandparent !== null &&
						grandparent !== undefined &&
						readNode(queryClient, grandparent)?.data.layoutMode === "table",
				}),
				hasNextSibling: visibleSiblings.at(-1)?.id !== nodeId,
				canOutdent: outdent !== null,
				layoutMode: listed?.data.layoutMode,
				role: rowEnterRole({
					parentRendersBoard: parentId !== null && cachedCanRender(queryClient, parentId, "board"),
					parentRendersDashboard: parentId !== null && cachedCanRender(queryClient, parentId, "dashboard"),
				}),
			},
			html,
			selection: selectionTextOffsets(content),
			shapeLayout: listed === undefined ? null : rowShapeLayout(queryClient, listed),
		});

		if (plan.kind === "outdent") {
			if (outdent !== null) {
				holdEditing(0);
				moveNodeMutation.mutate(outdent, {onSettled: releaseEditing});
			}
			return;
		}

		if (plan.kind === "newline") {
			// A code or quote block keeps its lines in one row: Enter inserts a newline at the caret.
			const {start, end} = selectionTextOffsets(content);
			const {before, after} = splitHtml(html, start, end);
			content.innerHTML = renderName(`${before}\n${after}`);
			placeCaretAtTextOffset(content, start + 1);
			changeName();
			return;
		}

		// Show the kept text now, so the blur commit and the re-render agree with the plan.
		if (html !== plan.currentName) {
			content.innerHTML = renderName(plan.currentName);
		}
		// The new row carries a client-generated id, so the caret moves into it now,
		// before the create round-trip; writes to it wait for the create (pendingCreates).
		const newId = crypto.randomUUID();
		if (plan.expand !== undefined) {
			activePaneView().replaceExpanded(new Set([...expandedIds, plan.expand]));
		}
		// The rename and the create are one user command: one undo step.
		void runInUndoBatch(captureOutlineView, () => {
			for (const step of applySplitPlan(plan, nodeId, nameSaver.saved)) {
				if (step.type === "update") {
					nameSaver.reset(step.name);
					updateNodeMutation.mutate({nodeId: step.nodeId, name: step.name});
				} else if (step.type === "create") {
					createNodeMutation.mutate({
						id: newId,
						parent_id: step.parent_id ?? undefined,
						index: step.index,
						name: step.name,
						...(step.layoutMode === null ? {} : {layoutMode: step.layoutMode}),
					});
				} else if (step.target === "current") {
					placeCaretAtTextOffset(content, step.caret);
					resumeEditing(nodeId, step.caret);
				} else {
					resumeEditing(newId, step.caret);
				}
			}
		});
	}, [
		nodeId,
		parentId,
		priority,
		queryClient,
		updateNodeMutation,
		createNodeMutation,
		moveNodeMutation,
		holdEditing,
		releaseEditing,
		resumeEditing,
		nameSaver,
		renderName,
		changeName,
	]);

	/**
	 * Backspace in an empty, childless node deletes it and continues editing at the
	 * end of the previous visible node. Returns false when Backspace should edit text.
	 */
	const deleteIfEmpty = useCallback((): boolean => {
		const content = contentRef.current;
		if (!content) {
			return false;
		}
		// Unknown children count as children: never delete a subtree that has not loaded.
		const children = readChildren(queryClient, nodeId);
		const listed = readChildren(queryClient, parentId)?.find((sibling) => sibling.id === nodeId);
		const hasChildren = children ? children.length > 0 : listed?.hasChildren !== false;
		const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
		const visibleIds = navigableIds(
			zoomedNodeId,
			collectVisibleNodeIds(queryClient, zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds),
		);
		const note = readDetail(queryClient, nodeId)?.note ?? listed?.note ?? "";
		const targetId = backspaceDeleteTarget(visibleIds, nodeId, {
			text: content.textContent,
			note,
			hasChildren,
			hasFile: listed?.attachment?.isDeleted === false,
		});
		if (targetId === null) {
			return false;
		}
		// The row is going away: never save its pending text.
		nameSaver.reset(serializeEditorHtml(content.innerHTML));
		resumeEditing(targetId, Number.MAX_SAFE_INTEGER);
		deleteNodeMutation.mutate(nodeId);
		return true;
	}, [nodeId, parentId, queryClient, resumeEditing, deleteNodeMutation, nameSaver]);

	/**
	 * Backspace at offset 0 / Delete at the text end with a collapsed caret: merge this
	 * row with its previous / next visible sibling (upstream). The kept row keeps its id,
	 * children, and note; the other is deleted. Returns false when the merge is refused.
	 */
	const mergeWithSibling = useCallback(
		(direction: "backward" | "forward"): boolean => {
			const content = contentRef.current;
			const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
			if (!content || nodeId === zoomedNodeId || globalThis.getSelection()?.isCollapsed !== true) {
				return false;
			}
			const offset = caretTextOffset(content);
			if (offset !== (direction === "backward" ? 0 : textUnitLength(content))) {
				return false;
			}
			const visible = new Set(
				collectVisibleNodeIds(queryClient, zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds),
			);
			const siblings = sortByPriority(readChildren(queryClient, parentId) ?? []).filter(
				(sibling) => sibling.id === nodeId || visible.has(sibling.id),
			);
			const index = siblings.findIndex((sibling) => sibling.id === nodeId);
			const current = siblings[index];
			if (current === undefined) {
				return false;
			}
			const toRow = (node: NodeResponse, html: string): MergeRow => {
				// Unknown children count as children: never delete a subtree that has not loaded.
				const children = readChildren(queryClient, node.id);
				return {
					id: node.id,
					html,
					hasChildren: children ? children.length > 0 : node.hasChildren !== false,
					hasNote: Boolean(readDetail(queryClient, node.id)?.note ?? node.note),
					completed: node.completedAt !== null,
					isMirror: node.isMirror === true,
					hasMirrors: node.hasMirrors === true,
					layoutMode: node.data.layoutMode,
					hasFile: node.attachment?.isDeleted === false,
				};
			};
			const currentRow = toRow(current, serializeEditorHtml(content.innerHTML));
			const neighbor = siblings[direction === "backward" ? index - 1 : index + 1];
			const neighborRow = neighbor === undefined ? null : toRow(neighbor, neighbor.name ?? "");
			const plan =
				direction === "backward"
					? planBackspaceAtStart({current: currentRow, previousSibling: neighborRow})
					: planDeleteAtEnd({current: currentRow, nextSibling: neighborRow});
			if (plan.kind === "none") {
				return false;
			}
			// The rename and the delete are one undo step; both read their before-values
			// from the cache, so they are issued before the optimistic merge below.
			void runInUndoBatch(captureOutlineView, () => {
				resumeEditing(plan.keepId, plan.caret);
				nameSaver.reset(plan.name);
				updateNodeMutation.mutate({nodeId: plan.keepId, name: plan.name});
				// The held editor never re-renders its text: show the merged row and its caret here.
				if (plan.keepId === nodeId) {
					content.innerHTML = renderName(plan.name);
					placeCaretAtTextOffset(content, plan.caret);
				}
				deleteNodeMutation.mutate(plan.deleteId);
				// Show the merged row at once; the mutations' refetch confirms it.
				queryClient.setQueryData<NodeResponse[]>(nodeKeys.children(parentId), (old) =>
					old
						?.filter((sibling) => sibling.id !== plan.deleteId)
						.map((sibling) => (sibling.id === plan.keepId ? {...sibling, name: plan.name} : sibling)),
				);
			});
			return true;
		},
		[nodeId, parentId, queryClient, resumeEditing, updateNodeMutation, deleteNodeMutation, nameSaver, renderName],
	);

	/**
	 * Backspace right after / Delete right before a date pill with a collapsed caret
	 * removes the whole pill (upstream monolith). Returns false when no pill is adjacent.
	 */
	const deleteAdjacentPill = useCallback(
		(direction: "backward" | "forward"): boolean => {
			const content = contentRef.current;
			if (!content) {
				return false;
			}
			const next = deleteAdjacentPillInEditor(
				content,
				serializeEditorHtml(content.innerHTML),
				direction,
				(html) => renderName(html),
			);
			if (next === null) {
				return false;
			}
			nameSaver.change(next);
			return true;
		},
		[renderName, nameSaver],
	);

	/**
	 * A structural shortcut (indent, outdent, move) holds editing while it re-renders
	 * the edited row. If React moved the row and focus fell to the page, take it back
	 * at the caret captured before the move, keeping the unsaved text in the DOM.
	 */
	useLayoutEffect(() => {
		const content = contentRef.current;
		if (!isEditing || !content || document.activeElement === content) {
			return;
		}
		const {editingHeld, editingCaretOffset, editingCaretEnd, editingCaretReversed} = useOutlineStore.getState();
		const focusIsLost = document.activeElement === null || document.activeElement === document.body;
		if (!editingHeld || !focusIsLost) {
			return;
		}
		content.focus();
		const start = editingCaretOffset ?? Number.MAX_SAFE_INTEGER;
		placeSelectionAtTextOffsets(content, start, editingCaretEnd ?? start, editingCaretReversed);
		releaseEditing();
	});

	const handleBlur = useCallback(
		(event: React.FocusEvent<HTMLSpanElement>) => {
			handleLinkBlur(event);
			detachSlashMenu();
			detachMentionMenu();
			detachMirrorMenu();
			hideDateAutocomplete();
			detachTagAutocomplete();
			if (shouldCommitOnBlur(useOutlineStore.getState(), nodeId)) {
				saveChanges();
			}
		},
		[
			nodeId,
			handleLinkBlur,
			saveChanges,
			detachSlashMenu,
			detachMentionMenu,
			detachMirrorMenu,
			hideDateAutocomplete,
			detachTagAutocomplete,
		],
	);

	/**
	 * ⇧↑ at the text start, ⇧↓ at its end, or ⌘A over the already fully selected text: commit the text, stop editing
	 * and select items instead (this row, or the zoom root / Home's top-level rows for ⌘A). Returns false when the key
	 * stays native.
	 */
	const selectItemsFromEditor = useCallback(
		(action: "SELECT_UP" | "SELECT_DOWN" | "SELECT_ALL"): boolean => {
			const content = contentRef.current;
			if (!content) {
				return false;
			}
			const {start, end} = selectionTextOffsets(content);
			const length = textUnitLength(content);
			const takesOver =
				action === "SELECT_ALL"
					? editorSelectAllTakesOver({start, end, length})
					: editorShiftArrowTakesOver({
							dir: action === "SELECT_UP" ? "up" : "down",
							start,
							end,
							length,
							inNote: false,
						});
			if (!takesOver) {
				return false;
			}
			const view = currentSelectionView(queryClient);
			saveChanges();
			stopEditing();
			globalThis.getSelection()?.removeAllRanges();
			content.blur();
			setItemSelection(freshSelection(view, action === "SELECT_ALL" ? view.allIds : [nodeId]));
			if (action !== "SELECT_ALL") {
				scrollRowIntoView(nodeId);
			}
			return true;
		},
		[nodeId, queryClient, saveChanges, setItemSelection, stopEditing],
	);

	/**
	 * Keys that mean something else in a table cell: Tab and the arrows move between cells, Enter adds a row,
	 * Backspace at the start of an empty cell deletes it. Returns true when the key was handled or swallowed.
	 */
	const handleTableCellKey = useCallback(
		(event: React.KeyboardEvent<HTMLSpanElement>, action: ReturnType<typeof classifyEditorKey>): boolean => {
			const content = contentRef.current;
			const location = content === null ? null : locateCell(queryClient, nodeId);
			if (content === null || location === null || event.nativeEvent.isComposing) {
				return false;
			}
			const deps = makeTableDeps(queryClient, {
				create: createNodeMutation.mutate,
				remove: deleteNodeMutation.mutate,
				move: moveNodeMutation.mutate,
				update: updateNodeMutation.mutate,
			});
			const collapsed = globalThis.getSelection()?.isCollapsed === true;
			const offset = caretTextOffset(content);
			if (action === "RETURN") {
				event.preventDefault();
				saveChanges();
				void cellEnter(deps, location);
				return true;
			}
			if (action === "DELETE_BACKWARD") {
				if (!collapsed || offset !== 0) {
					return false;
				}
				event.preventDefault();
				saveChanges();
				const node = readNode(queryClient, nodeId);
				void cellBackspace(deps, location, {
					name: content.textContent,
					note: node?.note ?? "",
					hasChildren: node?.hasChildren === true,
				});
				return true;
			}
			const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
			const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
			const name =
				event.key === "Tab"
					? event.shiftKey
						? "shift+Tab"
						: "Tab"
					: event.key.startsWith("Arrow") && (!event.shiftKey || vertical)
						? `${event.shiftKey ? "shift+" : ""}${event.key}`
						: null;
			if (!plain || name === null) {
				return false;
			}
			const plan = planCellKey(name, {
				row: location.rowIndex,
				col: location.colIndex,
				rowCount: location.grid.rows.length,
				rowLens: location.grid.rows.map((entry) => entry.cells.length),
				caretAtStart: collapsed && offset === 0,
				caretAtEnd: collapsed && offset === textUnitLength(content),
			});
			if (plan === null) {
				return false;
			}
			event.preventDefault();
			if ("focus" in plan) {
				const target = location.grid.rows[plan.focus.row]?.cells[plan.focus.col];
				if (target !== undefined) {
					saveChanges();
					resumeEditing(target.id, plan.focus.caret === "end" ? Number.MAX_SAFE_INTEGER : 0);
				}
			}
			return true;
		},
		[
			queryClient,
			nodeId,
			createNodeMutation.mutate,
			deleteNodeMutation.mutate,
			moveNodeMutation.mutate,
			updateNodeMutation.mutate,
			saveChanges,
			resumeEditing,
		],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLSpanElement>) => {
			// A capture-phase listener (the app message's action shortcut) already claimed this key.
			if (event.nativeEvent.defaultPrevented) {
				return;
			}
			if (handleLinkKey(event)) {
				return;
			}
			if (handleSlashKey(event)) {
				return;
			}
			if (handleMentionKey(event)) {
				return;
			}
			if (handleMirrorKey(event)) {
				return;
			}
			if (handleTagAutocompleteKey(event)) {
				return;
			}
			const action = classifyEditorKey(event, isMacPlatform());
			if (handleTableCellKey(event, action)) {
				return;
			}
			const composing = event.nativeEvent.isComposing;
			const formatAttr = classifyFormatKey(event, isMacPlatform());
			const highlight = isHighlightKey(event, isMacPlatform());
			const arrow = action === null ? undefined : CARET_ARROWS[action];
			if (
				(action === "SELECT_UP" || action === "SELECT_DOWN" || action === "SELECT_ALL") &&
				!composing &&
				selectItemsFromEditor(action)
			) {
				event.preventDefault();
			} else if (arrow !== undefined && !composing && enterRootNote(arrow)) {
				event.preventDefault();
			} else if ((action === "CARET_UP" || action === "CARET_DOWN") && !composing) {
				if (moveToAdjacentNode(action === "CARET_UP" ? "up" : "down")) {
					event.preventDefault();
				}
			} else if ((action === "CARET_LEFT" || action === "CARET_RIGHT") && !composing) {
				if (crossRowHorizontally(action === "CARET_LEFT" ? "left" : "right")) {
					event.preventDefault();
				}
			} else if (action === "CARRIAGE_RETURN") {
				event.preventDefault();
				// Alt+Enter in a link opens it, as upstream.
				if (event.altKey && contentRef.current !== null) {
					openLinkAtCaret(contentRef.current);
				}
			} else if (action === "RETURN") {
				event.preventDefault();
				splitAtSelection();
			} else if (action === "SHIFT_RETURN") {
				event.preventDefault();
				saveChanges();
				if (canHaveNote(readNode(queryClient, nodeId)?.data.layoutMode)) {
					focusNote(nodeId);
				}
			} else if (action === "DELETE_BACKWARD") {
				if (deleteAdjacentPill("backward") || deleteIfEmpty() || mergeWithSibling("backward")) {
					event.preventDefault();
				}
			} else if (action === "DELETE_FORWARD") {
				if (deleteAdjacentPill("forward") || mergeWithSibling("forward")) {
					event.preventDefault();
				}
			} else if (formatAttr !== null && !composing) {
				event.preventDefault();
				applyInlineToggle(formatAttr);
			} else if (highlight && !composing) {
				event.preventDefault();
				applyLatestOrOpen();
			}
		},
		[
			handleTableCellKey,
			deleteAdjacentPill,
			deleteIfEmpty,
			enterRootNote,
			focusNote,
			handleLinkKey,
			handleSlashKey,
			handleMentionKey,
			handleMirrorKey,
			handleTagAutocompleteKey,
			mergeWithSibling,
			moveToAdjacentNode,
			crossRowHorizontally,
			nodeId,
			saveChanges,
			selectItemsFromEditor,
			splitAtSelection,
			applyInlineToggle,
			applyLatestOrOpen,
			queryClient,
		],
	);

	return (
		<>
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- contentEditable makes this an implicit textbox, which the rule does not model */}
			<span
				className="innerContentContainer editing"
				data-node-id={nodeId}
				// The CSS `:empty` rule shows it only while the editor is empty.
				data-placeholder={placeholderFor({
					focused: true,
					empty: true,
					layoutMode: readNode(queryClient, nodeId)?.data.layoutMode,
					slashDiscovered,
					dashboardCard:
						parentId !== null &&
						isDashboard(readNode(queryClient, parentId)?.data.layoutMode, dashboardsOn()),
				})}
				contentEditable
				dangerouslySetInnerHTML={{__html: editorHtml}}
				onBlur={handleBlur}
				onClick={handleEditingClick}
				onInput={handleInput}
				onKeyDown={handleKeyDown}
				onPaste={handlePaste}
				onMouseDown={(event) => {
					tagPointer.onMouseDown(event);
					detachTagAutocomplete();
				}}
				onMouseLeave={tagPointer.onMouseLeave}
				// oxlint-disable-next-line jsx-a11y/mouse-events-have-key-events -- the tag-color trigger is a pointer-only affordance
				onMouseOver={tagPointer.onMouseOver}
				ref={contentRef}
				suppressContentEditableWarning
			/>
			{datePicker.popup}
			{pillPicker.popup}
			{dateAutocomplete.flyout}
			{tagAutocomplete.popup}
			{tagPointer.popups}
			{slashMenu.menu}
			{mentionMenu.menu}
			{mirrorMenu.menu}
			{colorPopup}
			{toolbarView && (
				<SelectionToolbar
					activeAttrs={toolbarView.activeAttrs}
					colorActive={toolbarView.colorActive}
					inNote={false}
					lastColorClass={lastColorClass}
					layoutMode={rowLayoutMode}
					onAction={handleToolbarAction}
					rect={toolbarView.rect}
				/>
			)}
		</>
	);
}

/**
 * A row's name while it is not being edited: its rendered HTML, a click that starts editing where it lands, tag
 * clicks and hovers, and date pill clicks. It holds none of the editor's hooks, effects or store subscriptions, so
 * swapping in a view's rows stays cheap; the row becomes an `EditingText` when editing starts.
 */
const RestingText = memo(function RestingText({
	nodeId,
	initialValue,
	layoutMode,
}: Pick<EditableTextProps, "nodeId" | "initialValue" | "layoutMode">) {
	const queryClient = useQueryClient();
	const {startEditing, resumeEditing} = outlineActions();
	const searchQuery = usePaneSearchQuery();
	const updateNodeMutation = useUpdateNode();
	const dateSettings = useDateSettings();
	const account = useAccount();
	// A plain click on a pill edits or removes just that pill, saving the stored name.
	const pillPicker = usePillDatePicker({
		dateSettings,
		onChange: (pillIndex, attrs) => {
			// Upstream edits the row afterwards: the caret lands after the new pill, or where the removed one was.
			const plan = planPillReplacement(initialValue, pillIndex, attrs);
			updateNodeMutation.mutate({nodeId, name: plan.html});
			// The editor captures its HTML when editing starts: show the new name before that.
			patchCachedNode(queryClient, nodeId, (node) => ({...node, name: plan.html}));
			resumeEditing(nodeId, plan.caretOffset, {html: plan.html});
		},
		onDismiss: () => {},
	});
	const {open: openPillPicker} = pillPicker;

	const tagPointer = useTagPointer({
		getHtml: () => initialValue,
		save: (name, caret) => {
			updateNodeMutation.mutate({nodeId, name});
			// The editor captures its HTML when editing starts: show the new name before that.
			patchCachedNode(queryClient, nodeId, (node) => ({...node, name}));
			resumeEditing(nodeId, caret, {html: name});
		},
	});

	/**
	 * Handle text clicks:
	 * - Meta-click (mac) or Meta/Alt-click on a .contentTag span: explodes the tag, removing it
	 *   and its following spaces in one undo step, then edits with the caret where it was
	 * - Plain click on a .contentTag span: blurs the editor, marks the tag tapped, and toggles
	 *   the tag in the search query (appends it, or removes it when already there)
	 * - Otherwise: start editing at click position
	 */
	const handleTextClick = useCallback(
		(event: React.MouseEvent<HTMLSpanElement>) => {
			if (tagPointer.onClick(event)) {
				return;
			}

			// Plain click on a date pill opens the picker on it; ⌥click is reserved for date search.
			const clicked = clickedPill(event, event.currentTarget);
			if (clicked !== null) {
				event.preventDefault();
				event.stopPropagation();
				openPillPicker(clicked.pill, clicked.index);
				return;
			}

			// Regular click: start editing at click position
			event.stopPropagation();
			startEditing(nodeId, {x: event.clientX, y: event.clientY});
		},
		[nodeId, startEditing, openPillPicker, tagPointer],
	);

	return (
		<>
			{/* Pointer entry point: a click places the caret for editing, and clicks on rendered .contentTag spans are delegated here. */}
			<span
				className="innerContentContainer"
				data-node-id={nodeId}
				dangerouslySetInnerHTML={{
					__html: highlightSearchMatches(
						normalizeLayoutMode(layoutMode) === "code-block"
							? renderCodeBlockHtml(initialValue)
							: renderEditorHtml(renderLinks(initialValue), dateSettings, account),
						searchQuery,
					),
				}}
				onClick={handleTextClick}
				onMouseDown={tagPointer.onMouseDown}
				onMouseLeave={tagPointer.onMouseLeave}
				// oxlint-disable-next-line jsx-a11y/mouse-events-have-key-events -- the tag-color trigger is a pointer-only affordance; the span is not focusable
				onMouseOver={tagPointer.onMouseOver}
				role="presentation"
			/>
			{tagPointer.popups}
			{pillPicker.popup}
		</>
	);
});

/**
 * A row's name: the full contenteditable `EditingText` while editing, else the light `RestingText`. Called as a
 * plain function, so a row mounts no fiber of its own for the choice.
 */
export function editableText(props: EditableTextProps) {
	return props.isEditing ? (
		<EditingText {...props} />
	) : (
		<RestingText initialValue={props.initialValue} layoutMode={props.layoutMode} nodeId={props.nodeId} />
	);
}
