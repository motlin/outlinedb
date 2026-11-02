import {create} from "zustand";
import type {CustomTheme} from "../custom-themes.js";

interface CustomThemesState
{
	themes: CustomTheme[];
	set: (themes: CustomTheme[]) => void;
}

/** Themes read from the account's Custom > Themes tree; they extend or override the built-in list. */
export const useCustomThemesStore = create<CustomThemesState>((set) => (
{
	themes: [],
	set: (themes) =>
	{
		set(
			{
				themes,
			},
		);
	},
}));
