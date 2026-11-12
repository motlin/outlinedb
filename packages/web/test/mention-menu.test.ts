// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const calls:
{
	kind: string;
	args: unknown;
}[] = [];
const record = (kind: string) => (
{
	mutate: (args: unknown): void =>
	{
		calls.push(
			{
				kind,
				args,
			},
		);
	},
});
const updateMutation = record("update");
const noop =
{
	mutate: (): void =>
	{
	},
};

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useCreateNode: () => noop,
	useDeleteNode: () => noop,
	useMoveNode: () => noop,
	useUpdateNode: () => updateMutation,
	toggleComplete: (_queryClient: unknown, args: unknown) =>
	{
		calls.push(
			{
				kind: "toggle",
				args,
			},
		);
	},
}));
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
const {placeCaretAtTextOffset, caretTextOffset} = await import("../src/client/caret-dom.js");
const {accountKeys} = await import("../src/client/hooks/use-account.js");

let root: Root | undefined;
let tags:
{
	tag: string;
	count: number;
}[] = [];

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	tags = [
		{
			tag: "@mdAlpha",
			count: 2,
		},
		{
			tag: "@mdBeta",
			count: 1,
		},
	];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
		{
			if (!url.includes("/tags/autocomplete"))
			{
				return Promise.resolve(Response.json({}));
			}
			const prefix = decodeURIComponent(/prefix=([^&]*)/u.exec(url)?.[1] ?? "").toLowerCase();
			return Promise.resolve(
				Response.json(
					{
						tags: tags.filter(({tag}) => tag.toLowerCase().startsWith(prefix)),
					},
				),
			);
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
	calls.length = 0;
	vi.unstubAllGlobals();
});

function mount(field: "name" | "note", initialValue: string): HTMLElement
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(
		accountKeys.all,
		{
			userId: 7,
			fullName: "Alice Smith",
			joinedAt: "2020-01-01T00:00:00Z",
		},
	);
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
					client: queryClient,
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

async function flush(): Promise<void>
{
	await act(async () =>
	{
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 20);
		});
	});
}

/** Simulate the browser editing the field (inside the open chip, if any) to `text`, then flush the tag fetch. */
async function edit(editor: HTMLElement, text: string, inputType: string, data: string | null): Promise<void>
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
					inputType,
					data,
				},
			),
		);
	});
	await flush();
}

function key(editor: HTMLElement, name: string, init: KeyboardEventInit = {}): void
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
					...init,
				},
			),
		);
	});
}

function popup():
{
	headers: string[];
	rows: string[];
	active: string | undefined;
}
{
	const flyout = document.querySelector(".mention-popup");
	return {
		headers: [...(flyout?.querySelectorAll("[class^='mention-group-']") ?? [])].map((el) => el.textContent),
		rows: [...(flyout?.querySelectorAll("a.menuItem") ?? [])].map((el) => el.textContent),
		active: flyout?.querySelector("a.menuItem.active")?.textContent,
	};
}

