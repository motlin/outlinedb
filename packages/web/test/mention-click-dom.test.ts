// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const searches: string[] = [];
const updates: unknown[] = [];

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useCreateNode: () => (
	{
		mutate: (): void =>
		{
		},
	}),
	useDeleteNode: () => (
	{
		mutate: (): void =>
		{
		},
	}),
	useMoveNode: () => (
	{
		mutate: (): void =>
		{
		},
	}),
	useUpdateNode: () => (
	{
		mutate: (args: unknown): void =>
		{
			updates.push(args);
		},
	}),
}));
vi.mock("../src/client/hooks/use-commit-search.js", () => (
{
	usePaneTagSearch: () => () =>
	{
	},
}));
vi.mock("../src/client/hooks/use-pane-search.js", () => (
{
	usePaneSearch: () => (query: string) =>
	{
		searches.push(query);
	},
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {editableText} = await import("../src/client/components/editable-text.js");
const {accountKeys} = await import("../src/client/hooks/use-account.js");

let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("fetch", async () => Promise.resolve(Response.json({})));
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	document.body.innerHTML = "";
	searches.length = 0;
	updates.length = 0;
});

function mountResting(initialValue: string): HTMLElement
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(
		accountKeys.all,
		{
			userId: 7,
			fullName: "Alice Smith",
		},
	);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
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
						initialValue,
						parentId: null,
						priority: 0,
						isEditing: false,
					},
				),
			),
		);
	});
	return container;
}

function click(element: Element, init: MouseEventInit = {}): void
{
	act(() =>
	{
		element.dispatchEvent(
			new MouseEvent(
				"click",
				{
					bubbles: true,
					cancelable: true,
					...init,
				},
			),
		);
	});
}

describe("mention pill click", () =>
{
	it("searches mentioned:Everyone for the everyone pill", () =>
	{
		const container = mountResting('hi <mention id="0" by="7" ts="1"> </mention>');
		const pill = container.querySelector("mention");
		if (pill === null)
		{
			throw new Error("pill did not render");
		}
		click(pill);
		expect(
			{
				searches,
				updates,
				tapped: pill.classList.contains("tapped"),
			},
		).toStrictEqual(
			{
				searches: ['mentioned:"Everyone"'],
				updates: [],
				tapped: true,
			},
		);
	});

	it("deletes the pill on a Meta-click", () =>
	{
		const container = mountResting('hi <mention id="7" by="7" ts="1"> </mention>');
		const pill = container.querySelector("mention");
		if (pill === null)
		{
			throw new Error("pill did not render");
		}
		click(
			pill,
			{
				metaKey: true,
				altKey: true,
			},
		);
		expect(
			{
				searches,
				updates,
			},
		).toStrictEqual(
			{
				searches: [],
				updates: [
					{
						nodeId: "alice",
						name: "hi ",
					},
				],
			},
		);
	});
});
