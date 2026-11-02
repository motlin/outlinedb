/** Upstream's `tS4`: a phone crumb shows at most this many characters before the ellipsis. */
const MOBILE_CRUMB_LIMIT = 15;

/** A crumb label cut to 15 characters plus `…`; an empty name reads `Untitled`. */
export function truncateCrumb(label: string, limit: number = MOBILE_CRUMB_LIMIT): string
{
	if (label === "")
	{
		return "Untitled";
	}
	return label.length > limit ? `${label.slice(0, limit)}…` : label;
}

/** Upstream's `homeButton` opacity: half while zoomed at the root with no search to leave. */
export function homeButtonOpacity({atRoot, searching}: {atRoot: boolean; searching: boolean}): number
{
	return atRoot && !searching ? 0.5 : 1;
}
