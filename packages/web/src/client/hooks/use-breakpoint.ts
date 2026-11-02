import {useEffect, useState} from "react";

/** Upstream's load-time check: innerWidth less a 15px scrollbar allowance. */
export function initialBreakpoint(
	win:
	{
		innerWidth: number;
	},
	min: number,
): boolean
{
	return win.innerWidth - 15 >= min;
}

/** Upstream's resize-time check: the body's clientWidth (scrollbar excluded). */
export function resizedBreakpoint(
	body:
	{
		clientWidth: number;
	},
	min: number,
): boolean
{
	return body.clientWidth >= min;
}

/** Upstream's `WF.DomResponsive.useBreakpoint`; note the load (innerWidth - 15) vs resize (clientWidth) asymmetry. */
export function useBreakpoint(min: number): boolean
{
	const [matches, setMatches] = useState(() => initialBreakpoint(window, min));
	useEffect(() =>
	{
		const onResize = () =>
		{
			setMatches(resizedBreakpoint(document.body, min));
		};
		window.addEventListener("resize", onResize);
		return () =>
		{
			window.removeEventListener("resize", onResize);
		};
	}, [min]);
	return matches;
}
