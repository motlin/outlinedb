import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {FoundDateItem, FoundDatesResponse, NodeResponse} from "../src/node-types.js";
import {cssBlock} from "./helpers/css-block.js";

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
};

function makeNode(overrides: Partial<NodeResponse>): NodeResponse
{
	return {
		id: "day",
		parent_id: "m09",
		name: "Day",
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
		...overrides,
	};
}

function foundItem(id: string, crumbs: FoundDateItem["crumbs"], completedAt: number | null = null): FoundDateItem
{
	return {
		node: makeNode(
			{
				id,
				parent_id: "p",
				name: `Found ${id}`,
				isMirror: true,
				originalNodeId: id,
				completedAt,
			},
		),
		crumbs,
	};
}

const childrenByParent = new Map<string | null, NodeResponse[]>();
const nodesById = new Map<string, NodeResponse>();
const foundByDay = new Map<string, FoundDatesResponse>();
const foundDatesCalls: (string | null)[] = [];

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector?: (state: typeof outlineState) => unknown) =>
		selector ? selector(outlineState) : outlineState,
	outlineActions: () => outlineState,
}));
vi.mock("../src/client/navigation.js", () => (
{
	nodeUrl: (nodeId: string) => `/#/${nodeId}`,
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
		useChildren: (parentId: string | null) => (
		{
			data: childrenByParent.get(parentId) ?? [],
			isLoading: false,
			error: null,
		}),
		useBacklinks: () => (
		{
			data: undefined,
		}),
		useFoundDates: (dayId: string | null) =>
		{
			foundDatesCalls.push(dayId);
			return {
				data: dayId === null ? undefined : foundByDay.get(dayId),
			};
		},
		useNode: (nodeId: string | null) => (
		{
			data: nodeId === null ? undefined : nodesById.get(nodeId),
		}),
		useCreateNode: () => noopMutation,
		useDeleteNode: () => noopMutation,
		useToggleComplete: () => noopMutation,
	};
});
vi.mock(import("../src/client/breadcrumb-layout.js"), async (importOriginal) => (
{
	...(await importOriginal()),
	measureCrumbLabel: (label: string) => label.length * 7,
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

const {OutlineChildren, RootOutlineChildren} = await import("../src/client/components/outline-tree.js");

function render(parentId: string, isRoot = true): string
{
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: new QueryClient(),
			},
			isRoot
				? createElement(
						RootOutlineChildren,
						{
							parentId,
						},
					)
				: createElement(
						OutlineChildren,
						{
							parentId,
						},
					),
		),
	);
}

const SECTION_OPEN =
	'<div class="font-custom project open [&amp;_&gt;.name&gt;.itemMenu]:hidden [&amp;_&gt;.name]:text-tertiary">';
const SECTION_NAME =
	'<div tabindex="-1" class="name" role="presentation"><span data-handbook="bullet.handle" class="bullet diamond" style="left:calc(var(--name-left-overhang) + 1px);width:18px;opacity:1e-8;--bullet-size:18px" aria-hidden="true"><span class="bulletHalo"><svg width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor" class="mirrorDiamondIcon"><path d="M8 4 L4 8 L8 12 L12 8 Z"></path></svg></span></span><div class="notranslate content whitespace-pre-wrap" role="button" tabindex="0"><span class="innerContentContainer">Found Dates</span></div>';
const CRUMBS_WRAPPER = '<div class="text-xs mobile:text-s text-tertiary mt-m ml-xl mobile:ml-2xl leading-s">';

