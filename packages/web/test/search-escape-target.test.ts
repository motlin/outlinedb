// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {outlineFocusTarget} from "../src/client/search-escape.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const cancelSearch = vi.fn<() => void>();
const resumeEditing = vi.fn<(nodeId: string, offset: number) => void>();
const storeState =
{
	searchQuery: "apple",
	searchInput: "apple",
	editingId: "pie" as string | null,
	editingNoteId: null as string | null,
	zoomedNodeId: "sf" as string | null,
	searchReturn:
	{
		nodeId: "pie",
		caretOffset: 3,
	} as
	{
		nodeId: string;
		caretOffset: number;
	} | null,
	presentationOpen: false,
	requestedMenus: new Set<string>(),
	expandedIds: new Set<string>(),
	showCompleted: false,
	animatingCompletionIds: new Set<string>(),
	cancelSearch,
	resumeEditing,
	blurSearch: vi.fn<() => void>(),
	focusSearch: vi.fn<() => void>(),
};

vi.mock("../src/client/hooks/use-stable-navigate.js", () => (
{
	useStableNavigate: () => () =>
	{
	},
}));
vi.mock("../src/client/stores/outline.js", () =>
{
	const useOutlineStore = Object.assign(
		() => storeState,
		{
			getState: () => storeState,
			setState: (patch: Partial<typeof storeState>) => Object.assign(storeState, patch),
		},
	);
	return {
		useOutlineStore,
		isModalOpen: () => false,
	};
});
vi.mock("../src/client/hooks/use-visible-nodes.js", () => (
{
	collectVisibleNodeIds: () => ["fruit"],
}));
vi.mock("../src/client/hooks/use-tree-search.js", () => (
{
	currentSearchFilter: () => null,
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {useSearchEscape} = await import("../src/client/hooks/use-search-escape.js");

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
	root = undefined;
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

function Harness(): null
{
	useSearchEscape();
	return null;
}

describe("outlineFocusTarget", () =>
{
	it("targets the zoom-root title when zoomed, else the first visible row, else nothing", () =>
	{
		expect([
			outlineFocusTarget(
				{
					zoomedNodeId: "sf",
					firstVisibleId: "fruit",
				},
			),
			outlineFocusTarget(
				{
					zoomedNodeId: null,
					firstVisibleId: "a",
				},
			),
			outlineFocusTarget(
				{
					zoomedNodeId: null,
					firstVisibleId: undefined,
				},
			),
		]).toStrictEqual([
			{
				nodeId: "sf",
				offset: 0,
			},
			{
				nodeId: "a",
				offset: 0,
			},
			null,
		]);
	});
});

describe("Escape cancelling a search from a child row", () =>
{
	it("cancels the search and lands the caret on the zoom-root title at offset 0", () =>
	{
		const container = document.createElement("div");
		document.body.append(container);
		const editor = document.createElement("div");
		editor.id = "editor-pie";
		document.body.append(editor);
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: new QueryClient(),
					},
					createElement(Harness),
				),
			);
		});

		act(() =>
		{
			globalThis.dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Escape",
						cancelable: true,
					},
				),
			);
		});

		expect(
			{
				cancels: cancelSearch.mock.calls.length,
				resumed: resumeEditing.mock.calls,
				searchReturn: storeState.searchReturn,
			},
		).toStrictEqual(
			{
				cancels: 1,
				resumed: [["sf", 0]],
				searchReturn: null,
			},
		);
	});
});
