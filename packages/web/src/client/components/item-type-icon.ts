import {FA_ICONS} from "./fa-icons.js";
import type {FaIconKey} from "./fa-icons.js";

function isFaIconKey(key: string): key is FaIconKey
{
	return key in FA_ICONS;
}

/** The light Font Awesome key for an item type's icon name. */
export function typeIcon(icon: string): FaIconKey
{
	const key = `fal:${icon}`;
	if (!isFaIconKey(key))
	{
		throw new Error(`Missing item type icon ${key}`);
	}
	return key;
}
