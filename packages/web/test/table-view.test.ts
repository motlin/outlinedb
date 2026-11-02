import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type * as ReactQuery from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import type {SearchFilter} from "../src/client/search-filter.js";
import {setAccountFeatures} from "../src/client/features.js";

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
		useMoveNode: () => noopMutation,
		useUpdateNode: () => noopMutation,
		copyNodesAt: async () => Promise.resolve([]),
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

function node(id: string, parentId: string | null, over: Partial<NodeResponse> = {}): NodeResponse
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

function leaf(id: string, parentId: string, over: Partial<NodeResponse>): NodeResponse
{
	return node(
		id,
		parentId,
		{
			hasChildren: false,
			...over,
		},
	);
}

function setup(): void
{
	const alice = node(
		"alice",
		null,
		{
			data:
			{
				layoutMode: "table",
			},
			hasChildren: true,
		},
	);
	const r0 = node(
		"r0",
		"alice",
		{
			hasChildren: true,
			priority: 0,
		},
	);
	const r1 = node(
		"r1",
		"alice",
		{
			hasChildren: true,
			priority: 1,
		},
	);
	const r2 = node(
		"r2",
		"alice",
		{
			hasChildren: true,
			priority: 2,
		},
	);
	const name = leaf(
		"name",
		"r0",
		{
			name: "Name",
			priority: 0,
		},
	);
	const qty = leaf(
		"qty",
		"r0",
		{
			name: "Qty",
			priority: 1,
		},
	);
	const apple = leaf(
		"apple",
		"r1",
		{
			name: "Apple",
			priority: 0,
		},
	);
	const red = node(
		"red",
		"r1",
		{
			name: "red",
			priority: 1,
			hasChildren: true,
		},
	);
	const pear = leaf(
		"pear",
		"r2",
		{
			name: "Pear",
			priority: 0,
		},
	);
	nodesById.clear();
	childrenByParent.clear();
	for (const n of [alice, r0, r1, r2, name, qty, apple, red, pear])
	{
		nodesById.set(n.id, n);
	}
	childrenByParent.set(null, [alice]);
	childrenByParent.set("alice", [r0, r1, r2]);
	childrenByParent.set("r0", [name, qty]);
	childrenByParent.set("r1", [apple, red]);
	childrenByParent.set("r2", [pear]);
	childrenByParent.set("red", [leaf("nested", "red", {})]);
}

const CELL_BASE =
	"table-cell relative tableCell group/cell box-border relative z-0 !m-0 p-xs pl-m mobile:!py-m mobile:!ml-0 border-b border-primary border-solid [&amp;_.addSiblingButton]:hidden [&amp;_.contentEditablePlaceholder]:!leading-[var(--font-default-line-height)] [&amp;&gt;.notes]:!ml-0 [&amp;&gt;.notes]:!pl-0 border-l border-r border-solid border-primary bg-primary [--wf-content-padding-top:0]";

