import type {CommandContext, CommandRegistry} from "./keys/dispatch.js";
import {PALETTE_ORDER} from "./keys/palette-order.js";
import {fuzzyMatch, fuzzyScore} from "./std-fuzzy.js";

export interface PaletteEntry
{
	key: string;
	/** The row's title when the command is unavailable, else null. */
	disabled: string | null;
}

const NOT_AVAILABLE = "Not available in the current context";

function isAvailable(registry: CommandRegistry, key: string, ctx: CommandContext): boolean
{
	try
	{
		return registry[key]?.available?.(ctx) !== false;
	}
	catch
	{
		return false;
	}
}

/** Upstream WF.Cmd.list: upstream order first, then local-only registry commands. */
export function paletteEntries(
	registry: CommandRegistry,
	ctx: CommandContext,
	order: readonly string[] = PALETTE_ORDER,
): PaletteEntry[]
{
	const known = new Set(order);
	const keys = [
		...order.filter((key) => key in registry),
		...Object.keys(registry).filter((key) => !known.has(key)),
	].filter((key) => !key.startsWith("_"));
	return keys.map((key) => (
	{
		key,
		disabled: isAvailable(registry, key, ctx) ? null : NOT_AVAILABLE,
	}));
}

/** The first non-null raw combo per command, in table order (custom combos first). */
export function paletteHotkeys(table: readonly (readonly [string, string | null])[]): Record<string, string>
{
	const result: Record<string, string> = {};
	for (const [combo, command] of table)
	{
		if (command !== null)
		{
			result[command] ??= combo;
		}
	}
	return result;
}

export interface PaletteState
{
	idx: number;
	term: string;
	all: readonly PaletteEntry[];
	list: readonly PaletteEntry[];
}

export type PaletteAction =
	|
	  {
			type: "SEARCH";
			term: string;
	  }
	|
	  {
			type: "MOVE_DOWN";
	  }
	|
	  {
			type: "MOVE_UP";
	  };

export function initialPaletteState(list: readonly PaletteEntry[]): PaletteState
{
	return {
		idx: 0,
		term: "",
		all: list,
		list,
	};
}

export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState
{
	switch (action.type)
	{
		case "SEARCH":
		{
			const {term} = action;
			if (term === "")
			{
				return {
					...state,
					idx: 0,
					term,
					list: state.all,
				};
			}
			const list = state.all
				.filter((entry) => fuzzyMatch(term, entry.key))
				.map((entry, order) => (
				{
					entry,
					order,
					score: fuzzyScore(term, entry.key),
				}))
				.toSorted((a, b) => b.score - a.score || a.order - b.order)
				.map(({entry}) => entry);
			return {
				...state,
				idx: 0,
				term,
				list,
			};
		}
		case "MOVE_DOWN":
			return {
				...state,
				idx: Math.min(state.idx + 1, state.list.length - 1),
			};
		case "MOVE_UP":
			return {
				...state,
				idx: Math.max(state.idx - 1, 0),
			};
		default:
			return state;
	}
}

/** Upstream row template; the inactive rows get the dead token `falsebg-secondary`. */
export function paletteRowClass(active: boolean): string
{
	return `\n                py-s pl-s ${active ? "" : "false"}bg-secondary\n                flex flex-row items-center\n                aria-disabled:opacity-50\n                aria-disabled:cursor-help\n              `;
}

export const PALETTE_CHIP_CLASS =
	"\n                    px-xs py-2xs rounded-xs bg-quaternary\n                    text-xs\n                    xcursor-pointer xhover:bg-tertiary\n                  ";

export function paletteFooterCount(count: number): string
{
	return `${count} node${count === 1 ? "" : "s"} selected`;
}
