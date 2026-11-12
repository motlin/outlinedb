import {splitHtml} from "./rich-text.js";

/** Upstream `xr1`: a cut of this many items (descendants included) leaves a Restore banner. */
const BANNER_THRESHOLD = 10;

export interface CutPlan
{
	ids: string[];
	big: boolean;
	hasKids: boolean;
}

/** Whether the rows plus their loaded descendants number `BANNER_THRESHOLD` or more, and whether any row has kids. */
export function rowsWithDescendants(
	ids: readonly string[],
	childIds: (id: string) => string[] | undefined,
):
{
	big: boolean;
	hasKids: boolean;
}
{
	let total = 0;
	const count = (id: string): void =>
	{
		total += 1;
		for (const child of childIds(id) ?? [])
		{
			count(child);
		}
	};
	for (const id of ids)
	{
		count(id);
	}
	return {
		big: total >= BANNER_THRESHOLD,
		hasKids: ids.some((id) => (childIds(id) ?? []).length > 0),
	};
}

/** Which selected rows a cut takes: only those that can be cut and deleted. */
export function planCut(
	ordered: readonly string[],
	canCut: (id: string) => boolean,
	childIds: (id: string) => string[] | undefined = () => [],
): CutPlan
{
	const ids = ordered.filter((id) => canCut(id));
	return {
		ids,
		...rowsWithDescendants(ids, childIds),
	};
}

/**
 * Upstream's cut notice. The missing space before "cut" when descendants went is upstream's own quirk
 * (`8 items and their descendantscut and added to clipboard.`), copied verbatim.
 */
export function cutBannerText(count: number, hasKids: boolean): string
{
	const descendants = hasKids ? `and ${count > 1 ? "their" : "its"} descendants` : "";
	return `${count} item${count > 1 ? "s" : ""} ${descendants}cut and added to clipboard. `;
}

/** The stored markup of the visible range [start, end), with the tags open at either edge closed or reopened. */
export function selectedMarkup(stored: string, start: number, end: number): string
{
	const upToEnd = splitHtml(stored, end, end).before;
	return splitHtml(upToEnd, start, start).after;
}
