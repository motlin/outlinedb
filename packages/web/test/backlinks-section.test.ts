import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {BacklinkItem, BacklinksResponse, NodeResponse} from "../src/node-types.js";
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
		id: "target",
		parent_id: null,
		name: "Target",
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

function backlinkItem(id: string, sourceId: string, crumbs: BacklinkItem["crumbs"], completedAt: number | null = null)
{
	return {
		node: makeNode(
			{
				id,
				parent_id: "refs",
				name: `Source ${sourceId}`,
				isMirror: true,
				originalNodeId: sourceId,
				completedAt,
			},
		),
		sourceId,
		crumbs,
	};
}

const childrenByParent = new Map<string | null, NodeResponse[]>();
const backlinksByNode = new Map<string, BacklinksResponse>();

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
		useBacklinks: (nodeId: string | null) => (
		{
			data: nodeId === null ? undefined : backlinksByNode.get(nodeId),
		}),
		useFoundDates: () => (
		{
			data: undefined,
		}),
		useNode: () => (
		{
			data: undefined,
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

const {OutlineChildren} = await import("../src/client/components/outline-tree.js");
const {backlinksLabel, isBacklinksSectionVisible} = await import("../src/client/backlinks.js");
const {RowLimitsContext} = await import("../src/client/hooks/use-row-limits.js");

function render(parentId: string): string
{
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: new QueryClient(),
			},
			createElement(
				OutlineChildren,
				{
					parentId,
				},
			),
		),
	);
}

const TWO_BACKLINKS: BacklinksResponse =
{
	rootId: "refs",
	items: [
		backlinkItem("bl-1", "src-1", [
			{
				id: "projects",
				name: "Projects",
			},
		]),
		backlinkItem("bl-2", "src-2", [], 5),
	],
};

describe("backlinksLabel", () =>
{
	it.each([
		[1, "1 Backlink"],
		[2, "2 Backlinks"],
		[3, "3 Backlinks"],
	])("labels %i backlink items as %s", (count, label) =>
	{
		expect(backlinksLabel(count)).toBe(label);
	});
});

describe("isBacklinksSectionVisible", () =>
{
	it.each([
		{
			items: [],
			showCompleted: true,
			visible: false,
		},
		{
			items: [null],
			showCompleted: false,
			visible: true,
		},
		{
			items: [5],
			showCompleted: true,
			visible: true,
		},
		{
			items: [5],
			showCompleted: false,
			visible: false,
		},
		{
			items: [5, null],
			showCompleted: false,
			visible: true,
		},
	])("is $visible for completions $items with showCompleted $showCompleted", ({items, showCompleted, visible}) =>
	{
		const response: BacklinksResponse =
		{
			rootId: "refs",
			items: items.map((completedAt, index) => backlinkItem(`bl-${index}`, `src-${index}`, [], completedAt)),
		};
		expect(isBacklinksSectionVisible(response, showCompleted)).toBe(visible);
	});
});

const COLLAPSED_SECTION =
	'<div class="font-custom project references collapsed"><div tabindex="-1" class="name empty" role="presentation"><a href="/#/refs" data-handbook="bullet.handle" data-item-id="refs" class="bullet bullet--show-halo bullet--backlink-root keep-bullet" style="left:calc(var(--name-left-overhang) + 1px);width:18px;opacity:0;--bullet-size:18px"><span class="bulletHalo"><svg width="100%" height="100%" viewBox="0 0 18 18" fill="currentColor" class="zoomBulletIcon"><circle cx="9" cy="9" r="3.5"></circle></svg></span></a><div class="notranslate content whitespace-pre-wrap"><span class="innerContentContainer">2 Backlinks</span></div><div class="wf-menu nameButtons" style="margin-left:0"></div><button type="button" aria-expanded="false" aria-label="Expand" data-handbook="expand.toggle"';

