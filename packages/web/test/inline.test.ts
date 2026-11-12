import {describe, expect, it} from "vite-plus/test";
import {planInlineCodeInput} from "../src/client/inline-code-input.js";
import {readFileSync} from "node:fs";
import {canBePending, insertWithPendingFormat, togglePendingAttr} from "../src/client/hooks/use-inline-format.js";
import {routeTypedInput} from "../src/client/inline-input-router.js";
import {
	bracketMatch,
	innerText,
	planAutoClose,
	planInsertInlineLink,
	planLinkInsert,
} from "../src/client/inline-link.js";
import {
	inlineMirrorInsertion,
	inlineMirrorRefusal,
	planInlineMirror,
	planMirrorOpen,
	planMirrorRearm,
} from "../src/client/inline-mirror.js";

describe("inline code input", () => {
	describe("planInlineCodeInput", () => {
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
		])("%s", (_name, html, caret, typed, expectedHtml, expectedCaret) => {
			expect(planInlineCodeInput(html, caret, typed)).toStrictEqual({html: expectedHtml, caret: expectedCaret});
		});

		it.each([
			["empty content stays literal", "e ``", 4, "`"],
			["a backtick inside code stays literal", "<code>a`b</code>", 2, "`"],
			["a lone backtick is left alone", "e `", 3, "`"],
			["plain typing changes nothing", "plain", 5, "n"],
		])("%s", (_name, html, caret, typed) => {
			expect(planInlineCodeInput(html, caret, typed)).toBeNull();
		});
	});
});

describe("inline format wiring", () => {
	function source(path: string): string {
		return readFileSync(new URL(`../src/client/components/${path}`, import.meta.url), "utf8");
	}

	describe("inline format wiring", () => {
		it("routes both editors' format commands through applyInlineToggle, never execCommand", () => {
			const files = ["editable-text.tsx", "editable-note.tsx"];
			expect(
				files.map((file) => {
					const text = source(file);
					return [file, text.includes("execCommand("), text.includes("applyInlineToggle")];
				}),
			).toStrictEqual([
				["editable-text.tsx", false, true],
				["editable-note.tsx", false, true],
			]);
		});
	});

	describe("editor wiring for code and color", () => {
		it("runs the inline-code input rule and the color popup in both editors", () => {
			expect(
				["editable-text.tsx", "editable-note.tsx"].map((file) => {
					const text = source(file);
					return [file, text.includes("applyInlineCodeInput("), text.includes("useColorPopup(")];
				}),
			).toStrictEqual([
				["editable-text.tsx", true, true],
				["editable-note.tsx", true, true],
			]);
		});
	});

	describe("togglePendingAttr", () => {
		it("adds an attribute once and removes it on the second toggle", () => {
			const once = togglePendingAttr(new Set(), "b");
			const twice = togglePendingAttr(once, "b");
			expect([[...once], [...twice], [...togglePendingAttr(once, "i")]]).toStrictEqual([["b"], [], ["b", "i"]]);
		});
	});

	describe("canBePending", () => {
		it("keeps Code out of pending formats, since upstream's Code is atomic", () => {
			expect((["b", "i", "u", "s", "code"] as const).map(canBePending)).toStrictEqual([
				true,
				true,
				true,
				true,
				false,
			]);
		});
	});

	describe("insertWithPendingFormat with a color", () => {
		it("wraps the typed text in the pending color", () => {
			expect([
				insertWithPendingFormat("here", 4, new Set(), "z", {kind: "highlight", color: "yellow"}),
				insertWithPendingFormat("here", 4, new Set(["b"]), "zy", {kind: "text", color: "red"}),
			]).toStrictEqual([
				'here<span class="colored bc-yellow">z</span>',
				'here<span class="colored c-red"><b>zy</b></span>',
			]);
		});
	});

	describe("insertWithPendingFormat", () => {
		it("applies pending attributes to the first typed character; the rest inherit from it", () => {
			expect([
				insertWithPendingFormat("ab", 1, new Set(["b"]), "z"),
				insertWithPendingFormat("ab", 1, new Set(["b"]), "zy"),
				insertWithPendingFormat("<b>ab</b>", 2, new Set(["b"]), "z"),
				insertWithPendingFormat("", 0, new Set(["b", "i"]), "x"),
			]).toStrictEqual(["a<b>z</b>b", "a<b>zy</b>b", "<b>ab</b>z", "<i><b>x</b></i>"]);
		});
	});
});

describe("inline input router", () => {
	describe("routeTypedInput", () => {
		it("swallows the input that disarmed a chip, and saves", () => {
			expect(
				routeTypedInput({chipArmedBefore: true, chipArmedAfter: false, datePopupOpened: false}),
			).toStrictEqual({
				dateTrigger: false,
				dateAutocomplete: false,
				tagAutocomplete: false,
				detachTags: true,
				save: true,
			});
		});

		it("swallows the input that armed a chip, and does not save", () => {
			expect(
				routeTypedInput({chipArmedBefore: false, chipArmedAfter: true, datePopupOpened: false}),
			).toStrictEqual({
				dateTrigger: false,
				dateAutocomplete: false,
				tagAutocomplete: false,
				detachTags: true,
				save: false,
			});
		});

		it("skips the date autocomplete when the bang trigger opened the picker", () => {
			expect(
				routeTypedInput({chipArmedBefore: false, chipArmedAfter: false, datePopupOpened: true}),
			).toStrictEqual({
				dateTrigger: true,
				dateAutocomplete: false,
				tagAutocomplete: true,
				detachTags: false,
				save: true,
			});
		});

		it("runs every hook on an ordinary input", () => {
			expect(
				routeTypedInput({chipArmedBefore: false, chipArmedAfter: false, datePopupOpened: false}),
			).toStrictEqual({
				dateTrigger: true,
				dateAutocomplete: true,
				tagAutocomplete: true,
				detachTags: false,
				save: true,
			});
		});
	});
});

