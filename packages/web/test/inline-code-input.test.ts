import {describe, expect, it} from "vite-plus/test";
import {planInlineCodeInput} from "../src/client/inline-code-input.js";

describe("planInlineCodeInput", () =>
{
	it.each([
		["a closing backtick codes the text and adds a plain space", "a `bc`", 6, "`", "a <code>bc</code> ", 5],
		["no space is added before an existing space", "`k` z", 3, "`", "<code>k</code> z", 2],
		["upstream's caret quirk before a letter", "`m`q", 3, "`", "<code>m</code> q", 3],
		[
			"an opening backtick codes up to the next one without a space",
			"`foo` bar",
			1,
			"`",
			"<code>foo</code> bar",
			0,
		],
		["typing between two backticks wraps them", "e `x`", 4, "x", "e <code>x</code>", 3],
		["two spaces at the end of code leave it", "a <code>bcz  </code> d", 7, " ", "a <code>bcz</code>  d", 6],
		["other formats stay untouched", "a <b>x</b> `y`", 7, "`", "a <b>x</b> <code>y</code> ", 6],
	])("%s", (_name, html, caret, typed, expectedHtml, expectedCaret) =>
	{
		expect(planInlineCodeInput(html, caret, typed)).toStrictEqual(
			{
				html: expectedHtml,
				caret: expectedCaret,
			},
		);
	});

	it.each([
		["empty content stays literal", "e ``", 4, "`"],
		["a backtick inside code stays literal", "<code>a`b</code>", 2, "`"],
		["a lone backtick is left alone", "e `", 3, "`"],
		["plain typing changes nothing", "plain", 5, "n"],
	])("%s", (_name, html, caret, typed) =>
	{
		expect(planInlineCodeInput(html, caret, typed)).toBeNull();
	});
});
