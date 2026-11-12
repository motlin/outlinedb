import {describe, expect, it} from "vite-plus/test";
import {PALETTE_ORDER} from "../src/client/keys/palette-order.js";
import
{
	initialPaletteState,
	paletteEntries,
	paletteFooterCount,
	paletteHotkeys,
	paletteReducer,
	paletteRowClass,
} from "../src/client/command-palette-model.js";
import type {PaletteEntry} from "../src/client/command-palette-model.js";
import type {CommandRegistry} from "../src/client/keys/dispatch.js";

const ctx =
{
	items: [],
	zoomedId: null,
};
const execute = () =>
{
};
const NA = "Not available in the current context";

function full(): PaletteEntry[]
{
	return PALETTE_ORDER.map((key) => (
	{
		key,
		disabled: null,
	}));
}

function search(term: string, list = full()): string[]
{
	return paletteReducer(
		initialPaletteState(list),
		{
			type: "SEARCH",
			term,
		},
	).list.map((e) => e.key);
}

describe("palette order", () =>
{
	it("holds the 192 upstream ids", () =>
	{
		expect(PALETTE_ORDER).toHaveLength(192);
		expect(PALETTE_ORDER.slice(0, 3)).toStrictEqual(["select_all", "expand_selection_up", "expand_selection_down"]);
		expect(PALETTE_ORDER.slice(-3)).toStrictEqual([
			"customize_themes",
			"show_command_palette",
			"toggle_good_dashboard",
		]);
	});
});

describe("paletteEntries", () =>
{
	it("lists upstream order first, local extras last, hides underscore keys, marks unavailable", () =>
	{
		const registry: CommandRegistry =
		{
			zen_mode:
			{
				execute,
			},
			b_local:
			{
				execute,
			},
			_hidden:
			{
				execute,
			},
			swap_mirror_origin:
			{
				available: () => false,
				execute,
			},
			toggle_table:
			{
				available: () =>
				{
					throw new Error("boom");
				},
				execute,
			},
		};
		expect(paletteEntries(registry, ctx)).toStrictEqual([
			{
				key: "swap_mirror_origin",
				disabled: NA,
			},
			{
				key: "toggle_table",
				disabled: NA,
			},
			{
				key: "zen_mode",
				disabled: null,
			},
			{
				key: "b_local",
				disabled: null,
			},
		]);
	});
});

describe("paletteHotkeys", () =>
{
	it("keeps the first raw combo per command", () =>
	{
		expect(
			paletteHotkeys([
				["alt+q", "show_command_palette"],
				["alt+w", "show_command_palette"],
				["meta+a", null],
				["meta+a", "select_all"],
			]),
		).toStrictEqual(
			{
				show_command_palette: "alt+q",
				select_all: "meta+a",
			},
		);
	});
});

describe("paletteReducer", () =>
{
	it("filters by fuzzy command id and ranks by score", () =>
	{
		expect(search("zen")).toStrictEqual(["zen_mode"]);
		expect(search("tfw")).toStrictEqual(["toggle_full_width_page", "navigate_forward"]);
		expect(search("mv7")).toStrictEqual(["move_7_days_out"]);
		expect(search("ToGgLe_b").slice(0, 6)).toStrictEqual([
			"toggle_bold",
			"toggle_bullet",
			"toggle_board",
			"toggle_table",
			"toggle_numbered",
			"toggle_leftbar",
		]);
		const date = search("date");
		expect(date.slice(0, 6)).toStrictEqual([
			"duplicate_table_column",
			"duplicate",
			"delete_dates",
			"move_to_date",
			"mirror_to_date",
			"add_date",
		]);
		expect(date).toHaveLength(11);
		expect(search("sel m")).toStrictEqual([]);
	});

	it("keeps disabled rows in results", () =>
	{
		const list = PALETTE_ORDER.map((key) => (
		{
			key,
			disabled: key === "detach_mirror" ? NA : null,
		}));
		expect(search("mirror", list)).toStrictEqual([
			"mirror",
			"mirror_to",
			"mirror_to_child",
			"mirror_here",
			"mirror_to_today",
			"mirror_to_date",
			"show_mirror_breadcrumbs",
			"swap_mirror_origin",
			"detach_mirror",
			"insert_inline_mirror",
		]);
	});

	it("clamps movement and resets the index on search", () =>
	{
		let state = initialPaletteState(full().slice(0, 10));
		for (let i = 0; i < 12; i++)
		{
			state = paletteReducer(
				state,
				{
					type: "MOVE_DOWN",
				},
			);
		}
		expect(state.idx).toBe(9);
		for (let i = 0; i < 12; i++)
		{
			state = paletteReducer(
				state,
				{
					type: "MOVE_UP",
				},
			);
		}
		expect(state.idx).toBe(0);
		state = paletteReducer(
			paletteReducer(
				state,
				{
					type: "MOVE_DOWN",
				},
			),
			{
				type: "SEARCH",
				term: "s",
			},
		);
		expect(state.idx).toBe(0);
		expect(
			paletteReducer(
				state,
				{
					type: "SEARCH",
					term: "",
				},
			).list,
		).toHaveLength(10);
	});
});

describe("row class and footer", () =>
{
	it("clones the upstream template quirk", () =>
	{
		expect(paletteRowClass(true)).toBe(
			"\n                py-s pl-s bg-secondary\n                flex flex-row items-center\n                aria-disabled:opacity-50\n                aria-disabled:cursor-help\n              ",
		);
		expect(paletteRowClass(false)).toContain(" falsebg-secondary\n");
		expect([0, 1, 2].map(paletteFooterCount)).toStrictEqual([
			"0 nodes selected",
			"1 node selected",
			"2 nodes selected",
		]);
	});
});
