import type {InlineAttr} from "./rich-text.js";

/** The modifier and key fields of a keydown that the editor classifier reads. */
export interface EditorKeyEvent
{
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/** Upstream's editor key actions (I7). */
export type EditorKeyAction =
	| "RETURN"
	| "SHIFT_RETURN"
	| "SUPER_RETURN"
	| "CARRIAGE_RETURN"
	| "DELETE_BACKWARD"
	| "DELETE_FORWARD"
	| "CARET_UP"
	| "CARET_DOWN"
	| "CARET_LEFT"
	| "CARET_RIGHT"
	| "SELECT_UP"
	| "SELECT_DOWN"
	| "SELECT_ALL";

const PLAIN_KEYS: Readonly<Record<string, EditorKeyAction>> =
{
	Enter: "RETURN",
	Backspace: "DELETE_BACKWARD",
	Delete: "DELETE_FORWARD",
	ArrowUp: "CARET_UP",
	ArrowDown: "CARET_DOWN",
	ArrowLeft: "CARET_LEFT",
	ArrowRight: "CARET_RIGHT",
};

/** Emacs-style control bindings macOS text fields honor. */
const MAC_CTRL_KEYS: Readonly<Record<string, EditorKeyAction>> =
{
	h: "DELETE_BACKWARD",
	d: "DELETE_FORWARD",
	p: "CARET_UP",
	n: "CARET_DOWN",
};

const SHIFT_KEYS: Readonly<Record<string, EditorKeyAction>> =
{
	Enter: "SHIFT_RETURN",
	ArrowUp: "SELECT_UP",
	ArrowDown: "SELECT_DOWN",
};

/** Classify a keydown the way upstream's editor does, or null when the editor has no action for it. */
export function classifyEditorKey(event: EditorKeyEvent, isMac: boolean): EditorKeyAction | null
{
	const {key, metaKey, ctrlKey, altKey, shiftKey} = event;
	if (key === "Enter" && (altKey || (ctrlKey && shiftKey)))
	{
		return "CARRIAGE_RETURN";
	}
	if (altKey)
	{
		return null;
	}
	const mod = isMac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
	if (mod && !shiftKey)
	{
		if (key === "Enter")
		{
			return "SUPER_RETURN";
		}
		if (key === "a")
		{
			return "SELECT_ALL";
		}
		return null;
	}
	if (metaKey || (ctrlKey && !isMac))
	{
		return null;
	}
	if (ctrlKey)
	{
		return shiftKey ? null : (MAC_CTRL_KEYS[key] ?? null);
	}
	if (shiftKey)
	{
		return SHIFT_KEYS[key] ?? null;
	}
	return PLAIN_KEYS[key] ?? null;
}

const FORMAT_CODES: Readonly<Record<string, InlineAttr>> =
{
	KeyB: "b",
	KeyI: "i",
	KeyU: "u",
};
const SHIFT_FORMAT_CODES: Readonly<Record<string, InlineAttr>> =
{
	KeyX: "s",
	KeyC: "code",
};

/**
 * Upstream's format shortcuts (⌘B/⌘I/⌘U, ⇧⌘X strikethrough, ⇧⌘C inline code; Ctrl off mac), matched on the
 * physical `code` so keyboard layouts never change them. Null for any other keystroke.
 */
export function classifyFormatKey(
	event: EditorKeyEvent &
	{
		code: string;
	},
	isMac: boolean,
): InlineAttr | null
{
	const {code, metaKey, ctrlKey, altKey, shiftKey} = event;
	const mod = isMac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
	if (!mod || altKey)
	{
		return null;
	}
	return (shiftKey ? SHIFT_FORMAT_CODES[code] : FORMAT_CODES[code]) ?? null;
}

/** ⇧⌘H (Ctrl off mac), upstream's `highlight_selected`: reapply the latest text color or highlight. */
export function isHighlightKey(
	event: EditorKeyEvent &
	{
		code: string;
	},
	isMac: boolean,
): boolean
{
	const {code, metaKey, ctrlKey, altKey, shiftKey} = event;
	const mod = isMac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
	return mod && shiftKey && !altKey && code === "KeyH";
}

/** Whether the browser runs on an Apple platform, where the editor's mod key is meta. */
export function isMacPlatform(): boolean
{
	return typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);
}
