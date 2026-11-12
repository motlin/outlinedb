// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	return {
		useCreateNode: () => noopMutation,
		useDeleteNode: () => noopMutation,
		useMoveNode: () => noopMutation,
		useUpdateNode: () => noopMutation,
	};
});
vi.mock("../src/client/hooks/use-commit-search.js", () => (
{
	usePaneTagSearch: () => () =>
	{
	},
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {snapshot} = await import("../src/client/popups.js");
const {caretTextOffset, placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");

let root: Root | undefined;
let tagFetches = 0;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	tagFetches = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
		{
			if (url.includes("/tags/autocomplete"))
			{
				tagFetches += 1;
				return Promise.resolve(
					Response.json(
						{
							tags: [
								{
									tag: "#todo",
									count: 3,
								},
							],
						},
					),
				);
			}
			return Promise.resolve(Response.json({}));
		}),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

function mount(field: "name" | "note"): HTMLElement
{
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const editor =
		field === "name"
			? createElement(
					editableText,
					{
						nodeId: "alice",
						initialValue: "",
						parentId: null,
						priority: 0,
						isEditing: true,
					},
				)
			: createElement(
					EditableNote,
					{
						nodeId: "alice",
						initialValue: "",
						isFocused: true,
					},
				);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				editor,
			),
		);
	});
	const content = container.querySelector<HTMLElement>(
		field === "name" ? ".innerContentContainer.editing" : ".notes .content",
	);
	if (content === null)
	{
		throw new Error("editor did not render");
	}
	return content;
}

async function edit(editor: HTMLElement, text: string, inputType: string, data: string | null): Promise<void>
{
	const chip = editor.querySelector(".slash-input");
	if (chip === null)
	{
		editor.textContent = text;
		placeCaretAtTextOffset(editor, text.length);
	}
	else
	{
		chip.textContent = text;
		globalThis.getSelection()?.collapse(chip.firstChild, text.length);
	}
	act(() =>
	{
		editor.dispatchEvent(
			new InputEvent(
				"input",
				{
					bubbles: true,
					inputType,
					data,
				},
			),
		);
	});
	await act(async () =>
	{
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 20);
		});
	});
}

function press(editor: HTMLElement, init: KeyboardEventInit): KeyboardEvent
{
	const event = new KeyboardEvent(
		"keydown",
		{
			bubbles: true,
			cancelable: true,
			...init,
		},
	);
	act(() =>
	{
		editor.dispatchEvent(event);
	});
	return event;
}

describe.each(["name", "note"] as const)("slash chip keys in the %s editor", (field) =>
{
	it("Escape abandons the chip and keeps the caret offset", async () =>
	{
		const editor = mount(field);
		await edit(editor, "SG lo", "insertText", "o");
		await edit(editor, "SG lo /", "insertText", "/");
		await edit(editor, " /2*3", "insertText", "3");
		expect(editor.querySelector(".slash-input")).not.toBeNull();
		globalThis.getSelection()?.collapse(editor.querySelector(".slash-input")?.firstChild ?? null, 3);
		press(
			editor,
			{
				key: "Escape",
			},
		);
		expect(
			{
				text: editor.textContent,
				chip: editor.querySelector(".slash-input") === null,
				caret: caretTextOffset(editor),
			},
		).toStrictEqual(
			{
				text: "SG lo /2*3",
				chip: true,
				caret: 8,
			},
		);
	});

	it("Cmd+Z removes the chip and its text, swallowing the key", async () =>
	{
		const editor = mount(field);
		await edit(editor, "SG lo", "insertText", "o");
		await edit(editor, "SG lo /", "insertText", "/");
		await edit(editor, " /2*3", "insertText", "3");
		let reached = 0;
		const onKey = () =>
		{
			reached += 1;
		};
		document.addEventListener("keydown", onKey);
		const event = press(
			editor,
			{
				key: "z",
				metaKey: true,
			},
		);
		document.removeEventListener("keydown", onKey);
		expect(
			{
				text: editor.textContent,
				chip: editor.querySelector(".slash-input") === null,
				caret: caretTextOffset(editor),
				prevented: event.defaultPrevented,
				reached,
			},
		).toStrictEqual(
			{
				text: "SG lo",
				chip: true,
				caret: 5,
				prevented: true,
				reached: 0,
			},
		);
	});
});

describe.each(["name", "note"] as const)("an armed slash chip swallows typed input in the %s editor", (field) =>
{
	it("does not open the tag popup on the input that disarms the chip, then resumes", async () =>
	{
		const editor = mount(field);
		await edit(editor, "/", "insertText", "/");
		await edit(editor, "/#", "insertText", "#");
		expect(
			{
				chip: editor.querySelector(".slash-input") === null,
				tagFetches,
			},
		).toStrictEqual(
			{
				chip: true,
				tagFetches: 0,
			},
		);
		await edit(editor, "/#x", "insertText", "x");
		expect(tagFetches).toBeGreaterThan(0);
	});
});

describe("an armed slash chip owns the popup slot and the date autocomplete", () =>
{
	it("registers the chip as the suggest popup and releases it on Escape", async () =>
	{
		const editor = mount("name");
		await edit(editor, "/", "insertText", "/");
		const armed = snapshot().id;
		press(
			editor,
			{
				key: "Escape",
			},
		);
		expect(
			{
				armed,
				after: snapshot().id,
			},
		).toStrictEqual(
			{
				armed: "suggest",
				after: undefined,
			},
		);
	});

	it("offers no date flyout on the input that disarms the chip, then resumes", async () =>
	{
		const editor = mount("name");
		await edit(editor, "meet /", "insertText", "/");
		await edit(editor, " /2*3", "insertText", "3");
		await edit(editor, " /2*3x", "insertText", "x");
		expect(document.body.textContent).not.toContain("Press Tab or click here");
		await edit(editor, "meet tomorrow", "insertText", "w");
		expect(document.body.textContent).toContain("Press Tab or click here");
	});
});
