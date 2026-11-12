/** Upstream's zoom transition length. */
export const ZOOM_MS = 200;
/** Fallback for the animations' finish, should one never settle. */
const ANIMATION_FALLBACK_MS = 300;
/** The body class upstream's `[.item--zooming-in-progress_&]` utilities key on. */
export const ZOOMING_CLASS = "item--zooming-in-progress";

export interface Offset
{
	dx: number;
	dy: number;
}

/**
 * Upstream's moveBullets offset from the moving row `L` to the other row `b`: the bullet indent (36px) comes off
 * the horizontal distance and the title's drop (20px) is added to the vertical one.
 */
export function zoomOffset(
	from:
	{
		left: number;
		top: number;
	},
	to:
	{
		left: number;
		top: number;
	},
): Offset
{
	return {
		dx: to.left - from.left - 36,
		dy: to.top - from.top + 20,
	};
}

/** Upstream skips the zoom animation on mobile, when either side is a board, and under reduced motion. */
export function zoomAnimationAllowed(env: {mobile: boolean; board: boolean; reducedMotion: boolean}): boolean
{
	return !env.mobile && !env.board && !env.reducedMotion;
}

interface Look
{
	opacity: string;
	transform: string;
}

interface Phase
{
	from: Look;
	to: Look;
}

export interface ZoomPhases
{
	/** The moving row's `.name` and `.notes`. */
	row: Phase;
	/** The moving row's child rows. */
	children: Phase;
	/** The rows beside the moving row, off the zoom path. */
	siblings: Phase;
	/** The title row's `.name`. */
	title: Phase;
}

/**
 * Each element group's start and end look for a zoom in or out, as upstream's moveBullets transitions them (measured
 * on workflowy.com): zooming in slides everything by the offset, fading all but the moving row's children; zooming out
 * plays zooming in backwards.
 */
export function zoomPhases(isOut: boolean, {dx, dy}: Offset): ZoomPhases
{
	const shown: Look =
	{
		opacity: "1",
		transform: "",
	};
	const translate = `translate(${dx}px, ${dy}px)`;
	const away: Look =
	{
		opacity: "0",
		transform: translate,
	};
	const carried: Look =
	{
		opacity: "1",
		transform: translate,
	};
	const phase = (inFrom: Look, inTo: Look): Phase =>
		isOut
			?
				{
					from: inTo,
					to: inFrom,
				}
			:
				{
					from: inFrom,
					to: inTo,
				};
	return {
		row: phase(shown, away),
		children: phase(shown, carried),
		siblings: phase(shown, away),
		title: phase(shown, away),
	};
}

/** Which font a crossfade clone of the moving row's text copies: the row's or the title's. */
export type CloneStyle = "row" | "title";

export interface CloneStep extends Phase
{
	style: CloneStyle;
}

/**
 * Upstream's crossfade of the moving row's text: two clones anchored on the row's text, one in the row's font and one
 * in the title's, both sliding by `to` (the row's text to the title's) and scaling so each matches the other's size at
 * the far end. The clone in the source's font sits underneath and fades out; the clone in the destination's font stays
 * opaque on top. In append order (later on top).
 */
export function crossfadeClones(
	isOut: boolean,
	to:
	{
		x: number;
		y: number;
	},
	rowFont: number,
	titleFont: number,
): CloneStep[]
{
	const translate = `translate(${to.x}px, ${to.y}px)`;
	const row =
	{
		atRow: "",
		atTitle: `${translate} scale(${titleFont / rowFont})`,
	};
	const title =
	{
		atRow: `scale(${rowFont / titleFont})`,
		atTitle: translate,
	};
	const step = (
		style: CloneStyle,
		at:
		{
			atRow: string;
			atTitle: string;
		},
		fades: boolean,
	): CloneStep =>
	{
		const start: Look =
		{
			opacity: "1",
			transform: isOut ? at.atTitle : at.atRow,
		};
		const end: Look =
		{
			opacity: fades ? "0" : "1",
			transform: isOut ? at.atRow : at.atTitle,
		};
		return {
			style,
			from: start,
			to: end,
		};
	};
	return isOut
		? [step("title", title, true), step("row", row, false)]
		: [step("row", row, true), step("title", title, false)];
}

