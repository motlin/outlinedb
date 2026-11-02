import {describe, expect, it} from "vite-plus/test";
import {parseCustomHotkeys} from "../src/client/keys/custom-hotkeys.js";
import type {CustomNode} from "../src/client/keys/custom-hotkeys.js";

const defaults: [string, string][] = [
	["meta+.", "zoom_in"],
	["ctrl+right", "zoom_in"],
	["meta+o", "show_or_hide_completed"],
];

function node(name: string, children: CustomNode[] = [], completed = false): CustomNode
{
	return {
		name,
		completed,
		children,
	};
}
const line = (combo: string, ...commands: string[]): CustomNode =>
	node(
		combo,
		commands.map((c) => node(c)),
	);

describe("parseCustomHotkeys", () =>
{
	it("releases the command's default combos when it gets a custom one", () =>
	{
		expect(parseCustomHotkeys([node("Hotkeys", [line("alt+z", "zoom_in")])], defaults)).toStrictEqual([
			["meta+.", null],
			["ctrl+right", null],
			["alt+z", "zoom_in"],
		]);
	});

	it("disables a completed combo", () =>
	{
		expect(parseCustomHotkeys([node("Hotkeys", [node("meta+o", [node("x")], true)])], defaults)).toStrictEqual([
			["meta+o", null],
		]);
	});

	it("ignores a combo without a command", () =>
	{
		expect(parseCustomHotkeys([node("Hotkeys", [node("alt+z")])], defaults)).toStrictEqual([]);
	});

	it("lets the later Hotkeys node win", () =>
	{
		expect(
			parseCustomHotkeys(
				[node("Hotkeys", [line("alt+z", "a")]), node("Hotkeys", [line("alt+z", "b")])],
				defaults,
			),
		).toStrictEqual([["alt+z", "b"]]);
	});

	it("lets a later release clobber an earlier custom line but keeps its position", () =>
	{
		expect(
			parseCustomHotkeys([node("Hotkeys", [line("meta+.", "foo"), line("alt+z", "zoom_in")])], defaults),
		).toStrictEqual([
			["meta+.", null],
			["ctrl+right", null],
			["alt+z", "zoom_in"],
		]);
	});

	it("uses only the first command child", () =>
	{
		expect(parseCustomHotkeys([node("Hotkeys", [line("alt+z", "a", "b")])], defaults)).toStrictEqual([
			["alt+z", "a"],
		]);
	});
});
