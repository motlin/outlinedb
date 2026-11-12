/** The slice of a keydown event the Escape claim reads; both DOM and React keyboard events fit. */
interface EscapeKeyEvent
{
	key: string;
	preventDefault(): void;
}

/**
 * Dialogs and pickers swallow Escape: it only closes them. (Upstream's ButtonMenu does not: Escape reaches the global
 * handler, which focuses search and so blurs the menu closed; see `ButtonMenu`.) `useSearchEscape` runs on `window` and skips
 * claimed (defaultPrevented) events, so a popup that closes on Escape must claim the key or the same press would
 * also focus search. `close` reports whether it closed anything; only then is the key claimed.
 */
export function claimEscape(event: EscapeKeyEvent, close: () => boolean): void
{
	if (event.key === "Escape" && close())
	{
		event.preventDefault();
	}
}

/** A keydown listener that closes an open popup on Escape and claims the key. */
export function closeOnEscape(close: () => void): (event: EscapeKeyEvent) => void
{
	return (event) =>
	{
		claimEscape(event, () =>
		{
			close();
			return true;
		});
	};
}
