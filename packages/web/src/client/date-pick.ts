import {timeAttrsFromDates} from "./date-pills.js";
import type {TimeAttrs} from "@outlinedb/shared";

/**
 * What a date-picker pick does: with `onSelect` set (upstream `for()`'s custom onSelect, Move to Date), a non-empty
 * pick hands the dates over and inserts nothing, and an empty one just cancels; otherwise the dates become a pill.
 */
export function applyDatePick(
	opened:
	{
		offset: number;
		replaceEnd?: number;
		onSelect?: (dates: Date[]) => void;
	},
	dates: Date[],
	{
		insert,
		cancel,
	}:
	{
		insert: (attrs: TimeAttrs) => void;
		cancel: (offset: number) => void;
	},
): void
{
	if (opened.onSelect === undefined)
	{
		insert(timeAttrsFromDates(dates));
	}
	else if (dates.length > 0)
	{
		opened.onSelect(dates);
	}
	else
	{
		cancel(opened.replaceEnd ?? opened.offset);
	}
}
