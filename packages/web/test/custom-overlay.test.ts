import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {hintFrom, lookup, overlayHotkeys} from "../src/client/keys/custom-overlay.js";
import type {HotkeyOverride} from "../src/client/keys/custom-overlay.js";
import {processCombo} from "../src/client/keys/dispatch.js";
import type {CommandContext} from "../src/client/keys/dispatch.js";
import {hint} from "../src/client/keys/hint.js";
import {useCustomKeymapStore} from "../src/client/stores/custom-keymap.js";

const defaults: [string, string][] = [
	["meta+.", "zoom_in"],
	["ctrl+right", "zoom_in"],
	["meta+o", "show_or_hide_completed"],
];
const overrides: HotkeyOverride[] = [
	["alt+z", "zoom_in"],
	["meta+.", null],
	["ctrl+right", null],
];
const ctx: CommandContext =
{
	items: [],
	zoomedId: null,
};

afterEach(() =>
{
	useCustomKeymapStore.getState().set([]);
});

describe("overlayHotkeys", () =>
{
	it("puts overrides first in order, then the unshadowed defaults", () =>
	{
		expect(overlayHotkeys(defaults, overrides)).toStrictEqual([
			["alt+z", "zoom_in"],
			["meta+.", null],
			["ctrl+right", null],
			["meta+o", "show_or_hide_completed"],
		]);
	});

	it("is the defaults when there are no overrides", () =>
	{
		expect(overlayHotkeys(defaults, [])).toStrictEqual(defaults);
	});

	it("looks up, treating a disabled combo as unbound, and hints the custom combo", () =>
	{
		const table = overlayHotkeys(defaults, overrides);
		expect(
			{
				disabled: lookup(table, "meta+."),
				kept: lookup(table, "meta+o"),
				hint: hintFrom(table, "zoom_in"),
			},
		).toStrictEqual(
			{
				disabled: undefined,
				kept: "show_or_hide_completed",
				hint: "alt+z",
			},
		);
	});
});

describe("custom keymap in the dispatcher and hint", () =>
{
	it("leaves a disabled default unclaimed and claims an unknown command without running anything", () =>
	{
		useCustomKeymapStore.getState().set([...overrides, ["alt+x", "no_such_cmd"]]);
		const execute = vi.fn<(ctx: CommandContext) => void>();
		expect(
			{
				disabled: processCombo(
					"meta+.",
					{
						zoom_in:
						{
							execute,
						},
					},
					ctx,
					true,
				),
				unknown: processCombo(
					"alt+x",
					{
						zoom_in:
						{
							execute,
						},
					},
					ctx,
					true,
				),
				custom: processCombo(
					"alt+z",
					{
						zoom_in:
						{
							execute,
						},
					},
					ctx,
					true,
				),
				calls: execute.mock.calls.length,
			},
		).toStrictEqual(
			{
				disabled: "unclaimed",
				unknown: "claimed",
				custom: "claimed",
				calls: 1,
			},
		);
	});

	it("hints the custom combo and restores the default when cleared", () =>
	{
		useCustomKeymapStore.getState().set(overrides);
		const custom = hint("zoom_in");
		useCustomKeymapStore.getState().set([]);
		expect(
			{
				custom,
				restored: hint("zoom_in"),
			},
		).toStrictEqual(
			{
				custom: "⌥Z",
				restored: "⌘.",
			},
		);
	});
});
