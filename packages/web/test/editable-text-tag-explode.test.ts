// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const mutate = vi.fn<(request: {nodeId: string; name: string}) => void>();
vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	const updateNode =
	{
		...noopMutation,
		mutate,
	};
	return {
		useCreateNode: () => noopMutation,
		useDeleteNode: () => noopMutation,
		useMoveNode: () => noopMutation,
		useUpdateNode: () => updateNode,
	};
});
const toggleTagSearch = vi.fn<(tag: string) => void>();
vi.mock("../src/client/hooks/use-commit-search.js", () => (
{
	usePaneTagSearch: () => toggleTagSearch,
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
const {useOutlineStore} = await import("../src/client/stores/outline.js");

let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	document.body.innerHTML = "";
	mutate.mockClear();
	toggleTagSearch.mockClear();
});

describe("EditableText tag explode", () =>
{
	it("starts the editor from the exploded name even when the row's initialValue is stale", () =>
	{
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		const queryClient = new QueryClient();
		const render = (isEditing: boolean): void =>
		{
			act(() =>
			{
				root?.render(
					createElement(
						QueryClientProvider,
						{
							client: queryClient,
						},
						createElement(
							editableText,
							{
								nodeId: "alice",
								initialValue: "Alice #todo later",
								parentId: null,
								priority: 0,
								isEditing,
							},
						),
					),
				);
			});
		};
		render(false);
		const tag = container.querySelector<HTMLElement>(".contentTag");
		if (tag === null)
		{
			throw new Error("tag did not render");
		}
		act(() =>
		{
			tag.dispatchEvent(
				new MouseEvent(
					"click",
					{
						bubbles: true,
						metaKey: true,
					},
				),
			);
		});
		expect(useOutlineStore.getState().editingId).toBe("alice");
		render(true);
		const editor = container.querySelector<HTMLElement>(".innerContentContainer.editing");
		expect(
			{
				text: editor?.textContent,
				mutations: mutate.mock.calls.map(([args]) => args),
			},
		).toStrictEqual(
			{
				text: "Alice later",
				mutations: [
					{
						nodeId: "alice",
						name: "Alice later",
					},
				],
			},
		);
	});

	it("toggles the tag in the search when a tag inside the editing row is clicked, without placing a caret", () =>
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
						client: new QueryClient(),
					},
					createElement(
						editableText,
						{
							nodeId: "alice",
							initialValue: "Alice #todo later",
							parentId: null,
							priority: 0,
							isEditing: true,
						},
					),
				),
			);
		});
		const tag = container.querySelector<HTMLElement>(".innerContentContainer.editing .contentTag");
		if (tag === null)
		{
			throw new Error("tag did not render");
		}
		const down = new MouseEvent(
			"mousedown",
			{
				bubbles: true,
				cancelable: true,
			},
		);
		act(() =>
		{
			tag.dispatchEvent(down);
			tag.dispatchEvent(
				new MouseEvent(
					"click",
					{
						bubbles: true,
						cancelable: true,
					},
				),
			);
		});
		expect(
			{
				prevented: down.defaultPrevented,
				searched: toggleTagSearch.mock.calls,
			},
		).toStrictEqual(
			{
				prevented: true,
				searched: [["#todo"]],
			},
		);
	});
});