describe("OutlineChildren Backlinks section", () =>
{
	beforeEach(() =>
	{
		// Backlink crumbs collapse from the left to the window's width, as Found Dates' do.
		vi.stubGlobal(
			"window",
			{
				innerWidth: 400,
			},
		);
		outlineState.expandedIds = new Set();
		outlineState.showCompleted = true;
		childrenByParent.clear();
		backlinksByNode.clear();
		childrenByParent.set("target", [
			makeNode(
				{
					id: "child-a",
					parent_id: "target",
					name: "Child A",
				},
			),
		]);
		backlinksByNode.set("target", TWO_BACKLINKS);
	});

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("renders a collapsed N Backlinks row after the last child, inside the .children", () =>
	{
		const html = render("target");
		const childAt = html.indexOf('data-item-id="child-a"');
		const sectionAt = html.indexOf(COLLAPSED_SECTION);
		expect(
			{
				childFirst: childAt !== -1 && childAt < sectionAt,
				endsChildren: html.endsWith("</div></div>"),
			},
		).toStrictEqual(
			{
				childFirst: true,
				endsChildren: true,
			},
		);
		expect(html.includes('data-item-id="bl-1"')).toBe(false);
	});

	it("renders the section even when the item has no visible children", () =>
	{
		childrenByParent.set("target", []);
		expect(render("target").includes(COLLAPSED_SECTION)).toBe(true);
	});

	it("renders nothing when there is no references root", () =>
	{
		backlinksByNode.set(
			"target",
			{
				rootId: null,
				items: [],
			},
		);
		childrenByParent.set("target", []);
		expect(render("target")).toBe("");
	});

	it("hides the section when every source is completed and completed items are hidden", () =>
	{
		outlineState.showCompleted = false;
		backlinksByNode.set(
			"target",
			{
				rootId: "refs",
				items: [backlinkItem("bl-2", "src-2", [], 5)],
			},
		);
		expect(render("target").includes("references")).toBe(false);
	});

	it("counts completed sources in the label while completed items are hidden", () =>
	{
		outlineState.showCompleted = false;
		expect(render("target").includes('<span class="innerContentContainer">2 Backlinks</span>')).toBe(true);
	});

	it("waits until the row budget reaches every child before showing the section", () =>
	{
		childrenByParent.set(
			"target",
			Array.from(
				{
					length: 250,
				},
				(_, index) =>
					makeNode(
						{
							id: `n${index}`,
							parent_id: "target",
						},
					),
			),
		);
		const withLimit = (limit: number) =>
			renderToStaticMarkup(
				createElement(
					QueryClientProvider,
					{
						client: new QueryClient(),
					},
					createElement(
						RowLimitsContext.Provider,
						{
							value:
							{
								limits: new Map([["target", limit]]),
								remaining: 0,
							},
						},
						createElement(
							OutlineChildren,
							{
								parentId: "target",
							},
						),
					),
				),
			).includes("references");
		expect(
			{
				partial: withLimit(249),
				every: withLimit(250),
			},
		).toStrictEqual(
			{
				partial: false,
				every: true,
			},
		);
	});

	it("lists each backlink as a mirror row preceded by its source's ancestor crumbs when expanded", () =>
	{
		outlineState.expandedIds = new Set(["refs"]);
		const html = render("target");
		const crumbs =
			'<div projectid="bl-1" class="font-custom project task"><div class="text-xs mobile:text-s text-tertiary mt-m ml-xl mobile:ml-2xl leading-s"><div class="breadcrumbs grow shrink min-w-0 flex gap-m items-center text-s leading-base overflow-hidden"><a class="breadcrumb-item flex-shrink-0 whitespace-nowrap overflow-hidden truncate opacity-70';
		const inFirstRow = (fragment: string) => html.indexOf(fragment, html.indexOf(crumbs)) > html.indexOf(crumbs);
		expect(
			{
				open: html.includes('<div class="font-custom project references open">'),
				crumbs: html.includes(crumbs),
				crumbTarget: inFirstRow('href="/#/projects" data-item-id="projects">Projects</a></div></div>'),
				name: inFirstRow(
					'<div tabindex="-1" class="name name--with-embedder" role="presentation"><a href="/#/bl-1" data-handbook="bullet.handle" data-item-id="bl-1" class="bullet diamond"',
				),
				text: inFirstRow('<span class="innerContentContainer">Source src-1</span>'),
				secondDiamond: html.includes('data-item-id="bl-2" class="bullet diamond"'),
			},
		).toStrictEqual(
			{
				open: true,
				crumbs: true,
				crumbTarget: true,
				name: true,
				text: true,
				secondDiamond: true,
			},
		);
	});

	it("shows a Home crumb for a top-level source", () =>
	{
		outlineState.expandedIds = new Set(["refs"]);
		const html = render("target");
		const secondRow = html.slice(html.indexOf('data-item-id="bl-2"') - 1500, html.indexOf('data-item-id="bl-2"'));
		expect(secondRow.includes('data-item-id="None"')).toBe(true);
	});

	it("hides completed backlink rows when completed items are hidden", () =>
	{
		outlineState.expandedIds = new Set(["refs"]);
		outlineState.showCompleted = false;
		const html = render("target");
		expect(
			{
				first: html.includes('data-item-id="bl-1"'),
				second: html.includes('data-item-id="bl-2"'),
			},
		).toStrictEqual(
			{
				first: true,
				second: false,
			},
		);
	});
});

