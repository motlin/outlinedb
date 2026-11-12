import {anotherPopupOpened, pop, unpop} from "../popups.js";
import type {PopupId} from "../popups.js";
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import type {RefObject} from "react";
import {selectionTextOffsets} from "../caret-dom.js";
import type {LayoutHotkeyCommand} from "../layout-hotkeys.js";
import {normalizeLayoutMode} from "../layout-types.js";
import {touchesAttr, touchesColor} from "../rich-text.js";
import type {InlineAttr} from "../rich-text.js";
import type {SelectionToolbarAction} from "../components/selection-toolbar.js";

/** Whether upstream's selection toolbar (`Lr2`) is shown, and what suppresses it. */
export interface ToolbarState
{
	visible: boolean;
	/** The primary button is down: selection changes wait for its pointerup. */
	pointerDown: boolean;
	/** An IME composition is running: the toolbar stays closed until it ends. */
	composing: boolean;
}

/**
 * `stretched`: the focused editor's selection is not collapsed. `popupOpen`: another popup is open, which keeps a
 * closed toolbar closed. `insideCtxMenu`: the pointerdown hit the toolbar itself.
 */
export type ToolbarEvent =
	|
	  {
			type: "pointerdown";
			insideCtxMenu: boolean;
	  }
	|
	  {
			type: "pointerup";
			stretched: boolean;
			popupOpen: boolean;
	  }
	|
	  {
			type: "selectionchange";
			stretched: boolean;
			popupOpen: boolean;
	  }
	|
	  {
			type: "compositionstart";
	  }
	|
	  {
			type: "compositionend";
	  }
	|
	  {
			type: "escape";
	  };

export function initialToolbarState(pointerDown: boolean): ToolbarState
{
	return {
		visible: false,
		pointerDown,
		composing: false,
	};
}

function evaluate(state: ToolbarState, stretched: boolean, popupOpen: boolean): boolean
{
	if (!stretched || state.composing)
	{
		return false;
	}
	return state.visible || !popupOpen;
}

/**
 * Upstream's toolbar show/hide rules: it opens on a stretched selection in the focused editor, but only once the
 * primary button is up, never during a composition, and never over another popup; it closes on collapse, a
 * pointerdown outside `.ctx-menu`, a composition, or Escape.
 */
export function toolbarState(state: ToolbarState, event: ToolbarEvent): ToolbarState
{
	switch (event.type)
	{
		case "pointerdown":
		{
			return {
				...state,
				pointerDown: true,
				visible: state.visible && event.insideCtxMenu,
			};
		}
		case "pointerup":
		{
			const released =
			{
				...state,
				pointerDown: false,
			};
			return {
				...released,
				visible: evaluate(released, event.stretched, event.popupOpen),
			};
		}
		case "selectionchange":
		{
			if (state.pointerDown)
			{
				return state;
			}
			return {
				...state,
				visible: evaluate(state, event.stretched, event.popupOpen),
			};
		}
		case "compositionstart":
		{
			return {
				...state,
				composing: true,
				visible: false,
			};
		}
		case "compositionend":
		{
			return {
				...state,
				composing: false,
			};
		}
		case "escape":
		{
			break;
		}
	}
	return {
		...state,
		visible: false,
	};
}

const FORMAT_ACTIONS: Partial<Record<SelectionToolbarAction, InlineAttr>> =
{
	bold: "b",
	italic: "i",
	underline: "u",
	strikethrough: "s",
	"code-format": "code",
};

const LAYOUT_ACTIONS: Partial<Record<SelectionToolbarAction, LayoutHotkeyCommand>> =
{
	h1: "toggle_h1",
	h2: "toggle_h2",
	h3: "toggle_h3",
	p: "toggle_paragraph",
};

/** The inline attribute a toolbar format button toggles, or null. */
export function toolbarFormatAttr(action: SelectionToolbarAction): InlineAttr | null
{
	return FORMAT_ACTIONS[action] ?? null;
}

/** The layout toggle a toolbar type button runs, or null. */
export function toolbarLayoutCommand(action: SelectionToolbarAction): LayoutHotkeyCommand | null
{
	return LAYOUT_ACTIONS[action] ?? null;
}

const INLINE_ATTRS: readonly InlineAttr[] = ["b", "i", "u", "s", "code"];

export interface SelectionToolbarView
{
	/** The selection's bounding rect in page coordinates. */
	rect:
	{
		x: number;
		y: number;
		width: number;
	};
	activeAttrs: ReadonlySet<InlineAttr>;
	/** A text color or highlight touches the selection. */
	colorActive: boolean;
}

/** Changes whenever the row's normalized layout changes, so the toolbar re-measures after the row re-renders. */
export function toolbarRefreshKey(layoutMode: string | null | undefined): string
{
	return normalizeLayoutMode(layoutMode) ?? "bullets";
}

let primaryDown = false;
let trackerInstalled = false;

function releasePrimary(event: PointerEvent): void
{
	if (event.button === 0 || event.type === "pointercancel")
	{
		primaryDown = false;
	}
}

/** One document-wide primary-button tracker, so an editor focused mid-drag still waits for the pointerup. */
function installPointerTracker(): void
{
	if (trackerInstalled)
	{
		return;
	}
	trackerInstalled = true;
	document.addEventListener(
		"pointerdown",
		(event) =>
		{
			if (event.button === 0)
			{
				primaryDown = true;
			}
		},
		true,
	);
	document.addEventListener("pointerup", releasePrimary, true);
	document.addEventListener("pointercancel", releasePrimary, true);
}

/** A modal is open, or the registry holds a popup other than `self` (upstream's `anotherPopupOpened`). */
export function otherPopupOpen(self: PopupId, modalOpen: () => boolean): boolean
{
	return modalOpen() || anotherPopupOpened(self);
}

