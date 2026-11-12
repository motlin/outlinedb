import {useEffect, useRef} from "react";
import {useLocation} from "react-router-dom";

/**
 * Close a flyout once the router location moves away from where it opened,
 * the way upstream's flyouts close on location change. Call it from the
 * flyout itself, so each mount remembers the location it opened at.
 */
export function useCloseOnLocationChange(close: () => void): void
{
	const {key} = useLocation();
	const openedAt = useRef(key);
	useEffect(() =>
	{
		if (key !== openedAt.current)
		{
			close();
		}
	}, [key, close]);
}
