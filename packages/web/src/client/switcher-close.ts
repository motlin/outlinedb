/** Where the caret sat when the jump menu opened. */
export interface SwitcherReturn
{
	nodeId: string;
	caretOffset: number;
}

/** Esc, scrim and close-icon cancel; Enter and row clicks navigate. */
export type SwitcherCloseMode = "cancel" | "navigate";

export interface SwitcherCloseResult
{
	open: false;
	/** The caret to restore, or null to leave nothing focused. */
	restore: SwitcherReturn | null;
}

/**
 * Upstream's switcher close: cancelling restores the caret saved at open (nothing saved, nothing focused);
 * navigating drops it, since the destination places its own caret.
 */
export function closeSwitcher(
	state:
	{
		open: boolean;
		saved: SwitcherReturn | null;
	},
	mode: SwitcherCloseMode,
): SwitcherCloseResult
{
	return {
		open: false,
		restore: mode === "cancel" ? state.saved : null,
	};
}
