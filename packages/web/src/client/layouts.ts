// Upstream's `WF.Layouts` registry (`canRender`) as pure functions. A complex layout (table, board, dashboard) draws
// itself only when no other complex layout sits between it and the render root (the zoomed item or a pane root).

interface LayoutHolder
{
	layoutMode: string | null | undefined;
}

/** Layouts upstream registers with `{complex: true}`; `dashboard` only exists while the Labs flag is on. */
export function complexLayouts(dashboardsFlag: boolean): ReadonlySet<string>
{
	return new Set(dashboardsFlag ? ["table", "board", "dashboard"] : ["table", "board"]);
}

export interface CanRenderOptions
{
	/** The ancestor walk met the render root; false means the item sits outside the rendered subtree. */
	reachedRoot: boolean;
	dashboardsFlag: boolean;
}

/**
 * `WF.Layouts.canRender(layout, item)`: `ancestors` runs nearest-first up to and including the render root. The item
 * itself does not count; the render root does. The zoom root passes `[]` with `reachedRoot: true`.
 */
export function canRenderLayout(
	layout: string,
	node: LayoutHolder,
	ancestors: readonly LayoutHolder[],
	{reachedRoot, dashboardsFlag}: CanRenderOptions,
): boolean
{
	const complex = complexLayouts(dashboardsFlag);
	if (!complex.has(layout))
	{
		return true;
	}
	if (node.layoutMode !== layout || !reachedRoot)
	{
		return false;
	}
	return !ancestors.some((ancestor) => complex.has(ancestor.layoutMode ?? ""));
}
