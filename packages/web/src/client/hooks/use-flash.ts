import {useCallback, useEffect, useRef, useState} from "react";

/** Upstream `WF.DomReact.useFlash`: `flash()` turns the flag on for `ms`, and calling it again restarts the timer. */
export function useFlash(ms = 2000): [boolean, () => void]
{
	const [flashing, setFlashing] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(
		() => () =>
		{
			window.clearTimeout(timer.current);
		},
		[],
	);
	const flash = useCallback(() =>
	{
		setFlashing(true);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() =>
		{
			setFlashing(false);
		}, ms);
	}, [ms]);
	return [flashing, flash];
}
