// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {caretTextOffset, placeCaretAtTextOffset} from "../src/client/caret-dom.js";
import {applyInlineCodeInput} from "../src/client/inline-code-edit.js";

function editorWith(html: string, caret: number): HTMLElement
{
	const editor = document.createElement("div");
	editor.contentEditable = "true";
	editor.innerHTML = html;
	document.body.append(editor);
	placeCaretAtTextOffset(editor, caret);
	return editor;
}

const io =
{
	read: (editor: HTMLElement) => () => editor.innerHTML,
	render: (html: string) => html,
};

function typed(data: string, inputType = "insertText"): InputEvent
{
	return new InputEvent(
		"input",
		{
			inputType,
			data,
		},
	);
}

describe("applyInlineCodeInput", () =>
{
	it("turns a typed closing backtick into code and moves the caret after the added space", () =>
	{
		const editor = editorWith("a `bc`", 6);
		const stored = applyInlineCodeInput(
			editor,
			typed("`"),
			{
				read: io.read(editor),
				render: io.render,
			},
		);
		expect(
			{
				stored,
				html: editor.innerHTML,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				stored: "a <code>bc</code> ",
				html: "a <code>bc</code> ",
				caret: 5,
			},
		);
	});

	it("leaves plain typing, deletions and compositions alone", () =>
	{
		const editor = editorWith("a `bc`", 6);
		const options =
		{
			read: io.read(editor),
			render: io.render,
		};
		expect([
			applyInlineCodeInput(editor, typed("`", "deleteContentBackward"), options),
			applyInlineCodeInput(
				editor,
				new InputEvent(
					"input",
					{
						inputType: "insertText",
						data: "`",
						isComposing: true,
					},
				),
				options,
			),
			applyInlineCodeInput(editor, undefined, options),
			editor.innerHTML,
		]).toStrictEqual([null, null, null, "a `bc`"]);
	});
});
