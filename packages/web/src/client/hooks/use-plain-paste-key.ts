import {useEffect, useRef} from "react";
import type {RefObject} from "react";

/** ⌘⇧V (Paste and Match Style) is told apart by the last keydown, since the paste event does not say. */
export function usePlainPasteKey(): RefObject<boolean>
{
	const plain = useRef(false);
	useEffect(() =>
	{
		const down = (event: KeyboardEvent): void =>
		{
			plain.current = event.metaKey && event.shiftKey && event.code === "KeyV";
		};
		const up = (): void =>
		{
			plain.current = false;
		};
		document.addEventListener("keydown", down, true);
		document.addEventListener("keyup", up, true);
		return () =>
		{
			document.removeEventListener("keydown", down, true);
			document.removeEventListener("keyup", up, true);
		};
	}, []);
	return plain;
}