describe("OutlineChildren Found Dates section", () =>
{
	beforeEach(() =>
	{
		outlineState.showCompleted = true;
		childrenByParent.clear();
		nodesById.clear();
		foundByDay.clear();
		foundDatesCalls.length = 0;
		nodesById.set(
			"day",
			makeNode(
				{
					calendar:
					{
						level: "day",
						dateId: 20_260_930,
						root: false,
						foundDates: null,
						dayPrefix: null,
						restorableUniqueNode: false,
					},
				},
			),
		);
		nodesById.set(
			"plain",
			makeNode(
				{
					id: "plain",
					calendar: null,
				},
			),
		);
		childrenByParent.set("day", [
			makeNode(
				{
					id: "child-a",
					parent_id: "day",
					name: "Child A",
				},
			),
		]);
		foundByDay.set(
			"day",
			{
				items: [
					foundItem("due", [
						{
							id: "projects",
							name: "Projects",
						},
					]),
					foundItem("top", [], 5),
				],
			},
		);
	});

	it("renders an expanded Found Dates row after the day's children, with its found rows as mirrors under crumbs", () =>
	{
		const html = render("day");
		const sectionAt = html.indexOf(SECTION_OPEN);
		expect(
			{
				childFirst: html.indexOf('data-item-id="child-a"') < sectionAt && sectionAt !== -1,
				name: html.includes(SECTION_NAME, sectionAt),
				crumbs: html.split(CRUMBS_WRAPPER).length - 1,
				dueMirror: html.includes('data-item-id="due" class="bullet diamond"'),
				topMirror: html.includes('data-item-id="top" class="bullet diamond"'),
				homeCrumb: html.includes('data-item-id="None"'),
				calls: foundDatesCalls.includes("day"),
			},
		).toStrictEqual(
			{
				childFirst: true,
				name: true,
				crumbs: 2,
				dueMirror: true,
				topMirror: true,
				homeCrumb: true,
				calls: true,
			},
		);
	});

	it("renders the section on a day with no children", () =>
	{
		childrenByParent.set("day", []);
		expect(render("day").includes(SECTION_OPEN)).toBe(true);
	});

	it("hides completed found rows while completed items are hidden, and the section when none remain", () =>
	{
		outlineState.showCompleted = false;
		const withDue = render("day");
		foundByDay.set(
			"day",
			{
				items: [foundItem("top", [], 5)],
			},
		);
		childrenByParent.set("day", []);
		expect(
			{
				due: withDue.includes('data-item-id="due"'),
				top: withDue.includes('data-item-id="top"'),
				empty: render("day"),
			},
		).toStrictEqual(
			{
				due: true,
				top: false,
				empty: "",
			},
		);
	});

	it("renders nothing for an empty list", () =>
	{
		foundByDay.set(
			"day",
			{
				items: [],
			},
		);
		expect(render("day").includes("Found Dates")).toBe(false);
	});

	it("collapses a found row's leftmost crumbs into an ellipsis and truncates the rest to fit, like upstream's GuiCrumbs", () =>
	{
		const deep = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name) => (
		{
			id: name.toLowerCase(),
			name: `${name} ${"x".repeat(14 - name.length)}`,
		}));
		foundByDay.set(
			"day",
			{
				items: [foundItem("due", deep)],
			},
		);
		vi.stubGlobal(
			"window",
			{
				innerWidth: 400,
			},
		);
		const html = render("day");
		vi.unstubAllGlobals();
		const trail = html.slice(html.indexOf(CRUMBS_WRAPPER) + CRUMBS_WRAPPER.length);
		expect(
			{
				ellipsis: trail.includes(
					'<div tabindex="0" class="relative outline-none menu "><div><div role="button" tabindex="0" class="iconButton md shape-circle"><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="ellipsis"',
				),
				ellipsisFirst: trail.indexOf('data-icon="ellipsis"') < trail.indexOf("breadcrumb-item"),
				visible: [
					...trail.matchAll(
						/<a class="breadcrumb-item [^"]*" style="max-width:(\d+)px" href="[^"]*" data-item-id="(\w+)"/gu,
					),
				].map(([, width, id]) => [id, Number(width)]),
			},
		).toStrictEqual(
			{
				ellipsis: true,
				ellipsisFirst: true,
				visible: [
					["charlie", 94],
					["delta", 94],
					["echo", 95],
				],
			},
		);
	});

	it("leaves nested children without a Found Dates query, even a disabled one, so expanded rows mount lighter", () =>
	{
		foundDatesCalls.length = 0;
		render("day", false);
		expect(foundDatesCalls).toStrictEqual([]);
	});

	it("does not ask for Found Dates of a node that is not a day, nor of nested children", () =>
	{
		foundByDay.set(
			"plain",
			{
				items: [foundItem("due", [])],
			},
		);
		childrenByParent.set("plain", [
			makeNode(
				{
					id: "c",
					parent_id: "plain",
				},
			),
		]);
		const html = render("plain") + render("day", false);
		expect(
			{
				html: html.includes("Found Dates"),
				calls: foundDatesCalls.filter((id) => id !== null),
			},
		).toStrictEqual(
			{
				html: false,
				calls: [],
			},
		);
	});
});

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("Found Dates styles", () =>
{
	it("styles upstream's arbitrary classes: a tertiary name and no item menu", () =>
	{
		expect(
			{
				name: cssBlock(styles, String.raw`.\[\&_\>\.name\]\:text-tertiary > .name`),
				menu: cssBlock(styles, String.raw`.\[\&_\>\.name\>\.itemMenu\]\:hidden > .name > .itemMenu`),
			},
		).toStrictEqual(
			{
				name:
				{
					color: "var(--wf-text-tertiary)",
				},
				menu:
				{
					display: "none",
				},
			},
		);
	});
});
