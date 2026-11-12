// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const TARGET_ID = "00000000-0000-4000-8000-81df3e9581ea";
const HOME_ID = "None";

const updates = vi.hoisted(
	() =>
		[] as
		{
			nodeId: string;
			name?: string;
		}[],
);
const fetched = vi.hoisted(() => (
{
	name: "Target T",
}));

vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	const updateMutation =
	{
		mutate: (request: {nodeId: string; name?: string}) =>
		{
			updates.push(request);
		},
	};
	return {
		useCreateNode: () => noopMutation,
		useDeleteNode: () => noopMutation,
		useMoveNode: () => noopMutation,
		useUpdateNode: () => updateMutation,
		fetchNode: async () =>
			Promise.resolve(
				{
					id: TARGET_ID,
					name: fetched.name,
				},
			),
		fetchAncestors: async () => Promise.resolve([]),
	};
});
vi.mock("../src/client/hooks/use-commit-search.js", () => (
{
	usePaneTagSearch: () => () =>
	{
	},
}));
vi.mock("../src/client/hooks/use-tag-colors.js", () => (
{
	useRemoveTagColor: () => (
	{
		mutate: () =>
		{
		},
	}),
	useSetTagColor: () => (
	{
		mutate: () =>
		{
		},
	}),
	useTagColors: () => ({}),
}));
vi.mock(import("../src/client/breadcrumb-layout.js"), async (importOriginal) => (
{
	...(await importOriginal()),
	measureCrumbLabel: (label: string) => label.length * 7,
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {LocationPickerHost} = await import("../src/client/components/location-picker-host.js");
const {caretTextOffset, placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

let root: Root | undefined;
let hits:
{
	id: string;
	labelHtml: string;
	ancestors: never[];
}[] = [];

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() =>
{
	updates.length = 0;
	fetched.name = "Target T";
	hits = [
		{
			id: TARGET_ID,
			labelHtml: "<b><u>Tar</u></b>get T",
			ancestors: [],
		},
	];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
			Promise.resolve(
				url === "/api/search/locations"
					? Response.json(
							{
								results: hits,
							},
						)
					: new Response(
							"{}",
							{
								status: 404,
							},
						),
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
	document.body.innerHTML = "";
	useOutlineStore.setState(
		{
			locationPicker: null,
			appMessage: null,
		},
	);
	vi.unstubAllGlobals();
});

function mountEditor(initialValue: string): HTMLElement
{
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(
						{
							defaultOptions:
							{
								queries:
								{
									retry: false,
								},
							},
						},
					),
				},
				createElement(
					editableText,
					{
						nodeId: "alice",
						initialValue,
						parentId: null,
						priority: 0,
						isEditing: true,
					},
				),
				createElement(LocationPickerHost),
			),
		);
	});
	const editor = container.querySelector<HTMLElement>(".innerContentContainer.editing");
	if (editor === null)
	{
		throw new Error("editor did not render");
	}
	return editor;
}

/** Simulate the browser inserting `data`: the DOM text becomes `text` with the caret at `caret`, then `input` fires. */
function typeAt(editor: HTMLElement, text: string, caret: number, data: string): void
{
	editor.textContent = text;
	placeCaretAtTextOffset(editor, caret);
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
}

async function settle(): Promise<void>
{
	await act(async () =>
	{
		await new Promise<void>((resolve) =>
		{
			setTimeout(resolve, 0);
		});
	});
}

function key(editor: HTMLElement, name: string): void
{
	act(() =>
	{
		editor.dispatchEvent(
			new KeyboardEvent(
				"keydown",
				{
					key: name,
					bubbles: true,
					cancelable: true,
				},
			),
		);
	});
}

function moveCaret(editor: HTMLElement, offset: number): void
{
	placeCaretAtTextOffset(editor, offset);
	act(() =>
	{
		document.dispatchEvent(new Event("selectionchange"));
	});
}

const header = () => document.body.querySelector(".menu-section-header")?.textContent ?? null;
const pickerInputs = () => document.body.querySelectorAll("input[name=location-picker-query], input[type=text]").length;
const LINK = '<a href="https://workflowy.com/#/81df3e9581ea">Target T</a>';