interface AnimateZoomInput
{
	isOut: boolean;
	/** The moving row `L`: the target row when zooming in, the row zoomed out of when zooming out. */
	rowEl: HTMLElement;
	/** The other row `b`: the title row. */
	otherEl: HTMLElement;
	childEls: HTMLElement[];
}

const CLONE_FONT_PROPS = [
	"font-size",
	"font-family",
	"font-weight",
	"font-style",
	"color",
	"letter-spacing",
	"line-height",
] as const;

function nameContent(row: HTMLElement): HTMLElement | null
{
	return row.querySelector<HTMLElement>(":scope > .name > .content");
}

/**
 * A copy of the moving row's `.name > .content` on `<body>`, positioned over it with `fontOf`'s font copied inline
 * and at most `fontOf`'s width.
 */
function contentClone(content: HTMLElement, fontOf: HTMLElement): HTMLElement
{
	const rect = content.getBoundingClientRect();
	const computed = getComputedStyle(fontOf);
	const clone = content.cloneNode(true);
	if (!(clone instanceof HTMLElement))
	{
		throw new TypeError("cloned content is not an element");
	}
	for (const prop of CLONE_FONT_PROPS)
	{
		clone.style.setProperty(prop, computed.getPropertyValue(prop));
	}
	Object.assign(
		clone.style,
		{
			maxWidth: `${fontOf.getBoundingClientRect().width}px`,
			padding: "0",
			margin: "0",
			zIndex: "1000",
			position: "absolute",
			left: `${rect.left + globalThis.scrollX}px`,
			top: `${rect.top + globalThis.scrollY}px`,
			transformOrigin: "0 20%",
			pointerEvents: "none",
		},
	);
	document.body.append(clone);
	return clone;
}

/** The part of an element `play` uses: the Web Animations `animate`. */
export interface Animatable
{
	animate: (
		keyframes: Keyframe[],
		options: KeyframeAnimationOptions,
	) =>
	{
		finished: Promise<unknown>;
		cancel: () => void;
	};
}

interface Step
{
	el: Animatable;
	from: Look;
	to: Look;
}

function keyframe({opacity, transform}: Look): Keyframe
{
	return {
		opacity,
		transform: transform === "" ? "none" : transform,
	};
}

async function delay(ms: number): Promise<void>
{
	return new Promise((resolve) =>
	{
		setTimeout(resolve, ms);
	});
}

/**
 * Animate every element from its start look to its end look, holding the end look until the animations settle,
 * then cancel them. Web Animations, unlike CSS transitions, fire no `transitionend` for React's root listener to
 * dispatch once per animated row. The animations finish inside a frame's rendering update, so the settle waits for
 * a task of its own: work awaiting it (the zoom swap mounting the new view) then renders in the next frame instead of
 * sharing one task with this frame's style, layout and paint, with the end look held meanwhile.
 */
export async function play(steps: Step[]): Promise<void>
{
	const animations = steps.map(({el, from, to}) =>
		el.animate(
			[keyframe(from), keyframe(to)],
			{
				duration: ZOOM_MS,
				easing: "ease",
				fill: "forwards",
			},
		),
	);
	try
	{
		await Promise.race([
			Promise.allSettled(animations.map(async (animation) => animation.finished)),
			delay(ANIMATION_FALLBACK_MS),
		]);
		await delay(0);
	}
	finally
	{
		for (const animation of animations)
		{
			animation.cancel();
		}
	}
}

/**
 * Upstream's zoom animation, in parallel: a crossfade of two clones of the moving row's `.name > .content` (see
 * `crossfadeClones`) sliding between its row and the title, and moveBullets (see `zoomPhases`). The moving row's
 * real text is hidden meanwhile; every animation and clone is cleared afterwards.
 */
