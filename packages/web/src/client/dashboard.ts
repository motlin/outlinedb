import {accountFeaturesKnown, isFeatureOn} from "./features.js";

/**
 * Upstream's Dashboard layout (Labs, `doc/plugins/dashboard`): an item whose `layoutMode` is `dashboard` draws
 * its children as a wrapping grid of cards. Local adaptation: gated by the `dashboards` feature flag, off by
 * default like upstream's account. See `.llm/upstream-sync/features/dashboard-layout.md`.
 */
let cachedFlag: boolean | undefined;

/** The flag as of the first read after the account's features loaded: rows ask per render, so flipping it takes a reload. */
export function dashboardsOn(): boolean
{
	if (cachedFlag !== undefined)
	{
		return cachedFlag;
	}
	const on = isFeatureOn("dashboards");
	if (accountFeaturesKnown())
	{
		cachedFlag = on;
	}
	return on;
}

/** Upstream's `xs` predicate, minus the mobile and `canRender` checks (the caller is desktop-only). */
export function isDashboard(layoutMode: string | null | undefined, flagOn: boolean): boolean
{
	return flagOn && layoutMode === "dashboard";
}

export interface DashboardClassInput
{
	layoutMode: string | null | undefined;
	/** The row is a dashboard that draws as one: the zoom root, or not under another complex layout. */
	renders: boolean;
	/** The row's parent is a dashboard that renders, so the row is a card. */
	parentRenders: boolean;
	isZoomRoot: boolean;
	flagOn: boolean;
}

/** Upstream's `item:classes` and `page:classes` middleware: the extra `.project` and `.page` classes. */
export function dashboardClasses({layoutMode, renders, parentRenders, isZoomRoot, flagOn}: DashboardClassInput):
{
	project: string[];
	page: string[];
}
{
	const dashboard = renders && isDashboard(layoutMode, flagOn);
	return {
		project: [
			...(dashboard ? (isZoomRoot ? ["dashboard"] : ["dashboard", "dashboard-inline"]) : []),
			...(flagOn && parentRenders ? ["show-controls-on-hover", "dashboard-card"] : []),
		],
		page: dashboard && isZoomRoot ? ["dashboard-page"] : [],
	};
}

/** The placeholder of an empty card title (the U+2026 is upstream's). */
export const CARD_PLACEHOLDER = "Add a title …";

/** Enter in a card title expands the card and makes the new row its first child, not a sibling card. */
export function shouldExpandOnEnter(parentLayoutMode: string | null | undefined, flagOn: boolean): boolean
{
	return isDashboard(parentLayoutMode, flagOn);
}

/** Upstream's `can_move_under.dashboard`: nothing may move under a target whose parent is a dashboard (a card). */
export function canMoveUnderDashboard(targetParentLayoutMode: string | null | undefined, flagOn: boolean): boolean
{
	return !isDashboard(targetParentLayoutMode, flagOn);
}

/** The card bullet's class string (upstream `bullet.dashboard` patch), a shared item using the shared color. */
export function cardBulletClass(shared: boolean): string
{
	return [
		"bullet keep-bullet group/bullet absolute !left-auto right-0 mr-[10px] z-1 bg-transparent",
		shared ? "!text-[var(--wf-background-shared)]" : "!text-[var(--wf-text-tertiary)]",
		"transition-opacity duration-200 !opacity-0 group-hover/name:!opacity-100 hover:bg-inherit",
	].join(" ");
}

/** The new card's index: the top button inserts first, the bottom button appends. */
export function dashboardInsertIndex(position: "top" | "bottom", childCount: number): number
{
	return position === "top" ? 0 : childCount;
}
