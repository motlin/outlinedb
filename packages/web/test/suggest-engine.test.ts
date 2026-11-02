// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {suggestInputAction} from "../src/client/suggest/suggest-engine.js";
import type {SuggestInputAction} from "../src/client/suggest/suggest-engine.js";

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
const {placeCaretAtTextOffset} = await import("../src/client/caret-dom.js");
const {triggerSuggest} = await import("../src/client/hooks/use-suggest.js");

const mention =
{
	prefix: "@",
	solid: true,
	chipClassName: "mention-input",
};
const slash =
{
	prefix: "/",
	strict: true,
	chipClassName: "slash-input",
};
const base =
{
	chipText: "",
	inserted: null,
	deleting: false,
	composing: false,
	resultsEmpty: false,
};

function action(overrides: Partial<Parameters<typeof suggestInputAction>[0]>): SuggestInputAction
{
	return suggestInputAction(
		{
			...base,
			opts: slash,
			...overrides,
		},
	);
}

describe("suggestInputAction", () =>
{
	it("abandons on a typed space in a solid chip", () =>
	{
		expect(
			action(
				{
					chipText: "@mx ",
					inserted: " ",
					opts: mention,
				},
			),
		).toBe("abandon");
	});

	it("keeps updating on a typed space when the chip is not solid", () =>
	{
		expect(
			action(
				{
					chipText: "@mx ",
					inserted: " ",
					opts:
					{
						prefix: "@",
						chipClassName: "mention-input",
					},
				},
			),
		).toBe("update");
	});

	it("abandons when a deletion damages the prefix", () =>
	{
		expect(
			action(
				{
					chipText: " mo",
					deleting: true,
				},
			),
		).toBe("abandon");
	});

	it("abandons a strict chip with no results", () =>
	{
		expect(
			action(
				{
					chipText: " /zz",
					resultsEmpty: true,
				},
			),
		).toBe("abandon");
	});

	it("only updates during composition", () =>
	{
		expect(
			action(
				{
					composing: true,
					resultsEmpty: true,
				},
			),
		).toBe("update");
	});

	it("abandons any input in a unique chip", () =>
	{
		expect(
			action(
				{
					chipText: "/a",
					opts:
					{
						prefix: "/",
						unique: true,
						chipClassName: "x",
					},
				},
			),
		).toBe("abandon");
	});

	it("updates an ordinary input", () =>
	{
		expect(
			action(
				{
					chipText: " /mo",
					inserted: "o",
				},
			),
		).toBe("update");
	});
});

describe("triggerSuggest", () =>
{
	let root: Root | undefined;
	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.resolve(Response.json({}))),
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

	it("arms the slash chip on the character before the caret", () =>
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
							initialValue: "",
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
		editor.textContent = "a /";
		placeCaretAtTextOffset(editor, 3);
		act(() =>
		{
			triggerSuggest(editor);
		});
		expect(editor.innerHTML).toBe(
			'a<span class="slash-input bg-tertiary py-2xs pr-xs pl-xs rounded-s leading-none"> /</span>',
		);
	});
});
