/** The modifier shape of a click that may open a pane. */
export interface PaneClickEvent
{
	button: number;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/**
 * Upstream's modifier test for pane-opening clicks (`bj4`): "open" is a left click with ⌥ alone or the platform's
 * primary modifier alone (⌘ on mac, ⌃ elsewhere) and no ⇧; "plain" is a left click with no modifiers.
 */
export function paneClickModifier(event: PaneClickEvent, isMac: boolean): "open" | "plain" | "other"
{
	if (event.button !== 0)
	{
		return "other";
	}
	const alt = event.altKey && !event.ctrlKey && !event.metaKey;
	const primary = isMac
		? event.metaKey && !event.altKey && !event.ctrlKey
		: event.ctrlKey && !event.altKey && !event.metaKey;
	if (!event.shiftKey && (alt || primary))
	{
		return "open";
	}
	return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ? "other" : "plain";
}
