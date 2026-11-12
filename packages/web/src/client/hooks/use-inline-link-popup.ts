import {useQueryClient} from "@tanstack/react-query";
import {useCallback, useEffect, useRef} from "react";
import type {FocusEvent, KeyboardEvent, RefObject} from "react";
import {caretAnchor, caretTextOffset, textRangeBox} from "../caret-dom.js";
import {crumbLabel as formatCrumbLabel} from "../crumb-label.js";
import type {DateSettings} from "../date-settings.js";
import {isComposingInput, serializeEditorHtml} from "../editor-html.js";
import {bracketMatch, innerText, planAutoClose, planLinkInsert} from "../inline-link.js";
import type {BracketMatch} from "../inline-link.js";
import {internalLinkUrl} from "../item-menu-model.js";
import type {MentionAccount} from "../mention-pills.js";
import {readNode} from "../node-cache.js";
import {plainText} from "../rich-text.js";
import {useOutlineStore} from "../stores/outline.js";
import type {LocationPickerResult} from "../stores/outline.js";
import {fetchNode} from "./use-nodes.js";

/** Stands in for a date or mention pill, which counts as one plain-text unit. */
const PILL_UNIT = "￼";
const TOAST_TIMEOUT = 5000;
/** Keys the open popup's menu takes from the editor. */
const POPUP_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"]);

export interface InlineLinkPopupOptions
{
	nodeId: string;
	contentRef: RefObject<HTMLElement | null>;
	dateSettings: DateSettings;
	account: MentionAccount;
	/** Show `html` as the row's name with the caret at `caret` plain-text units, and save it as one undo step. */
	applyLink: (html: string, caret: number) => void;
}

export interface InlineLinkPopup
{
	/** After each typed input: closes a fresh `[[` with `]]`, and keeps the popup's filter current. */
	handleInput: (event: Event) => void;
	/** True when the open popup's menu takes the key. */
	handleKeyDown: (event: KeyboardEvent) => boolean;
	/** The editor lost focus: the popup stays only when focus went into it. */
	handleBlur: (event: FocusEvent) => void;
	isOpen: () => boolean;
	close: () => void;
}

/** The editor's plain text (pills as one unit each) and the caret in the same units. */
function editorState(content: HTMLElement):
{
	text: string;
	caret: number;
}
{
	return {
		text: plainText(serializeEditorHtml(content.innerHTML), PILL_UNIT),
		caret: caretTextOffset(content),
	};
}

