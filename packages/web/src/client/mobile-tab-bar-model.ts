import {headerHeight} from "./is-mobile.js";

const TAB_BAR_BASE =
	"tab-bar hideForSheetView fixed left-0 right-0 bottom-0 flex items-center pb-[var(--safe-area-inset-bottom)] bg-primary border-t-primary border-t border-solid z-10 text-tertiary justify-around";

/** Upstream's `oS4` classes: 49px tall on iOS, 56px on Android. */
export function tabBarClassName(userAgent: string): string
{
	return `${TAB_BAR_BASE} h-[${headerHeight(userAgent)}px]`;
}