describe.each(["name", "note"] as const)("mention popup in the %s editor", (field) =>
{
	it("opens on a spaced @ with a People and a Tags group and the first row active", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "X @", "insertText", "@");
		expect(
			{
				chip: editor.querySelector(".mention-input")?.textContent,
				...popup(),
			},
		).toStrictEqual(
			{
				chip: "@",
				headers: ["People", "Tags"],
				rows: ["ASAlice Smith", "@mdAlpha", "@mdBeta"],
				active: "ASAlice Smith",
			},
		);
	});

	it("wraps around with ArrowUp and drops People once the term stops matching", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "X @", "insertText", "@");
		key(editor, "ArrowUp");
		const wrapped = popup().active;
		await edit(editor, "@md", "insertText", "d");
		expect([wrapped, popup().headers]).toStrictEqual(["@mdBeta", ["Tags"]]);
	});

	it("accepts a tag with Tab in canonical case, spaced, with the caret after the space", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "X @", "insertText", "@");
		await edit(editor, "@MDa", "insertText", "a");
		key(editor, "Tab");
		await flush();
		expect(
			{
				text: editor.textContent,
				caret: caretTextOffset(editor),
				chip: editor.querySelector(".mention-input"),
				popup: document.querySelector(".mention-popup"),
			},
		).toStrictEqual(
			{
				text: "X @mdAlpha ",
				caret: 11,
				chip: null,
				popup: null,
			},
		);
	});

	it("leaves the typed text and focus when Escape abandons", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "X @", "insertText", "@");
		await edit(editor, "@md", "insertText", "d");
		key(editor, "Escape");
		expect(
			{
				text: editor.textContent,
				popup: document.querySelector(".mention-popup"),
				chip: editor.querySelector(".mention-input"),
			},
		).toStrictEqual(
			{
				text: "X @md",
				popup: null,
				chip: null,
			},
		);
	});

	it("abandons when no person or tag matches", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "X @", "insertText", "@");
		await edit(editor, "@zzq", "insertText", "q");
		expect(
			{
				text: editor.textContent,
				popup: document.querySelector(".mention-popup"),
				chip: editor.querySelector(".mention-input"),
			},
		).toStrictEqual(
			{
				text: "X @zzq",
				popup: null,
				chip: null,
			},
		);
	});

	it("removes the chip on Cmd+Z without undoing", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "X @", "insertText", "@");
		await edit(editor, "@md", "insertText", "d");
		key(
			editor,
			"z",
			{
				metaKey: true,
			},
		);
		expect(
			{
				text: editor.textContent,
				popup: document.querySelector(".mention-popup"),
			},
		).toStrictEqual(
			{
				text: "X ",
				popup: null,
			},
		);
	});

	it("re-arms the chip when a delete leaves the caret at the end of an @tag", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "X @md", "deleteContentBackward", null);
		expect(
			{
				chip: editor.querySelector(".mention-input")?.textContent,
				headers: popup().headers,
			},
		).toStrictEqual(
			{
				chip: "@md",
				headers: ["Tags"],
			},
		);
	});

	it("re-arms a rendered @tag span after a backspace at its end", async () =>
	{
		const editor = mount(field, "X @mdA");
		const tagText = editor.querySelector(".contentTag .contentTagText");
		if (tagText === null)
		{
			throw new Error("tag did not render");
		}
		tagText.textContent = "md";
		globalThis.getSelection()?.collapse(tagText.firstChild, 2);
		act(() =>
		{
			editor.dispatchEvent(
				new InputEvent(
					"input",
					{
						bubbles: true,
						inputType: "deleteContentBackward",
					},
				),
			);
		});
		await flush();
		expect(
			{
				chip: editor.querySelector(".mention-input")?.textContent,
				tags: editor.querySelectorAll(".contentTag").length,
				headers: popup().headers,
			},
		).toStrictEqual(
			{
				chip: "@md",
				tags: 0,
				headers: ["Tags"],
			},
		);
	});

	it("does not open for an @ glued to a word", async () =>
	{
		const editor = mount(field, "");
		await edit(editor, "mail@x", "insertText", "x");
		expect(document.querySelector(".mention-popup")).toBeNull();
	});
});

describe("mention accept in the name editor", () =>
{
	it("saves the tag text", async () =>
	{
		const editor = mount("name", "");
		await edit(editor, "X @", "insertText", "@");
		key(editor, "ArrowDown");
		key(editor, "Enter");
		await flush();
		expect(calls).toStrictEqual([
			{
				kind: "update",
				args:
				{
					nodeId: "alice",
					name: "X @mdAlpha ",
				},
			},
		]);
	});

	it("inserts a mention pill for the People row and saves its markup", async () =>
	{
		const editor = mount("name", "");
		await edit(editor, "X @", "insertText", "@");
		key(editor, "Enter");
		await flush();
		const saved = (
			calls.at(-1) as
			{
				args:
				{
					name: string;
				};
			}
		).args.name;
		expect(
			{
				saved: saved.replace(/ts="\d+"/u, 'ts="N"'),
				tsIsNumber: /ts="\d+"/u.test(saved),
				pill: editor.querySelector("mention.monolith-pill")?.textContent.replaceAll("﻿", ""),
			},
		).toStrictEqual(
			{
				saved: 'X <mention id="7" by="7" ts="N"> </mention> ',
				tsIsNumber: true,
				pill: "Alice Smith",
			},
		);
	});

	it("clicking a row accepts it", async () =>
	{
		const editor = mount("name", "");
		await edit(editor, "X @", "insertText", "@");
		const row = [...document.querySelectorAll<HTMLElement>(".mention-popup a.menuItem")][2];
		act(() =>
		{
			row.click();
		});
		await flush();
		expect(editor.textContent).toBe("X @mdBeta ");
	});
});
