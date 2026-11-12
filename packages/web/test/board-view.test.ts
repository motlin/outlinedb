import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type * as ReactQuery from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import type {SearchFilter} from "../src/client/search-filter.js";

const outlineState =
{
	activePaneId: "main" as string,
	expandedIds: new Set<string>(),
	panes: [] as
	{
		id: string;
		zoomedId: string | null;
		query: string;
		expandedIds: Set<string>;
	}[],
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
	resumeEditing: vi.fn<(id: string, caretOffset: number) => void>(),
	editingId: null as string | null,
	itemSelection:
	{
		entries: [],
		pivotId: null,
		retractableIds: [],
		counter: 0,
	},
	editingClickPosition: null,
	editingNoteId: null,
	searchQuery: "",
};

function makeNode(overrides: Partial<NodeResponse>): NodeResponse
{
	return {
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
		...overrides,
	};
}

function board(id: string, parentId: string | null, over: Partial<NodeResponse> = {}): NodeResponse
{
	return makeNode(
		{
			id,
			parent_id: parentId,
			name: id,
			...over,
		},
	);
}

const childrenByParent = new Map<string | null, NodeResponse[]>();

const nodesById = new Map<string, NodeResponse>();
const createMutate = vi.fn<
	(
		payload: unknown,
		options?:
		{
			onSuccess?: (node: {id: string}) => void;
		},
	) => void
>();

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector?: (state: typeof outlineState) => unknown) =>
		selector ? selector(outlineState) : outlineState,
	outlineActions: () => outlineState,
}));
vi.mock("../src/client/navigation.js", () => (
{
	nodeUrl: (nodeId: string) => `/#/${nodeId.slice(-12)}`,
	useNodeNavigation: () => (
	{
		navigateToNode: () =>
		{
		},
	}),
}));
vi.mock("@tanstack/react-query", async (importOriginal) =>
{
	const actual = await importOriginal<typeof ReactQuery>();
	return {
		...actual,
		useQueryClient: () => actual.useQueryClient(),
	};
});
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
		useAncestors: () => (
		{
			data: undefined,
		}),
		useBacklinks: () => (
		{
			data: undefined,
		}),
		useFoundDates: () => (
		{
			data: undefined,
		}),
		useChildren: (parentId: string | null) => (
		{
			data: childrenByParent.get(parentId) ?? [],
			isLoading: false,
			isPending: false,
			error: null,
		}),
		useNode: (nodeId: string) => (
		{
			data: nodesById.get(nodeId),
		}),
		useCreateNode: () => (
		{
			mutate: createMutate,
		}),
		useDeleteNode: () => noopMutation,
		useToggleComplete: () => noopMutation,
	};
});
const currentSearch: SearchFilter | null = null;
vi.mock("../src/client/hooks/use-tree-search.js", async (importOriginal) => (
{
	...(await importOriginal<Record<string, unknown>>()),
	useSearchFilter: () => currentSearch,
	usePrefetchSearchAncestors: () =>
	{
	},
}));
vi.mock("../src/client/hooks/use-outline-view.js", () => (
{
	useOutlineViewPending: () => false,
}));
vi.mock("../src/client/hooks/use-bullet-drag.js", () => (
{
	useBulletDrag: () => () =>
	{
	},
}));
vi.mock("../src/client/components/editable-text.js", async () =>
{
	const {createElement: h} = await import("react");
	return {
		editableText: ({initialValue, isEditing, nodeId}: {initialValue: string; isEditing: boolean; nodeId: string}) =>
			h(
				"span",
				isEditing
					?
						{
							className: "innerContentContainer editing",
							"data-node-id": nodeId,
							contentEditable: true,
							suppressContentEditableWarning: true,
						}
					:
						{
							className: "innerContentContainer",
							"data-node-id": nodeId,
						},
				initialValue,
			),
	};
});
vi.mock("../src/client/components/editable-note.js", async () =>
{
	const {createElement: h} = await import("react");
	return {
		EditableNote: ({nodeId, initialValue, isMain}: {nodeId: string; initialValue: string; isMain?: boolean}) =>
			isMain
				? h(
						"div",
						{
							className: "notes notes--main",
							"data-note-of": nodeId,
						},
						initialValue,
					)
				: null,
	};
});
vi.mock("../src/client/components/node-context-menu.js", () => (
{
	ItemMenuTrigger: () => null,
}));

