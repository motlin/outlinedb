// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {wrapBareNoteText} from "../src/client/note-text.js";

describe("wrapBareNoteText", () =>
{
	it("wraps bare text nodes in .innerContentContainer and keeps the caret", () =>
	{
		const element = document.createElement("div");
		element.append(document.createTextNode("abc"));
		document.body.append(element);
		const textNode = element.firstChild as Text;
		const range = document.createRange();
		range.setStart(textNode, 3);
		range.collapse(true);
		globalThis.getSelection()?.removeAllRanges();
		globalThis.getSelection()?.addRange(range);
		wrapBareNoteText(element);
		const selected = globalThis.getSelection();
		const before = document.createRange();
		before.selectNodeContents(element);
		before.setEnd(selected!.anchorNode!, selected!.anchorOffset);
		expect(
			{
				html: element.innerHTML,
				caret: before.toString().length,
			},
		).toStrictEqual(
			{
				html: '<span class="innerContentContainer">abc</span>',
				caret: 3,
			},
		);
		element.remove();
	});
});
