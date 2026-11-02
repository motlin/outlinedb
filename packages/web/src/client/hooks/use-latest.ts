import {useLayoutEffect, useRef} from "react";
import type {RefObject} from "react";

/**
 * A ref that always holds the latest `value`, so a memo or effect can call it without depending on its identity
 * (a fresh callback each render would otherwise rebuild the memo and re-run the effect every render).
 */
export function useLatest<T>(value: T): RefObject<T>
{
	const ref = useRef(value);
	useLayoutEffect(() =>
	{
		ref.current = value;
	}, [value]);
	return ref;
}
