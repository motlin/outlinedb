import type {Command} from "./keys/dispatch.js";

export type SwitcherStep = "next" | "prev";

export type SwitcherKeyAction = SwitcherStep | "enter" | "close";

export interface SwitcherKeyEvent
{
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}

/**
 * Upstream's switcher input keys: Enter navigates, Up/Down (and the Emacs Ctrl+P/Ctrl+N on mac) step the
 * wrapping selection, Escape closes. Anything else is typing.
 */
export function switcherKeyAction(
	{key, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false}: SwitcherKeyEvent,
	isMac: boolean,
): SwitcherKeyAction | null
{
	switch (key)
	{
		case "ArrowDown":
		{
			return "next";
		}
		case "ArrowUp":
		{
			return "prev";
		}
		case "Enter":
		{
			return "enter";
		}
		case "Escape":
		{
			return "close";
		}
	}
	const emacs = isMac && ctrlKey && !metaKey && !altKey && !shiftKey;
	if (emacs && key === "n")
	{
		return "next";
	}
	if (emacs && key === "p")
	{
		return "prev";
	}
	return null;
}

/** The selected row after one step, wrapping at both ends; 0 with no rows. */
export function stepSelection(selected: number, count: number, step: SwitcherStep): number
{
	if (count === 0)
	{
		return 0;
	}
	return step === "next" ? (selected + 1) % count : selected <= 0 ? count - 1 : selected - 1;
}

/** Upstream loads the next page once the dialog scrolls within this many pixels of its bottom. */
const LOAD_MORE_THRESHOLD_PX = 300;

export interface ScrollMetrics
{
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export function nearScrollEnd({scrollTop, scrollHeight, clientHeight}: ScrollMetrics): boolean
{
	return scrollHeight - scrollTop - clientHeight < LOAD_MORE_THRESHOLD_PX;
}

type StepListener = (step: SwitcherStep) => void;

const stepListeners = new Set<StepListener>();

/** The open switcher subscribes here to hear the global Cmd+; / Cmd+Shift+; steps. */
export function onSwitcherStep(listener: StepListener): () => void
{
	stepListeners.add(listener);
	return () =>
	{
		stepListeners.delete(listener);
	};
}

export function emitSwitcherStep(step: SwitcherStep): void
{
	for (const listener of stepListeners)
	{
		listener(step);
	}
}

/** Upstream's `_select_next_in_switcher` / `_select_prev_in_switcher`: open the switcher when closed, else step it. */
export function switcherStepCommand(step: SwitcherStep, isOpen: () => boolean, open: () => void): Command
{
	return {
		execute()
		{
			if (isOpen())
			{
				emitSwitcherStep(step);
			}
			else
			{
				open();
			}
		},
	};
}

export type SwitcherCommandAction = "none" | "open";

/** Upstream's `show_switcher` only opens: with the switcher open it changes nothing. */
export function switcherCommandAction(isOpen: boolean): SwitcherCommandAction
{
	return isOpen ? "none" : "open";
}
