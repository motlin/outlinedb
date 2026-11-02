import {useEffect} from "react";
import {IS_MOBILE} from "../is-mobile.js";
import {useOutlineStore} from "../stores/outline.js";
import {createZenController, scrollCounts} from "../zen-mode.js";
import type {LeftBarMode} from "../stores/outline.js";

const EDITOR_SELECTOR = '.project [contenteditable="true"], .project [contenteditable=""]';

let leftModeBeforeZen: LeftBarMode = "drawerClosed";

/** Upstream's `zen_mode`: in memory only, so a reload leaves it. Not persisted, and the bars' stored modes stay put. */
function createZen()
{
	return createZenController(
		{
			body: document.body.classList,
			getLeftOpen: () => useOutlineStore.getState().leftBarMode !== "drawerClosed",
			setLeftOpen: (open) =>
			{
				const {leftBarMode} = useOutlineStore.getState();
				if (open)
				{
					useOutlineStore.setState(
						{
							leftBarMode: leftModeBeforeZen,
						},
					);
				}
				else
				{
					leftModeBeforeZen = leftBarMode;
					useOutlineStore.setState(
						{
							leftBarMode: "drawerClosed",
							leftBarHovered: false,
							leftBarDrop: null,
						},
					);
				}
			},
			getRightOpen: () => !useOutlineStore.getState().rightBarCollapsed,
			setRightOpen: (open) =>
			{
				useOutlineStore.setState(
					{
						rightBarCollapsed: !open,
					},
				);
			},
			raf: (callback) => requestAnimationFrame(callback),
			cancelRaf: (handle) =>
			{
				cancelAnimationFrame(handle);
			},
			now: () => Date.now(),
			reveal: (target) =>
			{
				if (target instanceof Element)
				{
					target.scrollIntoView(
						{
							block: "center",
							inline: "nearest",
							behavior: "auto",
						},
					);
				}
			},
			activeElement: () => document.activeElement,
			isEditorFocused: () => document.activeElement?.matches(EDITOR_SELECTOR) === true,
		},
	);
}

let zenController: ReturnType<typeof createZenController> | undefined;

/** Built on first use: the body does not exist when this module loads under test. */
function zenMode()
{
	zenController ??= createZen();
	return zenController;
}

function focusRow(element: Element | null): void
{
	const row = element?.closest(".project");
	if (row === null || row === undefined)
	{
		return;
	}
	zenMode().onFocusRow(row, element?.closest(".name, .notes") ?? element ?? row);
}

/** The `zen_mode` command ("Toggle Zen Mode"): desktop only, like upstream's `available()`. */
export function toggleZenMode(): void
{
	if (IS_MOBILE)
	{
		return;
	}
	zenMode().toggle();
	if (zenMode().isOn())
	{
		const active = document.activeElement;
		if (active?.matches(EDITOR_SELECTOR) === true)
		{
			focusRow(active);
		}
	}
}

/** Mounts the listeners upstream registers once at boot; each does nothing while zen is off. */
export function useZenModeListeners(): void
{
	useEffect(() =>
	{
		const onFocusIn = (event: FocusEvent) =>
		{
			if (event.target instanceof Element && event.target.matches(EDITOR_SELECTOR))
			{
				focusRow(event.target);
			}
		};
		const onFocusOut = (event: FocusEvent) =>
		{
			if (event.target instanceof Element && event.target.matches(EDITOR_SELECTOR))
			{
				zenMode().onBlur();
			}
		};
		const onScroll = (event: Event) =>
		{
			const target = event.target instanceof Element ? event.target : null;
			if (event.target === document || scrollCounts(target))
			{
				zenMode().onScroll();
			}
		};
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		document.addEventListener("scroll", onScroll, true);
		return () =>
		{
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("scroll", onScroll, true);
			zenMode().exit();
		};
	}, []);
}
