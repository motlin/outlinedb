import {useEffect, useState} from "react";
import type {RefObject} from "react";

/** How long the container waits after mounting or resizing before it measures itself. */
export const RESIZE_DEBOUNCE_MS = 200;

function initialWindowWidth(): number
{
	return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
}

/** Upstream GuiCrumbs tracks the container's `[left, width]` through a ResizeObserver debounced by 200ms. */
export function useContainerRect(ref: RefObject<HTMLDivElement | null>): [number, number]
{
	const [rect, setRect] = useState<[number, number]>(() => [0, initialWindowWidth()]);
	useEffect(() =>
	{
		const element = ref.current;
		if (!element)
		{
			return () =>
			{
			};
		}
		let timer: number | undefined;
		const schedule = () =>
		{
			if (timer !== undefined)
			{
				return;
			}
			timer = window.setTimeout(() =>
			{
				const {left, width} = element.getBoundingClientRect();
				setRect([left, width]);
				timer = undefined;
			}, RESIZE_DEBOUNCE_MS);
		};
		schedule();
		const observer = new ResizeObserver(schedule);
		observer.observe(element);
		return () =>
		{
			window.clearTimeout(timer);
			observer.disconnect();
		};
	}, [ref]);
	return rect;
}

/** Upstream GuiCrumbs tracks `document.body.clientWidth` on window resize, starting from `innerWidth`. */
export function useWindowWidth(): number
{
	const [width, setWidth] = useState(initialWindowWidth);
	useEffect(() =>
	{
		const onResize = () =>
		{
			setWidth(document.body.clientWidth);
		};
		window.addEventListener("resize", onResize);
		return () =>
		{
			window.removeEventListener("resize", onResize);
		};
	}, []);
	return width;
}
