import {useCallback, useMemo, useRef, useState} from "react";
import type {ReactNode} from "react";
import {useQuery} from "@tanstack/react-query";
import {caretTextOffset} from "../caret-dom.js";
import type {TagAutocompleteResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {useOutlineStore} from "../stores/outline.js";
import {applyAccept, attach, autocompleteSearch, currentQuery, narrowResults, shouldShow} from "../tag-autocomplete.js";
import type {AutocompleteResult} from "../tag-autocomplete.js";
import {TagAutocompletePopup, tagPopupInput, tagPopupKey} from "../components/tag-autocomplete-popup.js";
import type {TagPopupState} from "../components/tag-autocomplete-popup.js";

interface Attached
{
	start: number;
	query: string;
	/** The field's plain text when `query` was read. */
	text: string;
	/** The zoomed node whose subtree ranks the tags, read when `query` was. */
	root: string;
	visible: boolean;
	active: number;
	/** Viewport point just after the `#`: its left and bottom. */
	left: number;
	top: number;
}

/** Replace plain-text units `[start, end)` with `inserted` and put the caret at `caret`. */
export type TagAcceptHandler = (edit: {start: number; end: number; inserted: string; caret: number}) => void;

interface TagAutocompleteOptions
{
	editorRef: React.RefObject<HTMLElement | null>;
	/** The edited item; its live text replaces its saved text in the counts. */
	nodeId: string;
	field: "name" | "note";
	/** The editor's plain text in caret units (a date pill is one unit). */
	readPlain: () => string;
	onAccept: TagAcceptHandler;
}

async function fetchAutocomplete(search: string): Promise<AutocompleteResult[]>
{
	const response = await fetch(`/api/v1/tags/autocomplete?${search}`);
	if (!response.ok)
	{
		throw new Error(`Failed to fetch tag autocomplete: ${response.statusText}`);
	}
	return (await readJson<TagAutocompleteResponse>(response)).tags;
}

/** The viewport point of a collapsed range `back` units before the caret, or null without a selection. */
function anchorBefore(back: number):
{
	left: number;
	top: number;
} | null
{
	const selection = globalThis.getSelection();
	const caret = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
	if (!caret)
	{
		return null;
	}
	const range = caret.cloneRange();
	if (caret.startContainer.nodeType === Node.TEXT_NODE)
	{
		range.setStart(caret.startContainer, Math.max(0, caret.startOffset - back));
	}
	range.collapse(true);
	const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
	return {
		left: rect.left,
		top: rect.bottom,
	};
}

/**
 * Upstream's tagging autocomplete in an editor: each input attaches at a trailing `#tag`/`@tag`
 * (or bare `#`) and tracks the start-to-caret query; the zoom subtree's ranked tags show in a
 * popup that Tab/Enter or a row mousedown accepts. Call `handleKeyDown` first in the editor's
 * keydown handler; it returns true when the popup took the key. Blur or a click detaches.
 */
export function useTagAutocomplete({editorRef, nodeId, field, readPlain, onAccept}: TagAutocompleteOptions):
{
	handleInput: () => void;
	handleKeyDown: (event: React.KeyboardEvent) => boolean;
	detach: () => void;
	popup: ReactNode;
}
{
	const [attached, setAttachedState] = useState<Attached | null>(null);
	const attachedRef = useRef<Attached | null>(null);
	const setAttached = useCallback((next: Attached | null) =>
	{
		attachedRef.current = next;
		setAttachedState(next);
	}, []);
	const detach = useCallback(() =>
	{
		if (attachedRef.current !== null)
		{
			setAttached(null);
		}
	}, [setAttached]);

	// Read only while attached, so a resting row neither subscribes to the zoom nor builds a search it never sends.
	const query = attached?.query ?? null;
	const search =
		attached === null
			? ""
			: autocompleteSearch(
					{
						root: attached.root,
						prefix: attached.query,
						item: nodeId,
						field,
						text: attached.text,
					},
				);
	const {data: results = []} = useQuery(
		{
			queryKey: ["tag-autocomplete", search],
			queryFn: async () => fetchAutocomplete(search),
			enabled: query !== null,
			staleTime: 5000,
			placeholderData: (previous) => narrowResults(previous ?? [], query ?? ""),
		},
	);
	const tags = useMemo(
		() => (query !== null && shouldShow(results, query) ? results.map((result) => result.tag) : []),
		[results, query],
	);

	const handleInput = useCallback(() =>
	{
		const editor = editorRef.current;
		const selection = globalThis.getSelection();
		if (editor === null || !selection?.isCollapsed)
		{
			detach();
			return;
		}
		const caret = caretTextOffset(editor);
		const plain = readPlain();
		const current = attachedRef.current;
		const kept = current !== null && currentQuery(plain, current.start, caret) !== null ? current.start : null;
		const start = kept ?? attach(plain.slice(0, caret))?.start ?? null;
		const nextQuery = start === null ? null : currentQuery(plain, start, caret);
		const anchor = start === null ? null : anchorBefore(caret - start - 1);
		if (start === null || nextQuery === null || anchor === null)
		{
			detach();
			return;
		}
		const state: TagPopupState = tagPopupInput(
			{
				attached: true,
				visible: current?.visible ?? true,
				active: current !== null && kept !== null && current.query === nextQuery ? current.active : 0,
			},
		);
		const root = useOutlineStore.getState().zoomedNodeId ?? "";
		setAttached(
			{
				start,
				query: nextQuery,
				text: plain,
				root,
				visible: state.visible,
				active: state.active,
				...anchor,
			},
		);
	}, [editorRef, readPlain, detach, setAttached]);

	const accept = useCallback(
		(index: number) =>
		{
			const current = attachedRef.current;
			const editor = editorRef.current;
			const chosen = tags[index];
			if (current === null || editor === null || chosen === undefined)
			{
				return;
			}
			const plain = readPlain();
			const caret = caretTextOffset(editor);
			const next = applyAccept(plain, current.start, caret, chosen);
			setAttached(null);
			onAccept(
				{
					start: current.start,
					end: plain.length - next.text.length + next.caret,
					inserted: next.text.slice(current.start, next.caret),
					caret: next.caret,
				},
			);
		},
		[editorRef, readPlain, onAccept, setAttached, tags],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent): boolean =>
		{
			const current = attachedRef.current;
			const count = tags.length;
			if (current === null)
			{
				return false;
			}
			const result = tagPopupKey(
				{
					attached: true,
					visible: current.visible && count > 0,
					active: current.active,
				},
				{
					key: event.key,
					ctrlKey: event.ctrlKey,
					shiftKey: event.shiftKey,
					isComposing: event.nativeEvent.isComposing,
				},
				count,
			);
			if (!result.preventDefault)
			{
				return false;
			}
			event.preventDefault();
			event.stopPropagation();
			if (result.accept === null)
			{
				setAttached(
					{
						...current,
						visible: result.state.visible,
						active: result.state.active,
					},
				);
			}
			else
			{
				accept(result.accept);
			}
			return true;
		},
		[accept, setAttached, tags],
	);

	const popup =
		attached?.visible === true && tags.length > 0 ? (
			<TagAutocompletePopup
				tags={tags}
				active={attached.active}
				left={attached.left}
				top={attached.top}
				onAccept={accept}
			/>
		) : null;
	return {
		handleInput,
		handleKeyDown,
		detach,
		popup,
	};
}