describe("zoomed table renderer", () =>
{
	beforeEach(() =>
	{
		setup();
		outlineState.expandedIds = new Set();
	});

	it("renders the root, scroller, rows and cells with upstream's class strings", () =>
	{
		const html = render("alice");
		expect(
			{
				root: classes(html, 'projectid="alice"'),
				scroller: classes(html, "overflow-x-auto"),
				children: classes(html, "children table"),
				rows: classes(html, 'class="table-row project"').length,
				headerCell: classes(html, 'projectid="name"'),
				bodyCell: classes(html, 'projectid="apple"'),
				nestedCell: classes(html, 'projectid="red"'),
				raggedRowCells: classes(html, 'projectid="pear"').length,
				rowsWithName: html.match(/table-row project"[^>]*><div[^>]*class="name /gu)?.length ?? 0,
				addColumn: classes(html, "absolute table-cell align-middle").length,
				addRow: classes(html, "my-s ml-ml flex").length,
				addChildButton: html.includes("addChildButton"),
				title: classes(html, "name name--main"),
			},
		).toStrictEqual(
			{
				root: ["font-custom project selected root tableItem flex flex-col h-full "],
				scroller: [
					"vertical-scrollable-container mt-m flex-1 min-h-0 [--item-selection-x-offset:0] [--item-selection-border-radius:0] inline-block !w-auto relative box-border overflow-x-auto ",
				],
				children: ["children table w-max [--name-left-overhang:0] pr-[42px]"],
				rows: 3,
				headerCell: [`font-custom project task ${CELL_BASE} bg-secondary border-t border-solid border-primary`],
				bodyCell: [`font-custom project task ${CELL_BASE}`],
				nestedCell: [
					`font-custom project collapsed ${CELL_BASE} border-l-[length:var(--wf-border-width-l)] border-l-primary`,
				],
				raggedRowCells: 1,
				rowsWithName: 0,
				addColumn: 1,
				addRow: 1,
				addChildButton: false,
				title: ["name name--main overflow-hidden"],
			},
		);
	});

	it("bolds the header names, sets the header width, and gives only that row a resize handle", () =>
	{
		const html = render("alice");
		expect(
			{
				bold: classes(html, "font-bold").length,
				widths: [...html.matchAll(/projectid="(name|qty|apple)"[^>]*style="width:(\d+)px"/gu)].map((m) => [
					m[1],
					m[2],
				]),
				handles: html.split("resizeTarget").length - 1,
				rowMenuSlots: html.split("absolute right-full top-0").length - 1,
			},
		).toStrictEqual(
			{
				bold: 2,
				widths: [
					["name", "125"],
					["qty", "125"],
				],
				handles: 2,
				rowMenuSlots: 2,
			},
		);
	});

	it("renders a table nested in a board column as a plain list", () =>
	{
		setup();
		const board = node(
			"board",
			null,
			{
				data:
				{
					layoutMode: "board",
				},
				hasChildren: true,
			},
		);
		const col = node(
			"col",
			"board",
			{
				hasChildren: true,
			},
		);
		const inner = node(
			"inner",
			"col",
			{
				data:
				{
					layoutMode: "table",
				},
				hasChildren: true,
			},
		);
		nodesById.set("board", board);
		childrenByParent.set(null, [board]);
		childrenByParent.set("board", [col]);
		childrenByParent.set("col", [inner]);
		outlineState.expandedIds = new Set(["col", "inner"]);
		const html = render("board");
		expect(
			{
				tableItem: html.includes("tableItem"),
				tableRow: html.includes("table-row"),
			},
		).toStrictEqual(
			{
				tableItem: false,
				tableRow: false,
			},
		);
	});
});

describe("board as a table cell", () =>
{
	it("drops the board class from a board that is a table cell", () =>
	{
		setup();
		const table = node(
			"table",
			null,
			{
				data:
				{
					layoutMode: "table",
				},
				hasChildren: true,
			},
		);
		const row = node(
			"row",
			"table",
			{
				hasChildren: true,
			},
		);
		const cell = node(
			"cell",
			"row",
			{
				data:
				{
					layoutMode: "board",
				},
			},
		);
		nodesById.set("table", table);
		childrenByParent.set(null, [table]);
		childrenByParent.set("table", [row]);
		childrenByParent.set("row", [cell]);
		outlineState.expandedIds = new Set(["row"]);
		const html = render("table");
		expect(
			classes(html, 'projectid="cell"').map((cls) => (
			{
				board: cls.split(" ").includes("board"),
				tableCell: cls.includes("tableCell"),
			})),
		).toStrictEqual([
			{
				board: false,
				tableCell: true,
			},
		]);
	});
});

