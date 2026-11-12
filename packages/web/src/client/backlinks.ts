import {isFeatureOn} from "./features.js";
import type {BacklinksResponse} from "../node-types.js";

export {backlinksLabel} from "../backlinks-label.js";

/**
 * Upstream's `isDisplayable` for a references root: it has a root and at least
 * one backlink whose source is visible (not completed while completed items are hidden).
 */
export function isBacklinksSectionVisible(backlinks: BacklinksResponse | undefined, showCompleted: boolean): boolean
{
	if (backlinks?.rootId == null || !isFeatureOn("bdl"))
	{
		return false;
	}
	return backlinks.items.some((item) => showCompleted || item.node.completedAt === null);
}