const {OutlineTree} = await import("../src/client/components/outline-tree.js");

function render(parentId: string | null = null, client = new QueryClient()): string
{
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client,
			},
			createElement(
				OutlineTree,
				{
					parentId,
				},
			),
		),
	);
}

function classes(html: string, marker: string): string[]
{
	return [...html.matchAll(/<div[^>]*class="([^"]*)"[^>]*>/gu)]
		.filter((match) => match[0].includes(marker))
		.map((match) => match[1]);
}

function boardNode(id: string): NodeResponse
{
	const node = nodesById.get(id);
	if (node === undefined)
	{
		throw new Error(`No node ${id}`);
	}
	return node;
}

function setup(): void
{
	const alice = board(
		"alice",
		null,
		{
			data:
			{
				layoutMode: "board",
			},
			hasChildren: true,
		},
	);
	const bob = board(
		"bob",
		"alice",
		{
			hasChildren: true,
			priority: 0,
		},
	);
	const erin = board(
		"erin",
		"alice",
		{
			hasChildren: true,
			priority: 1,
		},
	);
	const frank = board(
		"frank",
		"alice",
		{
			hasChildren: false,
			priority: 2,
		},
	);
	const carol = board(
		"carol",
		"bob",
		{
			hasChildren: false,
			priority: 0,
		},
	);
	const dave = board(
		"dave",
		"bob",
		{
			hasChildren: true,
			priority: 1,
		},
	);
	nodesById.clear();
	childrenByParent.clear();
	for (const node of [alice, bob, erin, frank, carol, dave])
	{
		nodesById.set(node.id, node);
	}
	childrenByParent.set(null, [alice]);
	childrenByParent.set("alice", [bob, erin, frank]);
	childrenByParent.set("bob", [carol, dave]);
	childrenByParent.set("dave", [
		board(
			"ed",
			"dave",
			{
				hasChildren: false,
			},
		),
	]);
}