describe("inline table renderer", () =>
{
	it("renders an expanded table row as a 300px scroller of table rows, not outline rows", () =>
	{
		setup();
		const parent = node(
			"home1",
			null,
			{
				hasChildren: true,
			},
		);
		childrenByParent.set(null, [parent]);
		childrenByParent.set("home1", [
			node(
				"alice",
				null,
				{
					data:
					{
						layoutMode: "table",
					},
					hasChildren: true,
				},
			),
		]);
		outlineState.expandedIds = new Set(["home1", "alice"]);
		const html = render(null);
		expect(
			{
				root: classes(html, 'projectid="alice"'),
				scroller: classes(html, "max-h-[300px]"),
				zoomedScroller: html.includes("mt-m flex-1 min-h-0"),
				rows: classes(html, 'class="table-row project"').length,
			},
		).toStrictEqual(
			{
				root: ["font-custom project open tableItem "],
				scroller: [
					"vertical-scrollable-container [--item-selection-x-offset:0] [--item-selection-border-radius:0] inline-block !w-auto max-h-[300px] relative box-border overflow-x-auto ",
				],
				zoomedScroller: false,
				rows: 3,
			},
		);
	});
});

describe("dashboard render gate", () =>
{
	function setupDashboard(cardLayout: string | null): void
	{
		setAccountFeatures(
			{
				dashboards: true,
			},
		);
		nodesById.clear();
		childrenByParent.clear();
		const dash = node(
			"dash",
			null,
			{
				data:
				{
					layoutMode: "dashboard",
				},
				hasChildren: true,
			},
		);
		const card = node(
			"card",
			"dash",
			{
				data:
				{
					layoutMode: cardLayout,
				},
				hasChildren: true,
			},
		);
		const row = node(
			"row",
			"card",
			{
				hasChildren: true,
			},
		);
		const cell = leaf("cell", "row", {});
		for (const n of [dash, card, row, cell])
		{
			nodesById.set(n.id, n);
		}
		childrenByParent.set(null, [dash]);
		childrenByParent.set("dash", [card]);
		childrenByParent.set("card", [row]);
		childrenByParent.set("row", [cell]);
		outlineState.expandedIds = new Set(["card", "row"]);
	}

	it("renders a table card of a dashboard as a plain list", () =>
	{
		setupDashboard("table");
		const html = render("dash");
		expect(
			{
				tableItem: html.includes("tableItem"),
				tableRow: html.includes("table-row"),
			},
		).toStrictEqual(
			{
				tableItem: false,
				tableRow: false,
			},
		);
	});

	it("renders a board card of a dashboard as a plain list", () =>
	{
		setupDashboard("board");
		const html = render("dash");
		expect(classes(html, 'projectid="card"').some((cls) => cls.split(" ").includes("board"))).toBe(false);
	});

	it("gives no dashboard classes to a dashboard inside a board card or to its children", () =>
	{
		setAccountFeatures(
			{
				dashboards: true,
			},
		);
		nodesById.clear();
		childrenByParent.clear();
		const board = node(
			"board",
			null,
			{
				data:
				{
					layoutMode: "board",
				},
				hasChildren: true,
			},
		);
		const col = node(
			"col",
			"board",
			{
				hasChildren: true,
			},
		);
		const card = node(
			"card",
			"col",
			{
				hasChildren: true,
			},
		);
		const inner = node(
			"inner",
			"card",
			{
				data:
				{
					layoutMode: "dashboard",
				},
				hasChildren: true,
			},
		);
		const child = leaf("child", "inner", {});
		for (const n of [board, col, card, inner, child])
		{
			nodesById.set(n.id, n);
		}
		childrenByParent.set(null, [board]);
		childrenByParent.set("board", [col]);
		childrenByParent.set("col", [card]);
		childrenByParent.set("card", [inner]);
		childrenByParent.set("inner", [child]);
		outlineState.expandedIds = new Set(["col", "card", "inner"]);
		const html = render("board");
		expect(
			{
				inline: html.includes("dashboard-inline"),
				card: html.includes("dashboard-card"),
			},
		).toStrictEqual(
			{
				inline: false,
				card: false,
			},
		);
	});
});
