import {locationKey} from "@outlinedb/shared";
import {STARS_UNAVAILABLE_TOOLTIP, useStarActions, useStars} from "../hooks/use-starred.js";
import {useOutlineStore} from "../stores/outline.js";
import {IconButton} from "./icon-button.js";

/** Upstream's 20x20 starring star outline. */
const STAR_PATH =
	"M9.278,3.513 C9.568,2.906 10.432,2.906 10.722,3.513 L12.261,6.739 C12.378,6.983 12.61,7.152 12.879,7.187 L16.422,7.654 C17.089,7.742 17.356,8.564 16.868,9.028 L14.276,11.488 C14.08,11.675 13.991,11.948 14.04,12.214 L14.691,15.728 C14.813,16.39 14.114,16.898 13.523,16.577 L10.382,14.872 C10.144,14.743 9.856,14.743 9.618,14.872 L6.477,16.577 C5.886,16.898 5.187,16.39 5.309,15.728 L5.96,12.214 C6.009,11.948 5.92,11.675 5.724,11.488 L3.132,9.028 C2.644,8.564 2.911,7.742 3.578,7.654 L7.121,7.187 C7.39,7.152 7.622,6.983 7.739,6.739 L9.278,3.513 Z";

/** Upstream's star glyph: outlined when unstarred, filled with the current color when starred. */
function StarIcon({starred}: {starred: boolean})
{
	return (
		<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
			<path d={STAR_PATH} stroke="currentColor" fill={starred ? "currentColor" : "none"} />
		</svg>
	);
}

interface StarButtonProps
{
	/** The node to star; undefined means the zoomed node plus the committed search query. */
	nodeId?: string | null;
	query?: string | null;
	tooltip?: string;
	handbook?: string;
	size?: "sm" | "ms" | "md" | "ml" | "lg" | "xl";
}

/** Upstream's StarButton: a `.starring-star` IconButton that toggles a starred location. */
export function StarButton({nodeId, query, tooltip, handbook, size = "ms"}: StarButtonProps)
{
	const zoomedNodeId = useOutlineStore((state) => state.zoomedNodeId);
	const urlSearchQuery = useOutlineStore((state) => state.urlSearchQuery);
	const {stars, unavailable} = useStars();
	const {toggleStar} = useStarActions();
	const loc =
		nodeId === undefined
			?
				{
					nodeId: zoomedNodeId,
					query: urlSearchQuery,
				}
			:
				{
					nodeId,
					query: query ?? null,
				};
	const key = locationKey(loc);
	const starred = stars.some((star) => star.key === key);

	return (
		<IconButton
			className="starring-star"
			size={size}
			data-handbook={handbook}
			tooltip={unavailable ? STARS_UNAVAILABLE_TOOLTIP : (tooltip ?? (starred ? "Unstar" : "Star"))}
			onClick={() =>
			{
				if (!unavailable)
				{
					void toggleStar(loc);
				}
			}}
		>
			<span
				style={
					starred
						?
							{
								color: "var(--wf-text-spark)",
							}
						: undefined
				}
			>
				<StarIcon starred={starred} />
			</span>
		</IconButton>
	);
}