function stretchedIn(editor: HTMLElement): boolean
{
	const selection = globalThis.getSelection();
	return (
		document.activeElement === editor &&
		selection !== null &&
		selection.rangeCount > 0 &&
		!selection.isCollapsed &&
		editor.contains(selection.anchorNode) &&
		editor.contains(selection.focusNode)
	);
}

function measure(editor: HTMLElement, html: string): SelectionToolbarView | null
{
	const selection = globalThis.getSelection();
	if (selection === null || selection.rangeCount === 0)
	{
		return null;
	}
	const box = selection.getRangeAt(0).getBoundingClientRect();
	const {start, end} = selectionTextOffsets(editor);
	return {
		rect:
		{
			x: box.left + globalThis.scrollX,
			y: box.top + globalThis.scrollY,
			width: box.width,
		},
		activeAttrs: new Set(INLINE_ATTRS.filter((attr) => touchesAttr(html, start, end, attr))),
		colorActive: touchesColor(html, start, end),
	};
}

interface SelectionToolbarOptions
{
	editorRef: RefObject<HTMLElement | null>;
	/** The editor is mounted and may hold the focused selection. */
	active: boolean;
	/** The editor's content as stored HTML, for the active formats. */
	read: () => string;
	/** A modal (link insert, jump menu, dialogs) is open; another registered popup also counts. */
	modalOpen: () => boolean;
}

/**
 * Drives upstream's floating selection toolbar for one editor: `selectionchange` and primary `pointerup` (capture)
 * are coalesced into one animation frame, and the rect and active formats are recomputed on every change.
 * Returns the toolbar view (null when hidden) and `refresh`, which re-measures after a change that moves no
 * selection (a layout toggle).
 */
export function useSelectionToolbar({editorRef, active, read, modalOpen}: SelectionToolbarOptions):
{
	view: SelectionToolbarView | null;
	refresh: () => void;
	/** Closes the bar now (a popup that replaces it is about to open). */
	hide: () => void;
}
{
	const [view, setView] = useState<SelectionToolbarView | null>(null);
	const io = useRef(
		{
			read,
			modalOpen,
		},
	);
	useLayoutEffect(() =>
	{
		io.current =
		{
			read,
			modalOpen,
		};
	});
	const refreshRef = useRef<() => void>(() => {});
	const hideRef = useRef<() => void>(() => {});

	useEffect(() =>
	{
		const editor = editorRef.current;
		if (!active || editor === null)
		{
			setView(null);
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		installPointerTracker();
		let state = initialToolbarState(primaryDown);
		let frame = 0;
		let released = false;
		const publish = () =>
		{
			const next = state.visible ? measure(editor, io.current.read()) : null;
			if (next === null)
			{
				unpop("CTX_MENU_POPUP");
			}
			else
			{
				pop("CTX_MENU_POPUP", editor);
			}
			setView(next);
		};
		const dispatch = (event: ToolbarEvent) =>
		{
			state = toolbarState(state, event);
			publish();
		};
		const schedule = () =>
		{
			if (frame !== 0)
			{
				return;
			}
			frame = requestAnimationFrame(() =>
			{
				frame = 0;
				const stretched = stretchedIn(editor);
				const popupOpen = otherPopupOpen("CTX_MENU_POPUP", io.current.modalOpen);
				dispatch(
					released
						?
							{
								type: "pointerup",
								stretched,
								popupOpen,
							}
						:
							{
								type: "selectionchange",
								stretched,
								popupOpen,
							},
				);
				released = false;
			});
		};
		refreshRef.current = schedule;
		hideRef.current = () =>
		{
			dispatch(
				{
					type: "escape",
				},
			);
		};
		const onPointerDown = (event: PointerEvent) =>
		{
			if (event.button === 0)
			{
				const insideCtxMenu = event.target instanceof Element && event.target.closest(".ctx-menu") !== null;
				dispatch(
					{
						type: "pointerdown",
						insideCtxMenu,
					},
				);
			}
		};
		const onPointerUp = (event: PointerEvent) =>
		{
			if (event.button === 0)
			{
				released = true;
				schedule();
			}
		};
		const onCompositionStart = () =>
		{
			dispatch(
				{
					type: "compositionstart",
				},
			);
		};
		const onCompositionEnd = () =>
		{
			dispatch(
				{
					type: "compositionend",
				},
			);
			schedule();
		};
		const onKeyDown = (event: KeyboardEvent) =>
		{
			if (event.key === "Escape")
			{
				dispatch(
					{
						type: "escape",
					},
				);
			}
		};
		document.addEventListener("selectionchange", schedule);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("pointerup", onPointerUp, true);
		editor.addEventListener("compositionstart", onCompositionStart);
		editor.addEventListener("compositionend", onCompositionEnd);
		editor.addEventListener("keydown", onKeyDown);
		// The editor may already hold a stretched selection (focus handed over with one).
		schedule();
		return () =>
		{
			cancelAnimationFrame(frame);
			refreshRef.current = () =>
			{
			};
			hideRef.current = () =>
			{
			};
			document.removeEventListener("selectionchange", schedule);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("pointerup", onPointerUp, true);
			editor.removeEventListener("compositionstart", onCompositionStart);
			editor.removeEventListener("compositionend", onCompositionEnd);
			editor.removeEventListener("keydown", onKeyDown);
			unpop("CTX_MENU_POPUP");
			setView(null);
		};
	}, [active, editorRef]);

	const refresh = useCallback(() =>
	{
		refreshRef.current();
	}, []);
	const hide = useCallback(() =>
	{
		hideRef.current();
	}, []);
	return {
		view,
		refresh,
		hide,
	};
}