describe("zoomed board renderer", () =>
{
	beforeEach(() =>
	{
		setup();
		outlineState.expandedIds = new Set(["bob"]);
	});

	it("renders the root, scroller, columns, cards and tiles with upstream's class strings", () =>
	{
		const html = render("alice");
		expect(
			{
				root: classes(html, 'projectid="alice"'),
				scroller: classes(html, "flex overflow-x-auto"),
				columns: [
					...classes(html, 'projectid="bob"'),
					...classes(html, 'projectid="erin"'),
					...classes(html, 'projectid="frank"'),
				],
				cards: [...classes(html, 'projectid="carol"'), ...classes(html, 'projectid="dave"')],
				columnChildren: classes(html, "vertical-scrollable-container"),
				addCard: classes(html, "self-stretch text-[0.9em]").length,
				expandLinks: html.split("Expand column").length - 1,
				addColumn: classes(html, 'grow-0 shrink-0 "').length,
				addChildButton: html.includes("addChildButton"),
				plainChildren: html.includes("mt-m mobile:ml-[-6px]"),
			},
		).toStrictEqual(
			{
				root: ["font-custom project selected root board flex flex-col h-full "],
				scroller: [
					"children relative   [.addedToSelection_&amp;]:border-l-transparent [.item--zooming-in-progress_&amp;]:border-l-transparent flex overflow-x-auto box-border !border-l-0 mt-m flex-1 min-h-0 [&amp;.children]:ml-0 [&amp;.children]:!pl-0",
				],
				columns: [
					"font-custom project open selected boardColumn group/column !ml-0 pt-0 pl-[var(--board-unread-pl)] mobile:!py-0 first:pl-3xl relative flex flex-col w-[320px] grow-0 shrink-0 overflow-x-hidden bg-primary border-r border-solid border-r-secondary [scrollbar-width:thin] [&amp;_.name]:[word-break:break-word] [&amp;_.notes]:[word-break:break-word] [&amp;.highlighted&gt;.name]:bg-transparent [&amp;.moving&gt;.name]:bg-transparent [&amp;&gt;.notes]:!pl-0 [&amp;&gt;.notes]:!ml-2xl [&amp;&gt;.notes]:!mr-2xl [&amp;&gt;.notes]:!mb-m [&amp;&gt;.notes]:!mt-s [&amp;&gt;.notes]:!pt-0 ",
					"font-custom project collapsed selected boardColumn group/column !ml-0 pt-0 pl-[var(--board-unread-pl)] mobile:!py-0 first:pl-3xl relative flex flex-col w-[320px] grow-0 shrink-0 overflow-x-hidden bg-primary border-r border-solid border-r-secondary [scrollbar-width:thin] [&amp;_.name]:[word-break:break-word] [&amp;_.notes]:[word-break:break-word] [&amp;.highlighted&gt;.name]:bg-transparent [&amp;.moving&gt;.name]:bg-transparent [&amp;&gt;.notes]:!pl-0 [&amp;&gt;.notes]:!ml-2xl [&amp;&gt;.notes]:!mr-2xl [&amp;&gt;.notes]:!mb-m [&amp;&gt;.notes]:!mt-s [&amp;&gt;.notes]:!pt-0 ",
					"font-custom project task selected boardColumn group/column !ml-0 pt-0 pl-[var(--board-unread-pl)] mobile:!py-0 first:pl-3xl relative flex flex-col w-[320px] grow-0 shrink-0 overflow-x-hidden bg-primary border-r border-solid border-r-secondary [scrollbar-width:thin] [&amp;_.name]:[word-break:break-word] [&amp;_.notes]:[word-break:break-word] [&amp;.highlighted&gt;.name]:bg-transparent [&amp;.moving&gt;.name]:bg-transparent [&amp;&gt;.notes]:!pl-0 [&amp;&gt;.notes]:!ml-2xl [&amp;&gt;.notes]:!mr-2xl [&amp;&gt;.notes]:!mb-m [&amp;&gt;.notes]:!mt-s [&amp;&gt;.notes]:!pt-0 ",
				],
				cards: [
					"font-custom project task boardCard group/card [--wf-content-padding-top:0] relative z-0 !ml-m !mr-2xl mb-ml p-s mobile:!py-m mobile:!ml-2xl desktop:!py-xs !ml-m !mr-2xl mb-ml p-s mobile:!py-m mobile:!ml-2xl desktop:!py-xs bg-[color-mix(in_srgb,_var(--wf-background-secondary)_50%,_var(--wf-background-primary)_80%)] rounded [&amp;.divider]:!border-transparent [&amp;.divider]:!bg-transparent [&amp;_.addSiblingButton]:hidden [&amp;&gt;.notes]:!ml-0 [&amp;&gt;.notes]:!pl-m ",
					"font-custom project collapsed boardCard group/card [--wf-content-padding-top:0] relative z-0 !ml-m !mr-2xl mb-ml p-s mobile:!py-m mobile:!ml-2xl desktop:!py-xs !ml-m !mr-2xl mb-ml p-s mobile:!py-m mobile:!ml-2xl desktop:!py-xs bg-[color-mix(in_srgb,_var(--wf-background-secondary)_50%,_var(--wf-background-primary)_80%)] rounded [&amp;.divider]:!border-transparent [&amp;.divider]:!bg-transparent [&amp;_.addSiblingButton]:hidden [&amp;&gt;.notes]:!ml-0 [&amp;&gt;.notes]:!pl-m ",
				],
				columnChildren: [
					"children relative ml-[10px] pl-[25px] border-l-[length:var(--wf-border-width-s)] border-solid border-l-secondary [.addedToSelection_&amp;]:border-l-transparent [.item--zooming-in-progress_&amp;]:border-l-transparent vertical-scrollable-container pl-0 !ml-0 [&amp;.children]:border-l-0 overflow-y-scroll overflow-x-hidden pt-m ",
				],
				addCard: 2,
				expandLinks: 1,
				addColumn: 1,
				addChildButton: false,
				plainChildren: false,
			},
		);
	});

	it("names the column and card with upstream's name classes", () =>
	{
		const html = render("alice");
		expect(
			{
				column: classes(html, "name--main group/name").length,
				card: classes(html, "!-ml-[40px] !pl-[48px]").length,
				untitled: html.includes("Untitled"),
			},
		).toStrictEqual(
			{
				column: 3,
				card: 2,
				untitled: false,
			},
		);
	});

	it("renders only the add-column tile, with no .children, for a childless board", () =>
	{
		childrenByParent.set("alice", []);
		nodesById.set(
			"alice",
			board(
				"alice",
				null,
				{
					data:
					{
						layoutMode: "board",
					},
					hasChildren: false,
				},
			),
		);
		const html = render("alice");
		expect(
			{
				children: html.includes('class="children'),
				tiles: classes(html, 'grow-0 shrink-0 "').length,
				root: classes(html, 'projectid="alice"'),
			},
		).toStrictEqual(
			{
				children: false,
				tiles: 1,
				root: ["font-custom project task selected root board flex flex-col h-full "],
			},
		);
	});

	it("shows Untitled in an empty column's title", () =>
	{
		nodesById.set(
			"frank",
			board(
				"frank",
				"alice",
				{
					name: "",
					hasChildren: false,
					priority: 2,
				},
			),
		);
		childrenByParent.set("alice", [
			board(
				"frank",
				"alice",
				{
					name: "",
					hasChildren: false,
					priority: 2,
				},
			),
		]);
		const html = render("alice");
		expect(html.includes('contentEditablePlaceholder">Untitled')).toBe(true);
	});
});

