import {create} from "zustand";
import type {HotkeyOverride} from "../keys/custom-overlay.js";

interface CustomKeymapState
{
	overrides: HotkeyOverride[];
	set: (overrides: HotkeyOverride[]) => void;
}

/** The custom hotkeys read from the account's Custom > Hotkeys tree; empty means the defaults apply. */
export const useCustomKeymapStore = create<CustomKeymapState>((set) => (
{
	overrides: [],
	set: (overrides) =>
	{
		set(
			{
				overrides,
			},
		);
	},
}));
