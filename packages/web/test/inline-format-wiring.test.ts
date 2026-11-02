import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";
import {canBePending, insertWithPendingFormat, togglePendingAttr} from "../src/client/hooks/use-inline-format.js";

function source(path: string): string
{
	return readFileSync(new URL(`../src/client/components/${path}`, import.meta.url), "utf8");
}

describe("inline format wiring", () =>
{
	it("routes both editors' format commands through applyInlineToggle, never execCommand", () =>
	{
		const files = ["editable-text.tsx", "editable-note.tsx"];
		expect(
			files.map((file) =>
			{
				const text = source(file);
				return [file, text.includes("execCommand("), text.includes("applyInlineToggle")];
			}),
		).toStrictEqual([
			["editable-text.tsx", false, true],
			["editable-note.tsx", false, true],
		]);
	});
});

describe("editor wiring for code and color", () =>
{
	it("runs the inline-code input rule and the color popup in both editors", () =>
	{
		expect(
			["editable-text.tsx", "editable-note.tsx"].map((file) =>
			{
				const text = source(file);
				return [file, text.includes("applyInlineCodeInput("), text.includes("useColorPopup(")];
			}),
		).toStrictEqual([
			["editable-text.tsx", true, true],
			["editable-note.tsx", true, true],
		]);
	});
});

describe("togglePendingAttr", () =>
{
	it("adds an attribute once and removes it on the second toggle", () =>
	{
		const once = togglePendingAttr(new Set(), "b");
		const twice = togglePendingAttr(once, "b");
		expect([[...once], [...twice], [...togglePendingAttr(once, "i")]]).toStrictEqual([["b"], [], ["b", "i"]]);
	});
});

describe("canBePending", () =>
{
	it("keeps Code out of pending formats, since upstream's Code is atomic", () =>
	{
		expect((["b", "i", "u", "s", "code"] as const).map(canBePending)).toStrictEqual([
			true,
			true,
			true,
			true,
			false,
		]);
	});
});

describe("insertWithPendingFormat with a color", () =>
{
	it("wraps the typed text in the pending color", () =>
	{
		expect([
			insertWithPendingFormat(
				"here",
				4,
				new Set(),
				"z",
				{
					kind: "highlight",
					color: "yellow",
				},
			),
			insertWithPendingFormat(
				"here",
				4,
				new Set(["b"]),
				"zy",
				{
					kind: "text",
					color: "red",
				},
			),
		]).toStrictEqual([
			'here<span class="colored bc-yellow">z</span>',
			'here<span class="colored c-red"><b>zy</b></span>',
		]);
	});
});

describe("insertWithPendingFormat", () =>
{
	it("applies pending attributes to the first typed character; the rest inherit from it", () =>
	{
		expect([
			insertWithPendingFormat("ab", 1, new Set(["b"]), "z"),
			insertWithPendingFormat("ab", 1, new Set(["b"]), "zy"),
			insertWithPendingFormat("<b>ab</b>", 2, new Set(["b"]), "z"),
			insertWithPendingFormat("", 0, new Set(["b", "i"]), "x"),
		]).toStrictEqual(["a<b>z</b>b", "a<b>zy</b>b", "<b>ab</b>z", "<i><b>x</b></i>"]);
	});
});