/** Insert `]]` at the caret, leaving the caret before it. */
function insertClosingBrackets(): void
{
	const selection = globalThis.getSelection();
	if (selection === null || selection.rangeCount === 0)
	{
		return;
	}
	const range = selection.getRangeAt(0);
	const closing = document.createTextNode("]]");
	range.insertNode(closing);
	range.setStartBefore(closing);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** The picker anchor: the bottom-left of the `[[` box. */
function bracketAnchor(
	content: HTMLElement,
	index: number,
):
{
	x: number;
	y: number;
}
{
	const {x, y} = caretAnchor([textRangeBox(content, index, index + 2)], content.getBoundingClientRect());
	return {
		x: x + window.scrollX,
		y: y + window.scrollY,
	};
}

/**
 * Upstream's `[[` inline link popup (`LINK_SEARCH_POPUP`): typing `[[` closes it with `]]`, and while the caret is
 * inside a `[[…]]` pair the location picker lists items matching the text between the brackets under a "link to"
 * header. Choosing one replaces the pair with a link to it and a space; choosing a created item links the new item.
 */
export function useInlineLinkPopup({
	nodeId,
	contentRef,
	dateSettings,
	account,
	applyLink,
}: InlineLinkPopupOptions): InlineLinkPopup
{
	const queryClient = useQueryClient();
	const openRef = useRef(false);
	const session = useRef(0);
	const matchRef = useRef<BracketMatch>(
		{
			index: -1,
			text: "",
		},
	);
	const filterRef = useRef("");
	const latest = useRef(
		{
			dateSettings,
			account,
			applyLink,
		},
	);
	useEffect(() =>
	{
		latest.current =
		{
			dateSettings,
			account,
			applyLink,
		};
	});

	const isOpen = useCallback(() => openRef.current, []);

	const close = useCallback(() =>
	{
		if (openRef.current && useOutlineStore.getState().locationPicker?.forItemId === nodeId)
		{
			useOutlineStore.getState().closeLocationPicker(undefined);
		}
		openRef.current = false;
	}, [nodeId]);

	const link = useCallback(
		async (result: Exclude<LocationPickerResult, undefined>, match: BracketMatch, filter: string) =>
		{
			const store = useOutlineStore.getState();
			const id = "createdId" in result ? result.createdId : result.id;
			if (id === "None" || id === "")
			{
				store.showAppMessage(
					"Cannot link Home",
					{
						timeout: TOAST_TIMEOUT,
						type: "failure",
					},
				);
				return;
			}
			let label = filter;
			if ("id" in result)
			{
				const name = readNode(queryClient, id)?.name ?? (await fetchNode(id)).name ?? "";
				label = formatCrumbLabel(
					name,
					{
						now: new Date(),
						dateFormat: latest.current.dateSettings.dateFormat,
						timeFormat: latest.current.dateSettings.timeFormat,
						account: latest.current.account,
					},
				);
			}
			const content = contentRef.current;
			if (content === null)
			{
				return;
			}
			const html = serializeEditorHtml(content.innerHTML);
			const text = plainText(html, PILL_UNIT);
			if (text.slice(match.index, match.index + match.text.length) !== match.text)
			{
				return;
			}
			const plan = planLinkInsert(html, match, label === "" ? "Untitled" : label, internalLinkUrl(id));
			latest.current.applyLink(plan.html, plan.caret);
		},
		[contentRef, queryClient],
	);

	const open = useCallback(
		(match: BracketMatch) =>
		{
			const content = contentRef.current;
			if (content === null)
			{
				return;
			}
			matchRef.current = match;
			filterRef.current = innerText(match);
			openRef.current = true;
			const token = ++session.current;
			void useOutlineStore
				.getState()
				.openLocationPicker(
					{
						forItemId: nodeId,
						headerText: "link to",
						subActionName: "",
						getFilter: () => filterRef.current,
						relatedToId: nodeId,
					},
					bracketAnchor(content, match.index),
				)
				.then(async (result) =>
				{
					if (token === session.current)
					{
						openRef.current = false;
					}
					if (result !== undefined)
					{
						await link(result, matchRef.current, filterRef.current);
					}
					return;
				});
		},
		[contentRef, link, nodeId],
	);

	/** Open, refresh or close the popup for the caret's place; `allowOpen` lets a closed popup open. */
	const sync = useCallback(
		(allowOpen: boolean) =>
		{
			const content = contentRef.current;
			const selection = globalThis.getSelection();
			if (content === null || selection === null || selection.rangeCount === 0)
			{
				return;
			}
			if (!content.contains(selection.anchorNode))
			{
				return;
			}
			if (!selection.isCollapsed)
			{
				close();
				return;
			}
			const {text, caret} = editorState(content);
			const match = bracketMatch(text, caret);
			if (match.index === -1)
			{
				close();
			}
			else if (openRef.current)
			{
				if (match.index !== matchRef.current.index || match.text !== matchRef.current.text)
				{
					matchRef.current = match;
					filterRef.current = innerText(match);
					useOutlineStore.getState().refreshLocationPicker();
				}
			}
			else if (allowOpen)
			{
				open(match);
			}
		},
		[close, contentRef, open],
	);

	useEffect(() =>
	{
		const onSelectionChange = () =>
		{
			sync(true);
		};
		document.addEventListener("selectionchange", onSelectionChange);
		return () =>
		{
			document.removeEventListener("selectionchange", onSelectionChange);
		};
	}, [sync]);

	// The row going away takes its popup with it.
	useEffect(
		() => () =>
		{
			close();
		},
		[close],
	);

	const handleInput = useCallback(
		(event: Event) =>
		{
			const content = contentRef.current;
			if (content === null || isComposingInput(event))
			{
				return;
			}
			let closed = false;
			if (event instanceof InputEvent && event.inputType === "insertText")
			{
				const {text, caret} = editorState(content);
				if (planAutoClose(text, caret) !== null)
				{
					insertClosingBrackets();
					closed = true;
				}
			}
			sync(closed);
		},
		[contentRef, sync],
	);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent): boolean =>
			openRef.current &&
			POPUP_KEYS.has(event.key) &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!event.nativeEvent.isComposing,
		[],
	);

	const handleBlur = useCallback(
		(event: FocusEvent) =>
		{
			const next = event.relatedTarget;
			if (next instanceof Element && next.closest("[data-popper-placement]") !== null)
			{
				return;
			}
			close();
		},
		[close],
	);

	return {
		handleInput,
		handleKeyDown,
		handleBlur,
		isOpen,
		close,
	};
}