describe("Backlinks section parity", () =>
{
	beforeEach(() =>
	{
		vi.stubGlobal(
			"window",
			{
				innerWidth: 400,
			},
		);
		outlineState.expandedIds = new Set();
		outlineState.showCompleted = true;
		childrenByParent.clear();
		backlinksByNode.clear();
		childrenByParent.set("target", [
			makeNode(
				{
					id: "child-a",
					parent_id: "target",
					name: "Child A",
				},
			),
		]);
		backlinksByNode.set("target", TWO_BACKLINKS);
	});

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	function renderOwned(parentId: string): string
	{
		return renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					OutlineChildren,
					{
						parentId,
						owner: makeNode(
							{
								id: parentId,
								parent_id: null,
							},
						),
					},
				),
			),
		);
	}

	it("puts the add-sibling svg between the rows and the Backlinks section in a nested .children", () =>
	{
		const html = renderOwned("target");

		expect(html.indexOf('class="absolute left-[-11px]')).toBeGreaterThan(html.indexOf('data-item-id="child-a"'));
		expect(html.indexOf('class="absolute left-[-11px]')).toBeLessThan(html.indexOf("references collapsed"));
	});

	it("ends an open section's .children with an add-sibling svg", () =>
	{
		outlineState.expandedIds = new Set(["refs"]);

		const html = renderOwned("target");
		const section = html.slice(html.indexOf("references open"));

		expect(section.lastIndexOf("addSiblingButton")).toBeGreaterThan(section.lastIndexOf('data-item-id="bl-2"'));
	});

	it("gives an open section's bullet no halo, keeping it hidden at rest", () =>
	{
		outlineState.expandedIds = new Set(["refs"]);

		const html = render("target");

		expect(html).toContain(
			'class="bullet bullet--backlink-root" style="left:calc(var(--name-left-overhang) + 1px);width:18px;opacity:0;',
		);
	});

	it("collapses a long source path from the left into an ellipsis", () =>
	{
		outlineState.expandedIds = new Set(["refs"]);
		const deep = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name) => (
		{
			id: name.toLowerCase(),
			name: `${name} ${"x".repeat(14 - name.length)}`,
		}));
		backlinksByNode.set(
			"target",
			{
				rootId: "refs",
				items: [backlinkItem("bl-1", "src-1", deep)],
			},
		);

		const html = render("target");
		const trail = html.slice(html.indexOf("breadcrumbs grow"));

		expect(trail.indexOf('data-icon="ellipsis"')).toBeLessThan(trail.indexOf("breadcrumb-item"));
	});

	it("leaves a row whose only child is the references root without an add-sibling svg", () =>
	{
		childrenByParent.set("target", []);

		expect(renderOwned("target").includes('class="absolute left-[-11px]')).toBe(false);
	});
});

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("Backlinks styles", () =>
{
	it("tints the references label and bullet tertiary with a transparent halo like upstream", () =>
	{
		expect(
			{
				content: cssBlock(styles, ".references > .name > .content"),
				bullet: cssBlock(styles, ".bullet.bullet--backlink-root"),
				halo: cssBlock(styles, ".bullet.bullet--backlink-root > .bulletHalo"),
				crumbAnchors: cssBlock(styles, ".breadcrumbs a"),
			},
		).toStrictEqual(
			{
				crumbAnchors:
				{
					"text-decoration": "none",
					color: "inherit",
					cursor: "pointer",
				},
				content:
				{
					color: "var(--wf-text-tertiary)",
				},
				bullet:
				{
					color: "var(--wf-text-tertiary)",
				},
				halo:
				{
					"background-color": "transparent",
				},
			},
		);
	});
});
