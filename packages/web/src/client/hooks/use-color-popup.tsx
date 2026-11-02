import {useCallback, useEffect, useRef, useState} from "react";
import type {ReactNode, RefObject} from "react";
import type {ColorName} from "../../color-palette.js";
import {placeCaretAtTextOffset, selectionTextOffsets} from "../caret-dom.js";
import {ColorPopup} from "../components/color-popup.js";
import {pop, unpop} from "../popups.js";
import {colorAt} from "../rich-text.js";
import type {ColorKind} from "../rich-text.js";

/** Escape collapses the caret to the selection start (upstream's `ZS4` Escape handler). */
export function escapeCaret(sel: {start: number; end: number}):
{
	start: number;
	end: number;
}
{
	return {
		start: sel.start,
		end: sel.start,
	};
}

interface ColorPopupOptions
{
	editorRef: RefObject<HTMLElement | null>;
	/** The editor's content as stored HTML. */
	read: () => string;
	applyColorToggle: (kind: ColorKind, color: ColorName | null) => void;
	applyLatestColor: () => boolean;
	/** Closes the selection toolbar before the popup replaces it. */
	hideToolbar: () => void;
	/** Re-evaluates the selection toolbar once the popup is gone. */
	refreshToolbar: () => void;
}

interface OpenState
{
	left: number;
	top: number;
	selected:
	{
		text?: ColorName;
		highlight?: ColorName;
	};
}

/**
 * Upstream's caret-mode text/highlight popup for one editor: the toolbar's chevron opens it at the selection's
 * bottom-left, the font button reapplies the latest color (or opens it when none was picked), a pick applies and
 * closes it with the selection kept, and Escape collapses the caret to the selection start.
 */
export function useColorPopup({
	editorRef,
	read,
	applyColorToggle,
	applyLatestColor,
	hideToolbar,
	refreshToolbar,
}: ColorPopupOptions):
{
	popup: ReactNode;
	openPalette: () => void;
	applyLatestOrOpen: () => void;
}
{
	const [state, setState] = useState<OpenState | null>(null);
	const opened = useRef(false);

	const close = useCallback(() =>
	{
		opened.current = false;
		unpop("COLORS_POPUP");
		setState(null);
		refreshToolbar();
	}, [refreshToolbar]);

	useEffect(
		() => () =>
		{
			unpop("COLORS_POPUP");
		},
		[],
	);

	const openPalette = useCallback(() =>
	{
		const editor = editorRef.current;
		const selection = globalThis.getSelection();
		if (editor === null || selection === null || selection.rangeCount === 0)
		{
			return;
		}
		const box = selection.getRangeAt(0).getBoundingClientRect();
		const {start, end} = selectionTextOffsets(editor);
		hideToolbar();
		opened.current = true;
		pop("COLORS_POPUP", editor);
		setState(
			{
				left: box.left,
				top: box.bottom,
				selected: colorAt(read(), start, end),
			},
		);
	}, [editorRef, hideToolbar, read]);

	const applyLatestOrOpen = useCallback(() =>
	{
		if (!applyLatestColor())
		{
			openPalette();
		}
	}, [applyLatestColor, openPalette]);

	const popup =
		state === null ? null : (
			<ColorPopup
				left={state.left}
				top={state.top}
				selected={state.selected}
				onSelect={(kind, color) =>
				{
					applyColorToggle(kind, color);
					close();
				}}
				onClose={close}
				onEscape={() =>
				{
					const editor = editorRef.current;
					if (editor !== null)
					{
						placeCaretAtTextOffset(editor, escapeCaret(selectionTextOffsets(editor)).start);
					}
					close();
				}}
			/>
		);

	return {
		popup,
		openPalette,
		applyLatestOrOpen,
	};
}