describe("inline board renderer", () =>
{
	it("renders an expanded board row as a 60vh strip of columns, with no outline rows", () =>
	{
		setup();
		const root = board(
			"home1",
			null,
			{
				hasChildren: true,
			},
		);
		childrenByParent.set(null, [root]);
		childrenByParent.set("home1", [boardNode("alice")]);
		outlineState.expandedIds = new Set(["home1", "alice"]);
		const html = render(null);
		expect(
			{
				strip: classes(html, "max-h-[60vh]"),
				columnHasInlineBorder: classes(html, "boardColumn").every((cls) =>
					cls.includes("border-l border-solid border-l-secondary -mr-px"),
				),
				selected: classes(html, "boardColumn").some((cls) => cls.includes(" selected ")),
			},
		).toStrictEqual(
			{
				strip: [
					"children relative   [.addedToSelection_&amp;]:border-l-transparent [.item--zooming-in-progress_&amp;]:border-l-transparent flex overflow-x-auto box-border !border-l-0 opacity-0 max-h-[60vh] [&amp;.children]:ml-0",
				],
				columnHasInlineBorder: true,
				selected: false,
			},
		);
	});

	it("renders a board nested in a board card as a plain list without the board class", () =>
	{
		setup();
		const root = board(
			"home1",
			null,
			{
				data:
				{
					layoutMode: "board",
				},
				hasChildren: true,
			},
		);
		nodesById.set("home1", root);
		childrenByParent.set(null, [root]);
		childrenByParent.set("home1", [
			board(
				"col",
				"home1",
				{
					hasChildren: true,
				},
			),
		]);
		childrenByParent.set("col", [
			board(
				"card",
				"col",
				{
					hasChildren: true,
				},
			),
		]);
		childrenByParent.set("card", [
			board(
				"inner",
				"card",
				{
					data:
					{
						layoutMode: "board",
					},
					hasChildren: true,
				},
			),
		]);
		childrenByParent.set("inner", [
			board(
				"innerCol",
				"inner",
				{
					hasChildren: true,
				},
			),
		]);
		childrenByParent.set("innerCol", [board("innerCard", "innerCol")]);
		outlineState.expandedIds = new Set(["col", "card", "inner", "innerCol"]);
		const html = render("home1");
		expect(
			{
				innerClasses: classes(html, 'projectid="inner"'),
				boardColumns: html.split("boardColumn").length - 1,
				strips: html.split("max-h-[60vh]").length - 1,
			},
		).toStrictEqual(
			{
				innerClasses: ["font-custom project open"],
				boardColumns: 1,
				strips: 0,
			},
		);
	});

	it("drops the board class from a board that is a board column", () =>
	{
		setup();
		const boardRoot = board(
			"home2",
			null,
			{
				data:
				{
					layoutMode: "board",
				},
				hasChildren: true,
			},
		);
		nodesById.set("home2", boardRoot);
		childrenByParent.set(null, [boardRoot]);
		childrenByParent.set("home2", [
			board(
				"col2",
				"home2",
				{
					data:
					{
						layoutMode: "board",
					},
				},
			),
		]);
		const column = classes(render("home2"), 'projectid="col2"');
		expect(
			{
				columnHasBoard: column.some((cls) => cls.split(" ").includes("board")),
				columnHasBoardColumn: column.some((cls) => cls.includes("boardColumn")),
			},
		).toStrictEqual(
			{
				columnHasBoard: false,
				columnHasBoardColumn: true,
			},
		);
	});
});
