import {useEffect} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useStableNavigate} from "./use-stable-navigate.js";
import {caretTextOffset, editorElement} from "../caret-dom.js";
import {escapeAction, outlineFocusTarget} from "../search-escape.js";
import {isModalOpen, useOutlineStore} from "../stores/outline.js";
import type {SearchReturn} from "../stores/outline.js";
import {collectVisibleNodeIds} from "./use-visible-nodes.js";
import {currentSearchFilter} from "./use-tree-search.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {paneScrollTop, scrollPaneTo} from "../components/pane-context.js";

const SEARCH_INPUT_ID = "srch-input";

/** The main outline's scroll (its pane scroller while panes are open, else the window's) when Escape focused search, restored when focus returns. */
let savedScrollTop: number | null = null;

function searchInputElement(): HTMLInputElement | null
{
	const input = document.getElementById(SEARCH_INPUT_ID);
	return input instanceof HTMLInputElement ? input : null;
}

function editFirstVisibleRow(queryClient: QueryClient): void
{
	const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds, resumeEditing} =
		useOutlineStore.getState();
	const [firstId] = collectVisibleNodeIds(
		queryClient,
		zoomedNodeId,
		expandedIds,
		showCompleted,
		animatingCompletionIds,
		currentSearchFilter(queryClient, MAIN_PANE_ID),
	);
	const target = outlineFocusTarget(
		{
			zoomedNodeId,
			firstVisibleId: firstId,
		},
	);
	if (target !== null)
	{
		resumeEditing(target.nodeId, target.offset);
	}
}

/**
 * Blur the search box and hand focus back to the outline: `leave` (blurring search by default) resumes the
 * remembered row and caret, else the first visible row is edited. Restores the scroll Escape saved.
 */
export function focusOutline(
	queryClient: QueryClient,
	leave = (): void =>
	{
		useOutlineStore.getState().blurSearch();
	},
): void
{
	searchInputElement()?.blur();
	const resumes = useOutlineStore.getState().searchReturn !== null;
	leave();
	if (!resumes)
	{
		editFirstVisibleRow(queryClient);
	}
	restoreSavedScroll();
}

function restoreSavedScroll(): void
{
	const scrollTop = savedScrollTop;
	savedScrollTop = null;
	if (scrollTop !== null)
	{
		scrollPaneTo(MAIN_PANE_ID, scrollTop);
	}
}

/** Where the caret sits in the edited name or note, blurring that editor so its text commits. */
function leaveEditor(): SearchReturn | null
{
	const {editingId, editingNoteId} = useOutlineStore.getState();
	if (editingId !== null)
	{
		const editor = editorElement(editingId);
		const from: SearchReturn =
		{
			nodeId: editingId,
			caretOffset: editor === null ? 0 : caretTextOffset(editor),
			field: "name",
		};
		editor?.blur();
		return from;
	}
	if (editingNoteId !== null)
	{
		const active = document.activeElement;
		const noteEl = active instanceof HTMLElement && active.matches(".notes > .content") ? active : null;
		const caretOffset =
			noteEl === null
				? Number.MAX_SAFE_INTEGER
				: caretTextOffset(noteEl.querySelector<HTMLElement>(".innerContentContainer") ?? noteEl);
		if (active instanceof HTMLElement)
		{
			active.blur();
		}
		return {
			nodeId: editingNoteId,
			caretOffset,
			field: "note",
		};
	}
	return null;
}

function popupOwnsEscape(): boolean
{
	const {presentationOpen, requestedMenus} = useOutlineStore.getState();
	return isModalOpen() || presentationOpen || requestedMenus.size > 0;
}

/**
 * Upstream's global Escape (`focus_or_unfocus_search`): cancel a committed or typed search and return to the
 * outline, else leave a focused empty search box for the remembered caret, else commit the edited text and focus
 * the search box. Runs on `window` after every popup, menu and editor has had its chance to claim Escape.
 */
export function useSearchEscape(): void
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();

	useEffect(() =>
	{
		const onKeyDown = (event: KeyboardEvent): void =>
		{
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.isComposing ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey ||
				popupOwnsEscape()
			)
			{
				return;
			}
			event.preventDefault();
			const state = useOutlineStore.getState();
			const action = escapeAction(
				{
					searchQuery: state.searchQuery,
					searchInput: state.searchInput,
					inputFocused: document.activeElement?.id === SEARCH_INPUT_ID,
				},
			);
			switch (action)
			{
				case "cancel":
				{
					// Upstream lands the caret on the zoom-root title (or the first row), not on the row Escape left.
					leaveEditor();
					searchInputElement()?.blur();
					useOutlineStore.setState(
						{
							searchReturn: null,
						},
					);
					useOutlineStore.getState().cancelSearch(navigate);
					editFirstVisibleRow(queryClient);
					restoreSavedScroll();
					break;
				}
				case "blur":
				{
					focusOutline(queryClient);
					break;
				}
				case "focus":
				{
					const from = leaveEditor();
					savedScrollTop = paneScrollTop(MAIN_PANE_ID);
					state.focusSearch(from);
					searchInputElement()?.focus();
					break;
				}
			}
		};
		globalThis.addEventListener("keydown", onKeyDown);
		return () =>
		{
			globalThis.removeEventListener("keydown", onKeyDown);
		};
	}, [queryClient, navigate]);
}
