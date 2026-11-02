// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const mutate = vi.fn<(request: {nodeId: string; note?: string}) => void>();
const toggleTagSearch = vi.fn<(tag: string) => void>();
vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	const updateNode =
	{
		...noopMutation,
		mutate,
	};
	return {
		useUpdateNode: () => updateNode,
	};
});
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
const {EditableNote} = await import("../src/client/components/editable-note.js");
const {resetPopupsForTests} = await import("../src/client/popups.js");

let root: Root | undefined;

beforeAll(() =>
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
	document.body.innerHTML = "";
	resetPopupsForTests();
	mutate.mockClear();
	toggleTagSearch.mockClear();
});

function mountNote(): HTMLElement
{
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					EditableNote,
					{
						nodeId: "alice",
						initialValue: "see #todo later",
						isFocused: false,
					},
				),
			),
		);
	});
	const tag = host.querySelector<HTMLElement>(".contentTag");
	if (!tag)
	{
		throw new Error("no rendered note tag");
	}
	return tag;
}

describe("note tag pointer handling", () =>
{
	it("toggles the tag in the search on a plain click", () =>
	{
		const tag = mountNote();
		act(() =>
		{
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
		expect(toggleTagSearch.mock.calls).toStrictEqual([["#todo"]]);
	});

	it("explodes the tag out of the NOTE on a Meta-click", () =>
	{
		const tag = mountNote();
		act(() =>
		{
			tag.dispatchEvent(
				new MouseEvent(
					"click",
					{
						bubbles: true,
						cancelable: true,
						metaKey: true,
						altKey: true,
					},
				),
			);
		});
		expect(mutate.mock.calls).toStrictEqual([
			[
				{
					nodeId: "alice",
					note: "see later",
				},
			],
		]);
	});

	it("shows the color teaser when hovering a note tag", () =>
	{
		const tag = mountNote();
		act(() =>
		{
			tag.dispatchEvent(
				new MouseEvent(
					"mouseover",
					{
						bubbles: true,
					},
				),
			);
		});
		expect(document.querySelector(".tag-color-teaser")).not.toBeNull();
	});
});
