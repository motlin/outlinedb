// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const updates: Record<string, unknown>[] = [];
const toggles: unknown[] = [];

vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	return {
		useCreateNode: () => noopMutation,
		useDeleteNode: () => noopMutation,
		useMoveNode: () => noopMutation,
		syncNodeChanges: async () => Promise.resolve(),
		useUpdateNode: () => (
		{
			mutate: (update: Record<string, unknown>) =>
			{
				updates.push(update);
			},
		}),
		toggleComplete: (_client: unknown, variables: unknown) =>
		{
			toggles.push(variables);
		},
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

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {caretTextOffset, placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");
const {nodeKeys} = await import("../src/client/node-cache.js");
const {useAlertStore} = await import("../src/client/alert.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

let root: Root | undefined;
const fetches:
{
	url: string;
	body: unknown;
}[] = [];

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() =>
{
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (
				url: string,
				init?:
				{
					body?: string;
				},
			) =>
			{
				if (!url.includes("/nodes/trees"))
				{
					return Promise.resolve(
						new Response(
							"{}",
							{
								status: 404,
							},
						),
					);
				}
				fetches.push(
					{
						url,
						body: init?.body === undefined ? undefined : JSON.parse(init.body),
					},
				);
				return Promise.resolve(
					Response.json(
						{
							ids: ["new-1", "new-2"],
						},
						{
							status: 201,
						},
					),
				);
			},
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
	updates.length = 0;
	toggles.length = 0;
	fetches.length = 0;
	vi.unstubAllGlobals();
	useAlertStore.setState(
		{
			alert: null,
		},
	);
});

function node(overrides: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		id: "alice",
		parent_id: null,
		name: "",
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: 0,
		modifiedAt: 0,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		isMirror: false,
		...overrides,
	};
}

function mountEditor(initialValue: string, row: Partial<NodeResponse> = {}): HTMLElement
{
	const client = new QueryClient();
	client.setQueryData(nodeKeys.children(null), [
		node(
			{
				name: initialValue,
				...row,
			},
		),
	]);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client,
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

function paste(editor: HTMLElement, data: Record<string, string>): boolean
{
	const event = new Event(
		"paste",
		{
			bubbles: true,
			cancelable: true,
		},
	);
	Object.defineProperty(
		event,
		"clipboardData",
		{
			value:
			{
				getData: (type: string) => data[type] ?? "",
				files: [],
			},
		},
	);
	act(() =>
	{
		editor.dispatchEvent(event);
	});
	return event.defaultPrevented;
}

describe("EditableText paste", () =>
{
	it("splices a single line into the row without creating rows", async () =>
	{
		const editor = mountEditor("T1");
		placeCaretAtTextOffset(editor, 2);
		const prevented = paste(
			editor,
			{
				"text/plain": "   x  ",
			},
		);
		await act(async () => {});
		expect(
			{
				prevented,
				text: editor.textContent,
				caret: caretTextOffset(editor),
				fetches,
			},
		).toStrictEqual(
			{
				prevented: true,
				text: "T1   x  ",
				caret: 8,
				fetches: [],
			},
		);
		expect(updates).toStrictEqual([
			{
				nodeId: "alice",
				name: "T1   x  ",
			},
		]);
	});

	it("keeps newlines in a quote-block row and creates no rows (D4)", async () =>
	{
		const editor = mountEditor(
			"Quote row",
			{
				data:
				{
					layoutMode: "quote-block",
				},
			},
		);
		placeCaretAtTextOffset(editor, 9);
		paste(
			editor,
			{
				"text/plain": "\nq1\nq2 <x>",
			},
		);
		await act(async () => {});
		expect(
			{
				text: editor.textContent,
				caret: caretTextOffset(editor),
				fetches,
			},
		).toStrictEqual(
			{
				text: "Quote row\nq1\nq2 <x>",
				caret: 19,
				fetches: [],
			},
		);
	});

	it("inserts a code-block row's text trimmed as one row", async () =>
	{
		const editor = mountEditor(
			"code",
			{
				data:
				{
					layoutMode: "code-block",
				},
			},
		);
		placeCaretAtTextOffset(editor, 4);
		paste(
			editor,
			{
				"text/plain": "  x = 1\n  y <b>2</b>\n",
				"text/html": "<pre>x</pre>",
			},
		);
		await act(async () => {});
		expect(
			{
				text: editor.textContent,
				fetches,
			},
		).toStrictEqual(
			{
				text: "codex = 1\n  y <b>2</b>",
				fetches: [],
			},
		);
	});

	it("merges the first line and posts one bulk create for the rest (U1)", async () =>
	{
		const editor = mountEditor("P1");
		placeCaretAtTextOffset(editor, 2);
		paste(
			editor,
			{
				"text/plain": "one\ntwo\n  three\nfour",
			},
		);
		await act(async () =>
		{
			await new Promise<void>((resolve) =>
			{
				setTimeout(resolve, 20);
			});
		});
		expect(updates).toStrictEqual([
			{
				nodeId: "alice",
				name: "P1one",
			},
		]);
		expect(fetches).toStrictEqual([
			{
				url: "/api/v1/nodes/trees",
				body:
				{
					parent_id: null,
					after_id: "alice",
					trees: [
						{
							name: "two",
							children: [
								{
									name: "three",
								},
							],
						},
						{
							name: "four",
						},
					],
				},
			},
		]);
		expect(useOutlineStore.getState().editingId).toBe("new-2");
	});

	it("shows the upstream alert instead of pasting more than 10000 lines (D12)", async () =>
	{
		const editor = mountEditor("");
		paste(
			editor,
			{
				"text/plain": Array.from(
					{
						length: 10_001,
					},
					() => "x",
				).join("\n"),
			},
		);
		await act(async () => {});
		expect(
			{
				alert: useAlertStore.getState().alert,
				fetches,
				updates,
			},
		).toStrictEqual(
			{
				alert:
				{
					title: "Error",
					message: "Pasting more than 10000 items at a time is not supported.",
				},
				fetches: [],
				updates: [],
			},
		);
	});
});
