import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import type * as Navigation from "../src/client/navigation.js";
import type {DropIndicator} from "../src/client/bullet-drag-state.js";

const outlineState =
{
	activePaneId: "main",
	expandedIds: new Set<string>(),
	animatingCompletionIds: new Set<string>(),
	slidingUpCompletionIds: new Set<string>(),
	draggingIds: [] as string[],
	movingIds: [] as string[],
	dropIndicator: null as DropIndicator | null,
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
	itemMenuOpenId: null,
	setItemMenuOpen: () =>
	{
	},
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector?: (state: typeof outlineState) => unknown) =>
		selector ? selector(outlineState) : outlineState,
	outlineActions: () => outlineState,
}));
vi.mock("../src/client/navigation.js", async (importOriginal) => (
{
	...(await importOriginal<typeof Navigation>()),
	useNodeNavigation: () => (
	{
		navigateToNode: () =>
		{
		},
	}),
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
		useFoundDates: () => (
		{
			data: undefined,
		}),
		useChildren: () => (
		{
			data: [],
			isLoading: false,
			error: null,
		}),
		useDeleteNode: () => noopMutation,
		useToggleComplete: () => noopMutation,
	};
});
vi.mock("../src/client/hooks/use-bullet-drag.js", () => (
{
	useBulletDrag: () => () =>
	{
	},
}));
vi.mock("../src/client/components/editable-text.js", () => (
{
	editableText: () => null,
}));
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
	id: "alice",
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

function projectClass(indicator: DropIndicator | null): string
{
	outlineState.dropIndicator = indicator;
	const html = renderToStaticMarkup(
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
	outlineState.dropIndicator = null;
	return /^<div projectid="[^"]*" class="([^"]*)"/u.exec(html)?.[1] ?? "";
}

describe("drop indicator row classes", () =>
{
	it("marks the row the line sits inside, the row it sits under, and no other", () =>
	{
		expect(
			{
				in: projectClass(
					{
						kind: "in",
						parentId: "alice",
						paneId: "main",
					},
				),
				at: projectClass(
					{
						kind: "at",
						rowId: "alice",
						paneId: "main",
					},
				),
				otherIn: projectClass(
					{
						kind: "in",
						parentId: "bob",
						paneId: "main",
					},
				),
				otherAt: projectClass(
					{
						kind: "at",
						rowId: "bob",
						paneId: "main",
					},
				),
				otherPane: projectClass(
					{
						kind: "in",
						parentId: "alice",
						paneId: "p1",
					},
				),
				none: projectClass(null),
			},
		).toStrictEqual(
			{
				in: "font-custom project task drag-hovered-in",
				at: "font-custom project task drag-hovered-at",
				otherIn: "font-custom project task",
				otherAt: "font-custom project task",
				otherPane: "font-custom project task",
				none: "font-custom project task",
			},
		);
	});
});
