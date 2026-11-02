/** Upstream's zen mode (`zen_mode` command): hides the header, dims every row but the focused one. */
export const ZEN = "zen-mode";
export const ZEN_FOCUSED = "zen-mode--focused";
export const ZEN_CURRENT = "zen-mode-current";

/** After a centring scroll, scroll events within this window are our own. */
const IGNORE_SCROLL_MS = 250;

interface ClassListLike
{
	add(name: string): void;
	remove(name: string): void;
	contains(name: string): boolean;
}

export interface ZenDeps
{
	body: ClassListLike;
	getLeftOpen: () => boolean;
	setLeftOpen: (open: boolean) => void;
	getRightOpen: () => boolean;
	setRightOpen: (open: boolean) => void;
	raf: (callback: () => void) => number;
	cancelRaf: (handle: number) => void;
	now: () => number;
	/** Upstream's `WF.Scroll.reveal(target, {block: "center", inline: "nearest", behavior: "auto"})`. */
	reveal: (target: object) => void;
	activeElement: () => object | null;
	isEditorFocused: () => boolean;
}

interface RowElement
{
	classList: ClassListLike;
}

interface RevealTarget
{
	isConnected: boolean;
	contains(other: object | null): boolean;
}

export interface ZenController
{
	isOn(): boolean;
	toggle(): void;
	exit(): void;
	onFocusRow(row: RowElement, target: RevealTarget): void;
	onBlur(): void;
	onScroll(): void;
}

export function createZenController(deps: ZenDeps): ZenController
{
	let on = false;
	let snapshot =
	{
		left: false,
		right: false,
	};
	let current: RowElement | null = null;
	let pending: number | null = null;
	let ignoreScrollUntil = 0;

	const cancel = () =>
	{
		if (pending !== null)
		{
			deps.cancelRaf(pending);
			pending = null;
		}
	};
	const clearCurrent = () =>
	{
		current?.classList.remove(ZEN_CURRENT);
		current = null;
	};
	const unfocus = () =>
	{
		deps.body.remove(ZEN_FOCUSED);
		clearCurrent();
		cancel();
	};

	const enter = () =>
	{
		on = true;
		snapshot =
		{
			left: deps.getLeftOpen(),
			right: deps.getRightOpen(),
		};
		deps.body.add(ZEN);
		if (snapshot.left)
		{
			deps.setLeftOpen(false);
		}
		if (snapshot.right)
		{
			deps.setRightOpen(false);
		}
	};

	const exit = () =>
	{
		if (!on)
		{
			return;
		}
		on = false;
		deps.body.remove(ZEN);
		unfocus();
		if (deps.getLeftOpen() !== snapshot.left)
		{
			deps.setLeftOpen(snapshot.left);
		}
		if (deps.getRightOpen() !== snapshot.right)
		{
			deps.setRightOpen(snapshot.right);
		}
	};

	return {
		isOn: () => on,
		exit,
		toggle()
		{
			if (on)
			{
				exit();
			}
			else
			{
				enter();
			}
		},
		onFocusRow(row, target)
		{
			if (!on)
			{
				return;
			}
			deps.body.add(ZEN_FOCUSED);
			if (current !== row)
			{
				current?.classList.remove(ZEN_CURRENT);
				row.classList.add(ZEN_CURRENT);
				current = row;
			}
			cancel();
			pending = deps.raf(() =>
			{
				pending = null;
				if (
					!on ||
					!deps.body.contains(ZEN_FOCUSED) ||
					!target.isConnected ||
					!target.contains(deps.activeElement())
				)
				{
					return;
				}
				ignoreScrollUntil = deps.now() + IGNORE_SCROLL_MS;
				deps.reveal(target);
			});
		},
		onBlur()
		{
			if (!on)
			{
				return;
			}
			cancel();
			pending = deps.raf(() =>
			{
				pending = null;
				if (on && !deps.isEditorFocused())
				{
					unfocus();
				}
			});
		},
		onScroll()
		{
			if (!on || deps.now() < ignoreScrollUntil)
			{
				return;
			}
			unfocus();
		},
	};
}

interface ScrollTargetLike
{
	closest?: (selector: string) => unknown;
	querySelector?: (selector: string) => unknown;
	tagName?: string;
}

/**
 * Whether a scroll on `target` is the user leaving the focused row: the document, body or html, anything inside a
 * `.project`, or a `.vertical-scrollable-container` holding `.project`s (a pane's scroller).
 */
export function scrollCounts(target: ScrollTargetLike | null): boolean
{
	if (target?.closest === undefined)
	{
		return true;
	}
	if (target.tagName === "BODY" || target.tagName === "HTML")
	{
		return true;
	}
	if (target.closest(".project") !== null)
	{
		return true;
	}
	return (
		target.closest(".vertical-scrollable-container") !== null &&
		target.querySelector?.(".project") !== null &&
		target.querySelector?.(".project") !== undefined
	);
}
