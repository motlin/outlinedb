// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// One `mutate` for every render, like react-query's.
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
// Every slash term resolves (to an unfinished sum), so a "#" typed into the chip keeps the menu open.
vi.mock("../src/client/slash-math.js", () => (
{
	evalMath: () => "incomplete",
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");

let root: Root | undefined;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
			Promise.resolve(
				url.includes("/tags/autocomplete")
					? Response.json(
							{
								tags: [
									{
										tag: "#todo",
										count: 3,
									},
									{
										tag: "#today",
										count: 1,
									},
								],
							},
						)
					: Response.json({}),
			),
		),
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

function mount(field: "name" | "note", initialValue: string): HTMLElement
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
						initialValue,
						parentId: null,
						priority: 0,
						isEditing: true,
					},
				)
			: createElement(
					EditableNote,
					{
						nodeId: "alice",
						initialValue,
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

/** Simulate the browser editing the field (inside the open slash chip, if any) to `text`, then flush the tag fetch. */
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

function popups():
{
	slashMenu: boolean;
	tagPopup: boolean;
}
{
	return {
		slashMenu: document.querySelector("[class^='mention-group-']") !== null,
		tagPopup: document.querySelector("[data-popper-placement]") !== null,
	};
}

describe.each(["name", "note"] as const)("inline suggest popups in the %s editor", (field) =>
{
	it("keeps only the slash menu when a tag trigger is typed inside the open slash chip", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "/", "insertText", "/");
		await edit(editor, "/#", "insertText", "#");
		expect(popups()).toStrictEqual(
			{
				slashMenu: true,
				tagPopup: false,
			},
		);
	});
});

describe.each(["name", "note"] as const)("mention chip in the %s editor", (field) =>
{
	it("keeps only the mention popup when a tag trigger is typed inside the open mention chip", async () =>
	{
		const editor = mount(field, "");
		const chipEdit = async (text: string, data: string) =>
		{
			const chip = editor.querySelector(".mention-input");
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
							inputType: "insertText",
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
		};
		await chipEdit("x @", "@");
		await chipEdit("@#", "#");
		expect(
			{
				chip: editor.querySelector(".mention-input")?.textContent,
				mentionPopup: document.querySelector(".mention-popup") !== null,
				tagPopup: popups().tagPopup,
			},
		).toStrictEqual(
			{
				chip: "@#",
				mentionPopup: true,
				tagPopup: false,
			},
		);
	});
});

describe("tag retagging in the name editor", () =>
{
	it("settles when a name that opens with a slash and a tag is typed into and deleted back", async () =>
	{
		const editor = mount("name", "/#to");
		await edit(editor, "/#too", "insertText", "o");
		await edit(editor, "/#to", "deleteContentBackward", null);
		await edit(editor, "/#t", "deleteContentBackward", null);
		expect(
			{
				html: editor.innerHTML,
				connected: editor.isConnected,
				slashMenu: popups().slashMenu,
			},
		).toStrictEqual(
			{
				html: '/<span class="contentTag explosive" title="Filter #t" data-val="#t">#<span class="contentTagText">t</span><span class="contentTagNub"></span></span>',
				connected: true,
				slashMenu: false,
			},
		);
	}, 3000);
});
