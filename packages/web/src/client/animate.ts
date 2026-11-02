/** Upstream's slideDown/slideUp duration. */
const SLIDE_MS = 120;
/** Fallback for `transitionend` (the 120ms transition plus slack). */
const SLIDE_FALLBACK_MS = 220;

const OPEN =
{
	opacity: "1",
	transform: "scale(1, 1)",
};
const SHUT =
{
	opacity: "0",
	transform: "scale(0.2, 0)",
};
const BASE =
{
	transformOrigin: "0 0",
	willChange: "transform, opacity",
};
const TRANSITION =
{
	transition: `opacity ${SLIDE_MS}ms, transform ${SLIDE_MS}ms`,
};
const STYLE_KEYS = ["opacity", "transform", "transformOrigin", "willChange", "transition"] as const;
type SlideStyle = Record<(typeof STYLE_KEYS)[number], string>;

/** The slice of an element the slides touch; a fake in tests, `HTMLElement` in the app. */
export interface SlideElement
{
	style: Partial<SlideStyle>;
	addEventListener: (type: "transitionend", listener: (event: {target: unknown}) => void) => void;
	removeEventListener: (type: "transitionend", listener: (event: {target: unknown}) => void) => void;
	readonly offsetWidth?: number;
}

export interface SlideDeps
{
	raf: (cb: () => void) => void;
	setTimeout: (cb: () => void, ms: number) => void;
	reducedMotion: boolean;
}

/** The browser's frame scheduler, timers and the reduced-motion preference. */
export function browserSlideDeps(): SlideDeps
{
	return {
		raf: (cb) =>
		{
			requestAnimationFrame(cb);
		},
		setTimeout: (cb, ms) =>
		{
			globalThis.setTimeout(cb, ms);
		},
		reducedMotion: globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
	};
}

function setStyles(el: SlideElement, styles: Partial<SlideStyle>): void
{
	Object.assign(el.style, styles);
}

/** Remove the slide's inline styles: `""` clears a real `CSSStyleDeclaration`, `delete` a plain record. */
function clearStyles(el: SlideElement): void
{
	for (const key of STYLE_KEYS)
	{
		el.style[key] = "";
		Reflect.deleteProperty(el.style, key);
	}
}

/**
 * Transition `el` from `from` to `to` over 120ms, then clear the inline styles and call `onDone`. Finishes at once
 * under prefers-reduced-motion. The returned cancel clears the styles without calling `onDone`.
 */
function slide(
	el: SlideElement,
	from: Partial<SlideStyle>,
	to: Partial<SlideStyle>,
	deps: SlideDeps,
	onDone: () => void,
	leaveOrigin = false,
): () => void
{
	if (deps.reducedMotion)
	{
		onDone();
		return () =>
		{
		};
	}
	let active = true;
	const stop = () =>
	{
		active = false;
		el.removeEventListener("transitionend", handleEnd);
		clearStyles(el);
	};
	const finish = () =>
	{
		if (active)
		{
			stop();
			if (leaveOrigin)
			{
				// Upstream's expand leaves this one declaration behind on `.children`.
				el.style.transformOrigin = "0px 0px";
			}
			onDone();
		}
	};
	// A descendant's transition bubbles here too; only the slide's own ends it.
	function handleEnd(event: {target: unknown})
	{
		if (event.target === el)
		{
			finish();
		}
	}
	setStyles(
		el,
		{
			...from,
			...BASE,
		},
	);
	el.addEventListener("transitionend", handleEnd);
	deps.raf(() =>
	{
		if (!active)
		{
			return;
		}
		// Flush the starting styles so the browser transitions from them.
		void el.offsetWidth;
		setStyles(
			el,
			{
				...to,
				...TRANSITION,
			},
		);
		deps.setTimeout(finish, SLIDE_FALLBACK_MS);
	});
	return () =>
	{
		if (active)
		{
			stop();
		}
	};
}

/** Upstream's expand: `.children` grows from `scale(0.2, 0)` and fades in. */
export function slideDown(
	el: SlideElement,
	deps: SlideDeps,
	onDone: () => void = () =>
	{
	},
): () => void
{
	return slide(el, SHUT, OPEN, deps, onDone, true);
}

/** Upstream's collapse: `.children` shrinks to `scale(0.2, 0)` and fades out; `onDone` unmounts it. */
export function slideUp(el: SlideElement, deps: SlideDeps, onDone: () => void): () => void
{
	return slide(el, OPEN, SHUT, deps, onDone);
}
