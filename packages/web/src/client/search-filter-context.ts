import {createContext, useContext} from "react";
import type {SearchFilter} from "./search-filter.js";

/**
 * The pane's in-place search filter, read once by its `OutlineTree` and handed to every row below it, so a row holds
 * no search query or store selector of its own. Null when no search is applied, and outside an outline.
 */
export const SearchFilterContext = createContext<SearchFilter | null>(null);

/** The search filter of the outline the caller renders in. */
export function useOutlineSearchFilter(): SearchFilter | null
{
	return useContext(SearchFilterContext);
}
