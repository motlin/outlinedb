import type {MenuKeyboardState} from "../components/flyout/menu-keyboard.js";

/** Options of upstream's `WF.Suggest.for(range, opts)` that shape the chip's input handling. */
export interface SuggestOptions
{
	prefix: string;
	/** A typed space abandons the chip (`@`). */
	solid?: boolean;
	/** No results abandons the chip (`/`). */
	strict?: boolean;
	/** Any input abandons the chip. */
	unique?: boolean;
	chipClassName: string;
}

export interface SuggestInputInput
{
	chipText: string;
	inserted: string | null;
	deleting: boolean;
	composing: boolean;
	resultsEmpty: boolean;
	opts: SuggestOptions;
}

export type SuggestInputAction = "update" | "abandon";

/** What an input inside an armed chip does, in upstream's `VY.input` order. */
export function suggestInputAction({
	chipText,
	inserted,
	deleting,
	composing,
	resultsEmpty,
	opts,
}: SuggestInputInput): SuggestInputAction
{
	if (composing)
	{
		return "update";
	}
	if (opts.unique === true)
	{
		return "abandon";
	}
	if (opts.solid === true && inserted === " ")
	{
		return "abandon";
	}
	if (deleting && !chipText.trimStart().startsWith(opts.prefix))
	{
		return "abandon";
	}
	if (opts.strict === true && resultsEmpty)
	{
		return "abandon";
	}
	return "update";
}

/** Upstream `propping`: any character other than space, `\n`, `\r` or `\t`; a missing neighbor is not propping. */
export function isPropping(ch: string | undefined): boolean
{
	return ch !== undefined && !/[ \n\r\t]/u.test(ch);
}

export interface SuggestKeyInput
{
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	/** The caret sits at the end of the chip. */
	caretAtChipEnd: boolean;
}

/**
 * `abandon` disarms and replaces the chip with plain text; `disarmNoAbandon` (Cmd/Ctrl+Z) removes the chip
 * and its text and swallows the key.
 */
export type SuggestKeyAction = "down" | "up" | "select" | "abandon" | "disarmNoAbandon";

/** Upstream chip-popup keydown mapping; `null` leaves the key to the editor. */
export function suggestKeyAction({key, ctrlKey, metaKey, caretAtChipEnd}: SuggestKeyInput): SuggestKeyAction | null
{
	if (ctrlKey || metaKey)
	{
		if (key === "z" || key === "Z")
		{
			return "disarmNoAbandon";
		}
		if (ctrlKey && !metaKey)
		{
			if (key === "n")
			{
				return "down";
			}
			if (key === "p")
			{
				return "up";
			}
		}
		return null;
	}
	switch (key)
	{
		case "ArrowDown":
			return "down";
		case "ArrowUp":
			return "up";
		case "Enter":
		case "Tab":
			return "select";
		case "Escape":
			return "abandon";
		case "ArrowRight":
			return caretAtChipEnd ? "abandon" : null;
		default:
			return null;
	}
}

export type SuggestModeEvent =
	|
	  {
			type: "mouseMove";
	  }
	|
	  {
			type: "hover";
			index: number;
	  };

/**
 * Any `mousemove` over the scroller drops keyboard mode (no `active` row, every row `canHover`);
 * hovering a row then sets the index so the next arrow key continues from it.
 */
export function suggestMode(state: MenuKeyboardState, event: SuggestModeEvent): MenuKeyboardState
{
	if (event.type === "mouseMove")
	{
		return {
			...state,
			keyboardMode: false,
		};
	}
	return {
		...state,
		index: event.index,
		keyboardMode: false,
	};
}