describe("inline link", () => {
	describe("bracketMatch", () => {
		it("finds an empty pair around the caret", () => {
			expect(bracketMatch("Plain P [[]]", 10)).toStrictEqual({index: 8, text: "[[]]"});
		});

		it("finds a pair holding a filter", () => {
			expect(bracketMatch("Plain P [[zq]]", 11)).toStrictEqual({index: 8, text: "[[zq]]"});
		});

		it("misses once the caret is past the pair", () => {
			expect(bracketMatch("Plain P [[zq]]", 14)).toStrictEqual({index: -1, text: ""});
		});

		it("reads the filter between the brackets", () => {
			expect(innerText(bracketMatch("Plain P [[zq]]", 11))).toBe("zq");
		});
	});

	describe("planAutoClose", () => {
		it("closes a freshly typed [[", () => {
			expect(planAutoClose("a [[", 4)).toStrictEqual({insertAt: 4, text: "]]"});
		});

		it("does nothing when a ]] already follows", () => {
			expect(planAutoClose("a [[x]]", 4)).toBeNull();
		});
	});

	describe("planLinkInsert", () => {
		it("replaces the pair with a link and one space, and puts the caret after the space", () => {
			const text = "Plain P [[Target T]]";
			const match = bracketMatch(text, 12);

			expect(planLinkInsert(text, match, "Target T", "https://workflowy.com/#/81df3e9581ea")).toStrictEqual({
				html: 'Plain P <a href="https://workflowy.com/#/81df3e9581ea">Target T</a> ',
				caret: 17,
			});
		});

		it("escapes markup in the label", () => {
			const text = "[[x]]";

			expect(
				planLinkInsert(text, bracketMatch(text, 3), "A<B>&", "https://workflowy.com/#/81df3e9581ea").html,
			).toBe('<a href="https://workflowy.com/#/81df3e9581ea">A&lt;B&gt;&amp;</a> ');
		});
	});

	describe("planInsertInlineLink", () => {
		it("adds a space before [[ after a word", () => {
			expect(planInsertInlineLink("a", 1)).toStrictEqual({text: "a [[", caret: 4});
		});

		it("inserts [[ alone in an empty row", () => {
			expect(planInsertInlineLink("", 0)).toStrictEqual({text: "[[", caret: 2});
		});

		it("inserts [[ alone after a space", () => {
			expect(planInsertInlineLink("a ", 2)).toStrictEqual({text: "a [[", caret: 4});
		});
	});
});

describe("inline mirror", () => {
	describe("planMirrorOpen", () => {
		it("opens on the second parenthesis of ((", () => {
			expect([planMirrorOpen("see ((", 5), planMirrorOpen("see (", 4), planMirrorOpen("a(b", 1)]).toStrictEqual([
				{start: 4, end: 6},
				null,
				null,
			]);
		});
	});

	describe("planMirrorRearm", () => {
		it("re-arms a resting ((query ending at the caret", () => {
			expect([
				planMirrorRearm("see ((Orig", 10),
				planMirrorRearm("see ((Orig))", 12),
				planMirrorRearm("no", 2),
			]).toStrictEqual([{start: 4, end: 10}, null, null]);
		});
	});

	describe("planInlineMirror", () => {
		it("replaces the row when nothing else is in the name", () => {
			expect(planInlineMirror({beforeHtml: "", afterHtml: ""})).toStrictEqual({kind: "replace-row"});
			expect(planInlineMirror({beforeHtml: "<b></b>", afterHtml: "&nbsp;"})).toStrictEqual({kind: "replace-row"});
		});

		it("splits the row, dropping one whitespace before the ((", () => {
			expect(planInlineMirror({beforeHtml: "see ", afterHtml: " then"})).toStrictEqual({
				kind: "split",
				before: "see",
				after: " then",
			});
			expect(planInlineMirror({beforeHtml: "see  ", afterHtml: ""})).toStrictEqual({
				kind: "split",
				before: "see ",
				after: "",
			});
		});
	});

	describe("inlineMirrorInsertion", () => {
		it("inserts (( at the start or after a space, else ' (('", () => {
			expect([
				inlineMirrorInsertion(""),
				inlineMirrorInsertion("see "),
				inlineMirrorInsertion("see"),
			]).toStrictEqual(["((", "((", " (("]);
		});
	});

	describe("inlineMirrorRefusal", () => {
		it("refuses Home, the row itself and the row's ancestors", () => {
			const lineage = ["parent", "grand"];
			expect([
				inlineMirrorRefusal({pickId: "None", rowId: "row", parentLineage: lineage}),
				inlineMirrorRefusal({pickId: "row", rowId: "row", parentLineage: lineage}),
				inlineMirrorRefusal({pickId: "grand", rowId: "row", parentLineage: lineage}),
				inlineMirrorRefusal({pickId: "other", rowId: "row", parentLineage: lineage}),
			]).toStrictEqual([
				"Cannot mirror Home",
				"Cannot mirror an item into itself",
				"Cannot mirror an item into itself",
				null,
			]);
		});
	});
});
