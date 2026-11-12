import {create} from "zustand";

/** The phone sheets upstream's `WF.Sheet` opens (`set`), reads (`get`) and closes (`hide`). */
type SheetName = "more-menu" | "font-size";

interface SheetState
{
	sheet: SheetName | null;
}

export const useSheetStore = create<SheetState>(() => (
{
	sheet: null,
}));

/** Closes the open sheet; a plain function so it can be passed as a callback. */
export function hideSheet(): void
{
	useSheetStore.setState(
		{
			sheet: null,
		},
	);
}

export const Sheet =
{
	set(sheet: SheetName): void
	{
		useSheetStore.setState(
			{
				sheet,
			},
		);
	},
	get(): SheetName | null
	{
		return useSheetStore.getState().sheet;
	},
	hide: hideSheet,
};
