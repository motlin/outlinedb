import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";

/**
 * What one resting row holds: a navigation into a heavy view mounts a screen of rows and unmounts the last one in a
 * single task, and every store selector, query and mutation observer a row holds is a subscription made, checked on
 * each store write, and torn down there.
 */
const hooks =
{
	store: 0,
	searchFilter: 0,
	toggleComplete: 0,
	moveNodes: 0,
};

const outlineState =
{
	activePaneId: "main",
	expandedIds: new Set<string>(),
	animatingCompletionIds: new Set<string>(),
	slidingUpCompletionIds: new Set<string>(),
	draggingIds: [] as string[],
	movingIds: [] as string[],
	slidingDownCompletedIds: new Set<string>(),
	endCompletionAnimation: () =>
	{
	},
	showCompleted: true,
	toggleExpand: () =>
	{
	},
	resumeEditing: () =>
	{
	},
	editingId: null,
	itemSelection:
	{
		entries: [],
		pivotId: null,
		retractableIds: [],
		counter: 0,
	},
	editingClickPosition: null,
	editingNoteId: null,
	itemMenuOpenId: null as string | null,
	setItemMenuOpen: () =>
	{
	},
	dropIndicator: null,
	addErrorNotification: () =>
	{
	},
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector?: (state: typeof outlineState) => unknown) =>
	{
		hooks.store += 1;
		return selector ? selector(outlineState) : outlineState;
	},
	outlineActions: () => outlineState,
}));
vi.mock("../src/client/hooks/use-tree-search.js", () => (
{
	useSearchFilter: () =>
	{
		hooks.searchFilter += 1;
		return null;
	},
}));
vi.mock("../src/client/hooks/use-zoom-to.js", () => (
{
	useZoomTo: () => async () =>
	{
	},
}));
vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	return {
		useExpandAll: () => () =>
		{
		},
		useBacklinks: () => (
		{
			data: undefined,
		}),
		useChildren: () => (
		{
			data: [],
			isLoading: false,
			error: null,
		}),
		useToggleComplete: () =>
		{
			hooks.toggleComplete += 1;
			return noopMutation;
		},
		useMoveNodes: () =>
		{
			hooks.moveNodes += 1;
			return noopMutation;
		},
	};
});
vi.mock("../src/client/components/editable-text.js", async () =>
{
	const {createElement: h} = await import("react");
	return {
		editableText: ({initialValue}: {initialValue: string}) =>
			h(
				"span",
				{
					className: "innerContentContainer",
				},
				initialValue,
			),
	};
});
vi.mock("../src/client/components/editable-note.js", () => (
{
	EditableNote: () => null,
}));
vi.mock("../src/client/components/node-context-menu.js", () => (
{
	ItemMenuTrigger: () => null,
}));

const {OutlineRow} = await import("../src/client/components/outline-node.js");

const ALICE: NodeResponse =
{
	id: "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa",
	parent_id: null,
	name: "Alice",
	note: null,
	priority: 0,
	data:
	{
		layoutMode: null,
	},
	createdAt: null,
	modifiedAt: null,
	completedAt: null,
	hasChildren: false,
};

describe("a resting row's subscriptions", () =>
{
	it("selects the outline store once, and holds no search query or mutation observer", () =>
	{
		hooks.store = 0;
		hooks.searchFilter = 0;
		hooks.toggleComplete = 0;
		hooks.moveNodes = 0;
		renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					OutlineRow,
					{
						node: ALICE,
					},
				),
			),
		);
		expect(hooks).toStrictEqual(
			{
				store: 1,
				searchFilter: 0,
				toggleComplete: 0,
				moveNodes: 0,
			},
		);
	});
});