describe("the [[ inline link popup", () =>
{
	it("closes a typed [[ with ]] and opens the link-to menu without an input", async () =>
	{
		const editor = mountEditor("x");

		typeAt(editor, "x [[", 4, "[");
		await settle();

		expect(
			{
				text: editor.textContent,
				caret: caretTextOffset(editor),
				header: header(),
				inputs: pickerInputs(),
			},
		).toStrictEqual(
			{
				text: "x [[]]",
				caret: 4,
				header: "link to",
				inputs: 0,
			},
		);
	});

	it("links the picked item and saves the name, then closes the popup", async () =>
	{
		const editor = mountEditor("x");
		typeAt(editor, "x [[", 4, "[");
		typeAt(editor, "x [[Tar]]", 7, "r");
		await settle();

		key(editor, "Enter");
		await settle();

		expect(
			{
				saved: updates.map((update) => update.name),
				text: editor.textContent,
				caret: caretTextOffset(editor),
				open: header(),
			},
		).toStrictEqual(
			{
				saved: [`x ${LINK} `],
				text: "x Target T ",
				caret: 11,
				open: null,
			},
		);
	});

	it("keeps the text on Escape, reopens when the caret moves back in, and closes when it moves out", async () =>
	{
		const editor = mountEditor("x");
		typeAt(editor, "x [[", 4, "[");
		typeAt(editor, "x [[Tar]]", 7, "r");
		await settle();

		key(editor, "Escape");
		await settle();
		const afterEscape =
		{
			text: editor.textContent,
			open: header(),
		};
		moveCaret(editor, 6);
		await settle();
		const afterLeft = header();
		moveCaret(editor, 9);
		await settle();

		expect(
			{
				afterEscape,
				afterLeft,
				afterEnd: header(),
			},
		).toStrictEqual(
			{
				afterEscape:
				{
					text: "x [[Tar]]",
					open: null,
				},
				afterLeft: "link to",
				afterEnd: null,
			},
		);
	});

	it("refuses to link Home and saves nothing", async () =>
	{
		hits = [
			{
				id: HOME_ID,
				labelHtml: "Home",
				ancestors: [],
			},
		];
		const editor = mountEditor("x");
		typeAt(editor, "x [[", 4, "[");
		typeAt(editor, "x [[Ho]]", 6, "o");
		await settle();

		key(editor, "Enter");
		await settle();

		const message = useOutlineStore.getState().appMessage;
		expect(
			{
				saved: updates,
				message: message?.text,
				type: message?.type,
			},
		).toStrictEqual(
			{
				saved: [],
				message: "Cannot link Home",
				type: "failure",
			},
		);
	});

	it("links the target's rendered plain text, with a date pill in the account format (the default omits the current year)", async () =>
	{
		fetched.name = '<b>Bold</b> <time startYear="2026" startMonth="10" startDay="1">x</time>';
		const editor = mountEditor("x");
		typeAt(editor, "x [[", 4, "[");
		typeAt(editor, "x [[Tar]]", 7, "r");
		await settle();

		key(editor, "Enter");
		await settle();

		expect(updates.map((update) => update.name)).toStrictEqual([
			'x <a href="https://workflowy.com/#/81df3e9581ea">Bold Thu, Oct 1</a> ',
		]);
	});

	it("closes when the editor blurs to the page", async () =>
	{
		const editor = mountEditor("x");
		typeAt(editor, "x [[", 4, "[");
		await settle();

		act(() =>
		{
			editor.dispatchEvent(
				new FocusEvent(
					"focusout",
					{
						bubbles: true,
						relatedTarget: document.body,
					},
				),
			);
		});

		expect(header()).toBeNull();
	});

	it("stays open when focus moves into the flyout", async () =>
	{
		const editor = mountEditor("x");
		typeAt(editor, "x [[", 4, "[");
		typeAt(editor, "x [[Tar]]", 7, "r");
		await settle();
		const row = document.body.querySelector<HTMLElement>("[data-popper-placement] .menuItem");

		act(() =>
		{
			editor.dispatchEvent(
				new FocusEvent(
					"focusout",
					{
						bubbles: true,
						relatedTarget: row,
					},
				),
			);
		});

		expect(header()).toBe("link to");
	});
});
