/** Upstream's `tn2`: below this window width the page side padding narrows. */
export const PAGE_BREAKPOINT = 720;

/** Upstream's `Ju4`: the clickable blank space after the last row. */
export const DOCUMENT_END_HEIGHT = 380;

/** Upstream's `ln2`: the page's side padding for a window `width`. */
export function getPagePadding(width: number):
{
	left: number;
	right: number;
}
{
	return width < PAGE_BREAKPOINT
		?
			{
				left: 56,
				right: 56,
			}
		:
			{
				left: 80,
				right: 136,
			};
}

/** Upstream's `ln2` mobile branch: the smaller sides apply below 720px, and neither goes under a safe-area inset. */
export function mobilePagePadding(
	width: number,
	safe:
	{
		left: number;
		right: number;
	},
):
{
	left: number;
	right: number;
}
{
	const narrow = width < PAGE_BREAKPOINT;
	return {
		left: Math.max(narrow ? 16 : 40, safe.left),
		right: Math.max(narrow ? 24 : 40, safe.right),
	};
}

/** The device's `--safe-area-inset-left/right` in px (0 without `viewport-fit=cover` or off a notched phone). */
export function readSafeInsets(root: HTMLElement = document.documentElement):
{
	left: number;
	right: number;
}
{
	const style = getComputedStyle(root);
	const read = (name: string): number => Number(style.getPropertyValue(name).replace("px", "").trim()) || 0;
	return {
		left: read("--safe-area-inset-left"),
		right: read("--safe-area-inset-right"),
	};
}

export interface PageStyleInput
{
	fullWidth: boolean;
	/** `window.innerWidth`. */
	width: number;
	searching: boolean;
	/** The desktop page never moves while offline; upstream's phone page drops 25px. */
	offline?: boolean;
	/** A phone: upstream's `by4` geometry. */
	mobile?: boolean;
	/** The device's safe-area insets, for the phone padding. */
	safeInsets?:
	{
		left: number;
		right: number;
	};
	/** The mobile search form is showing: `WF.GuiPage.appendTopMargin("search", 44)`. */
	searchFormVisible?: boolean;
}

/** Upstream's `.page` inline style (desktop). */
export function pageStyle({
	fullWidth,
	width,
	searching,
	offline = false,
	mobile = false,
	safeInsets =
	{
		left: 0,
		right: 0,
	},
	searchFormVisible = false,
}: PageStyleInput)
{
	if (mobile)
	{
		const sides = mobilePagePadding(width, safeInsets);
		return {
			minHeight: "calc(100vh - 82px)",
			borderRadius: 3,
			maxWidth: "none" as const,
			paddingLeft: sides.left,
			paddingRight: sides.right,
			paddingTop: 24,
			marginTop: 32 + (offline ? 25 : 0) + (searchFormVisible ? 44 : 0),
			paddingBottom: searching ? 70 : 24,
		};
	}
	const padding = getPagePadding(width);
	return {
		minHeight: "calc(100vh - 146px)",
		borderRadius: 6,
		maxWidth: fullWidth ? ("none" as const) : 700,
		paddingLeft: padding.left,
		paddingRight: padding.right,
		paddingTop: 24,
		marginTop: 72,
		paddingBottom: searching ? 70 : 24,
	};
}

const PAGE_CLASS =
	"relative mx-auto flex flex-col select-none bg-primary shadow-[0_0_15px_var(--wf-border-ambient)] [-webkit-text-size-adjust:none] print:block page active";

/** Upstream's `.page` class string, plus `searching` and `showCompleted` when they apply. */
export function pageClassName({
	searching,
	showCompleted,
	mobile = false,
	dashboardPage = false,
}: {
	searching: boolean;
	showCompleted: boolean;
	mobile?: boolean;
	/** The zoomed item is a dashboard (upstream's `page:classes`). */
	dashboardPage?: boolean;
}): string
{
	return [
		PAGE_CLASS,
		mobile && "overflow-x-hidden",
		searching && "searching",
		showCompleted && "showCompleted",
		dashboardPage && "dashboard-page",
	]
		.filter(Boolean)
		.join(" ");
}

/** Upstream's `.pageContainer` class string (desktop). */
export function pageContainerClassName(mobile = false): string
{
	const base =
		"min-h-screen bg-[var(--wf-background-ambient)] bg-fixed [background-image:var(--wf-image-ambient)] pageContainer";
	return mobile ? `${base} [.fly_&]:pb-[20vh]` : base;
}
