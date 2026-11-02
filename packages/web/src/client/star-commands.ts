import {starCurrentLocation} from "@outlinedb/shared";
import type {StarredLocation} from "@outlinedb/shared";
import type {Command} from "./keys/dispatch.js";

/**
 * Upstream's `star_current_item` (⇧⌘8): stars the current location, the zoomed page plus the committed search query,
 * so during a search it stars the search. It also works at Home.
 */
export function starCurrentItemCommand(
	toggleStar: (loc: StarredLocation) => Promise<unknown>,
	committedQuery: () => string | null,
): Command
{
	return {
		execute(ctx)
		{
			void toggleStar(
				starCurrentLocation(
					{
						zoomedId: ctx.zoomedId,
						query: committedQuery(),
					},
				),
			);
		},
	};
}