async function animateZoom({isOut, rowEl, otherEl, childEls}: AnimateZoomInput): Promise<void>
{
	const rowName = rowEl.querySelector<HTMLElement>(":scope > .name");
	const titleName = otherEl.querySelector<HTMLElement>(":scope > .name");
	const rowContent = nameContent(rowEl);
	const titleContent = nameContent(otherEl);
	if (rowName === null || titleName === null || rowContent === null || titleContent === null)
	{
		return;
	}
	// The rows' own boxes, not their `.name`s: a `.name` spans out to the left by a margin that differs between the
	// title and a row, which would slide everything sideways.
	const phases = zoomPhases(isOut, zoomOffset(rowEl.getBoundingClientRect(), otherEl.getBoundingClientRect()));

	const rowRect = rowContent.getBoundingClientRect();
	const titleRect = titleContent.getBoundingClientRect();
	const rowFont = Number(getComputedStyle(rowContent).fontSize.replace("px", "")) || 16;
	const titleFont = Number(getComputedStyle(titleContent).fontSize.replace("px", "")) || rowFont;
	const clones = crossfadeClones(
		isOut,
		{
			x: titleRect.left - rowRect.left,
			y: titleRect.top - rowRect.top,
		},
		rowFont,
		titleFont,
	).map((clone) => (
	{
		...clone,
		el: contentClone(rowContent, clone.style === "row" ? rowContent : titleContent),
	}));
	rowContent.style.visibility = "hidden";

	const rowParts = [rowName, rowEl.querySelector<HTMLElement>(":scope > .notes")].filter(
		(el): el is HTMLElement => el !== null,
	);
	const siblings = [...(rowEl.parentElement?.children ?? [])].filter(
		(el): el is HTMLElement => el instanceof HTMLElement && el !== rowEl && el.classList.contains("project"),
	);
	const steps: Step[] = [
		...clones.map(({el, from, to}) => (
		{
			el,
			from,
			to,
		})),
		{
			el: titleName,
			...phases.title,
		},
		...rowParts.map((el) => (
		{
			el,
			...phases.row,
		})),
		...childEls.map((el) => (
		{
			el,
			...phases.children,
		})),
		...siblings.map((el) => (
		{
			el,
			...phases.siblings,
		})),
	];
	try
	{
		await play(steps);
	}
	finally
	{
		for (const {el} of clones)
		{
			el.remove();
		}
		rowContent.style.visibility = "";
	}
}

/** The outline row showing `nodeId` (its `.project`), or null when it is not rendered. */
function zoomRowElement(nodeId: string): HTMLElement | null
{
	const bullet = document.querySelector(`.project > .name > a.bullet[data-item-id="${CSS.escape(nodeId)}"]`);
	return bullet?.closest<HTMLElement>(".project") ?? null;
}

/** The zoom root's title row. */
function zoomTitleElement(): HTMLElement | null
{
	return document.querySelector<HTMLElement>(".project.root");
}

/** Whether this browser should play the zoom animation; `board` says if either side is a board. */
export function zoomAnimationEnabled(board: boolean): boolean
{
	return zoomAnimationAllowed(
		{
			mobile: document.body.classList.contains("is-mobile"),
			board,
			reducedMotion: globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
		},
	);
}

/**
 * Play the zoom animation between `rowId`'s row and the title. Does nothing when either row is not rendered. The
 * caller owns the body's zooming class, since zooming in keeps it until the new view is pushed.
 */
export async function runZoomAnimation(isOut: boolean, rowId: string): Promise<void>
{
	const rowEl = zoomRowElement(rowId);
	const otherEl = zoomTitleElement();
	if (rowEl === null || otherEl === null)
	{
		return;
	}
	const childEls = [...rowEl.querySelectorAll<HTMLElement>(":scope > .children > .project")];
	await animateZoom(
		{
			isOut,
			rowEl,
			otherEl,
			childEls,
		},
	);
}

/** Upstream's 300ms fallback, in frames: how long a zoom out waits for the new view to render the row. */
const ROW_WAIT_FRAMES = 18;

/** Resolve once `nodeId`'s row is rendered (a just-navigated view mounts a few frames later), or after ~300ms. */
export async function waitForZoomRow(nodeId: string): Promise<void>
{
	await waitForAnyZoomRow([nodeId]);
}

/**
 * The first of `nodeIds` whose row is rendered, once any is (a just-navigated view mounts a few frames later), or
 * null after ~300ms.
 */
export async function waitForAnyZoomRow(nodeIds: readonly string[]): Promise<string | null>
{
	for (let frame = 0; ; frame++)
	{
		const rendered = nodeIds.find((id) => zoomRowElement(id) !== null);
		if (rendered !== undefined || frame >= ROW_WAIT_FRAMES)
		{
			return rendered ?? null;
		}
		// oxlint-disable-next-line no-await-in-loop -- each frame must paint before the next check
		await new Promise((resolve) =>
		{
			requestAnimationFrame(resolve);
		});
	}
}
