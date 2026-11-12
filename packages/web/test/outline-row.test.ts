import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import {SearchFilterContext} from "../src/client/search-filter-context.js";
import type {SearchFilter} from "../src/client/search-filter.js";
import type * as Navigation from "../src/client/navigation.js";

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
	itemMenuOpenId: null as string | null,
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
		useNode: () => (
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
const {expandArrow} = await import("../src/client/components/expand-arrow.js");

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

function render(
	node: NodeResponse,
	hasChildren: boolean,
	isExpanded = false,
	search: SearchFilter | null = null,
): string
{
	outlineState.expandedIds = isExpanded ? new Set([node.id]) : new Set();
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: new QueryClient(),
			},
			createElement(
				SearchFilterContext.Provider,
				{
					value: search,
				},
				createElement(
					OutlineRow,
					{
						node:
						{
							...node,
							hasChildren,
						},
					},
				),
			),
		),
	);
}

function bulletMarkup(html: string): string
{
	const start = html.indexOf('<a href="/#/');
	return html.slice(start, html.indexOf("</a>", start) + "</a>".length);
}

const BULLET_STYLE = "left:calc(var(--name-left-overhang) + 1px);width:18px;--bullet-size:18px";
const DOT_SVG =
	'<svg width="100%" height="100%" viewBox="0 0 18 18" fill="currentColor" class="zoomBulletIcon"><circle cx="9" cy="9" r="3.5"></circle></svg>';
const DIAMOND_SVG =
	'<svg width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor" class="mirrorDiamondIcon"><path d="M8 4 L4 8 L8 12 L12 8 Z"></path></svg>';

function expectedBullet(id: string, classes: string, svg: string): string
{
	return `<a href="/#/${id.slice(-12)}" data-handbook="bullet.handle" data-item-id="${id}" class="${classes}" style="${BULLET_STYLE}"><span class="bulletHalo">${svg}</span></a>`;
}

describe("OutlineRow bullet markup", () =>
{
	it("renders a collapsed parent's bullet with the halo shown", () =>
	{
		expect(bulletMarkup(render(makeNode({}), true))).toBe(
			expectedBullet("alice", "bullet bullet--show-halo keep-bullet", DOT_SVG),
		);
	});

	it("renders a half-expanded search parent's bullet with the halo but without keep-bullet", () =>
	{
		const search =
		{
			ancestorIds: new Set(["alice"]),
			halfExpandedIds: new Set(["alice"]),
			expansion: new Map<string, boolean>(),
			matchIds: new Set<string>(),
			nameMatchIds: new Set<string>(),
			noteMatchIds: new Set<string>(),
			metaMatchIds: new Set<string>(),
			createdIds: new Set<string>(),
			result:
			{
				rootHalfExpanded: false,
			},
		} as unknown as SearchFilter;
		expect(bulletMarkup(render(makeNode({}), true, false, search))).toBe(
			expectedBullet("alice", "bullet bullet--show-halo", DOT_SVG),
		);
	});

	it("renders an expanded parent's bullet without the halo classes", () =>
	{
		expect(bulletMarkup(render(makeNode({}), true, true))).toBe(expectedBullet("alice", "bullet", DOT_SVG));
	});

	it("renders a leaf's bullet without the halo classes", () =>
	{
		expect(bulletMarkup(render(makeNode({}), false))).toBe(expectedBullet("alice", "bullet", DOT_SVG));
	});

	it("renders a mirror leaf's bullet as a diamond", () =>
	{
		expect(
			bulletMarkup(
				render(
					makeNode(
						{
							id: "bob",
							name: "Bob",
							isMirror: true,
						},
					),
					false,
				),
			),
		).toBe(expectedBullet("bob", "bullet diamond", DIAMOND_SVG));
	});

	it("links the bullet to the upstream short-id hash URL", () =>
	{
		const id = "4823cefa-5fc0-478c-88ac-35035d443bf1";
		expect(
			bulletMarkup(
				render(
					makeNode(
						{
							id,
						},
					),
					false,
				),
			),
		).toBe(
			`<a href="/#/35035d443bf1" data-handbook="bullet.handle" data-item-id="${id}" class="bullet" style="${BULLET_STYLE}"><span class="bulletHalo">${DOT_SVG}</span></a>`,
		);
	});
});

const EXPAND_CLASS =
	"expand absolute top-0 w-[20px] h-[var(--line-height)] pt-[var(--wf-content-padding-top)] flex items-center justify-center cursor-pointer print:hidden [body.moving_&amp;]:hidden left-[calc(var(--name-left-overhang)_-_22px)]";
const EXPAND_ATTRS = `data-handbook="expand.toggle" class="${EXPAND_CLASS}" style="color:var(--wf-text-quinary)"`;
const EXPAND_LEAF = `<button type="button" tabindex="-1" aria-hidden="true" ${EXPAND_ATTRS}></button>`;
const EXPAND_SVG =
	'<div><svg width="20" height="20" viewBox="0 0 20 20" class="block transition-transform duration-200 ease-base [.open&gt;_.name_&amp;]:rotate-90 [.open.halfExpanded&gt;_.name_&amp;]:rotate-45"><path d="M13.75 9.56879C14.0833 9.76124 14.0833 10.2424 13.75 10.4348L8.5 13.4659C8.16667 13.6584 7.75 13.4178 7.75 13.0329L7.75 6.97072C7.75 6.58582 8.16667 6.34525 8.5 6.5377L13.75 9.56879Z" stroke="none" fill="currentColor"></path></svg></div>';
const NAME_BUTTONS = '<div class="wf-menu nameButtons" style="margin-left:0"></div>';
const DROP_LINE = '<div class="drop-line"><div class="line"></div></div>';

function expectedRow(projectClass: string, nameClass: string, content: string): string
{
	return `<div projectid="alice" class="${projectClass}"><div tabindex="-1" class="${nameClass}" role="presentation">${expectedBullet("alice", "bullet", DOT_SVG)}<div class="notranslate content whitespace-pre-wrap">${content}</div>${NAME_BUTTONS}${EXPAND_LEAF}</div>${DROP_LINE}</div>`;
}

describe("OutlineRow name and content markup", () =>
{
	it("renders a leaf's project, name, content, and empty name buttons in upstream order", () =>
	{
		expect(render(makeNode({}), false)).toBe(
			expectedRow("font-custom project task", "name", '<span class="innerContentContainer">Alice</span>'),
		);
	});

	it("marks an empty-name leaf and omits its text span", () =>
	{
		expect(
			render(
				makeNode(
					{
						name: "",
					},
				),
				false,
			),
		).toBe(expectedRow("font-custom project task", "name empty", ""));
	});

	it("highlights the project whose item menu is open, and no other", () =>
	{
		outlineState.itemMenuOpenId = "alice";
		const highlighted = render(makeNode({}), false);
		outlineState.itemMenuOpenId = "bob";
		const other = render(makeNode({}), false);
		outlineState.itemMenuOpenId = null;
		const content = '<span class="innerContentContainer">Alice</span>';
		expect([highlighted, other]).toStrictEqual([
			expectedRow("font-custom project task highlighted", "name", content),
			expectedRow("font-custom project task", "name", content),
		]);
	});

	it("marks a completed leaf's project as done", () =>
	{
		expect(
			render(
				makeNode(
					{
						completedAt: 1_792_195_200_000,
					},
				),
				false,
			),
		).toBe(
			expectedRow("font-custom project task done", "name", '<span class="innerContentContainer">Alice</span>'),
		);
	});
});

describe("OutlineRow focused name", () =>
{
	it("adds name--focused only while the row's name is being edited", () =>
	{
		const content = '<span class="innerContentContainer">Alice</span>';
		outlineState.editingId = "alice";
		const editing = render(makeNode({}), false);
		const editingEmpty = render(
			makeNode(
				{
					name: "",
				},
			),
			false,
		);
		outlineState.editingId = null;
		expect(
			{
				editing: editing.includes('<div tabindex="-1" class="name name--focused" role="presentation">'),
				editingEmpty: editingEmpty.includes('class="name name--focused empty"'),
				resting: render(makeNode({}), false),
			},
		).toStrictEqual(
			{
				editing: true,
				editingEmpty: true,
				resting: expectedRow("font-custom project task", "name", content),
			},
		);
	});
});

function expandMarkup(html: string): string
{
	const start = html.indexOf('<button type="button"');
	return html.slice(start, html.indexOf("</button>", start) + "</button>".length);
}

describe("expand arrow", () =>
{
	it("renders an expanded parent's arrow with the svg after the name buttons", () =>
	{
		const html = render(makeNode({}), true, true);
		expect(
			{
				markup: expandMarkup(html),
				afterNameButtons: html.indexOf(NAME_BUTTONS) < html.indexOf(EXPAND_ATTRS),
			},
		).toStrictEqual(
			{
				markup: `<button type="button" aria-expanded="true" aria-label="Collapse" ${EXPAND_ATTRS}>${EXPAND_SVG}</button>`,
				afterNameButtons: true,
			},
		);
	});

	it("renders a collapsed parent's arrow as expandable", () =>
	{
		expect(expandMarkup(render(makeNode({}), true))).toBe(
			`<button type="button" aria-expanded="false" aria-label="Expand" ${EXPAND_ATTRS}>${EXPAND_SVG}</button>`,
		);
	});

	it("toggles a parent on click and ignores clicks on a leaf", () =>
	{
		const toggleExpand = vi.fn<(nodeId: string) => void>();
		const event =
		{
			preventDefault: () =>
			{
			},
			stopPropagation: () =>
			{
			},
		};
		const click = (hasChildren: boolean) =>
		{
			(
				expandArrow(
					{
						nodeId: "alice",
						hasChildren,
						isExpanded: false,
						onToggle: toggleExpand,
					},
				).props as
				{
					onClick: (e: typeof event) => void;
				}
			).onClick(event);
		};
		click(false);
		expect(toggleExpand.mock.calls).toStrictEqual([]);
		click(true);
		expect(toggleExpand.mock.calls).toStrictEqual([["alice"]]);
	});

	it("keeps focus off the parent arrow on mouse down", () =>
	{
		const preventDefault = vi.fn<() => void>();
		(
			expandArrow(
				{
					nodeId: "alice",
					hasChildren: true,
					isExpanded: false,
					onToggle: () =>
					{
					},
				},
			).props as
			{
				onMouseDown: (e: {preventDefault: () => void}) => void;
			}
		).onMouseDown(
			{
				preventDefault,
			},
		);
		expect(preventDefault.mock.calls).toStrictEqual([[]]);
	});

	it("expands the whole subtree on a second arrow click within 250ms, else toggles again", () =>
	{
		const toggleExpand = vi.fn<(nodeId: string) => void>();
		const expandAll = vi.fn<(nodeId: string, open: boolean) => void>();
		const click = (timeStamp: number, isExpanded: boolean) =>
		{
			const event =
			{
				preventDefault: () =>
				{
				},
				stopPropagation: () =>
				{
				},
				timeStamp,
			};
			(
				expandArrow(
					{
						nodeId: "double",
						hasChildren: true,
						isExpanded,
						onToggle: toggleExpand,
						onExpandAll: expandAll,
					},
				).props as
				{
					onClick: (e: typeof event) => void;
				}
			).onClick(event);
		};
		click(1000, false);
		click(1100, true);
		click(2000, true);
		expect(
			{
				toggles: toggleExpand.mock.calls,
				all: expandAll.mock.calls,
			},
		).toStrictEqual(
			{
				toggles: [["double"], ["double"]],
				all: [["double", true]],
			},
		);
	});
});

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

function normalizeCss(css: string): string
{
	return css
		.replaceAll(/\/\*[\s\S]*?\*\//gu, "")
		.replaceAll(/\s*([{}:;,>()])\s*/gu, "$1")
		.replaceAll(/\s+/gu, " ")
		.replaceAll(";}", "}");
}

describe("bullet CSS", () =>
{
	const css = normalizeCss(styles);

	it("drops the local bullet-svg class and ring tokens", () =>
	{
		expect(
			{
				bulletSvg: styles.includes(".bullet-svg"),
				bulletRing: styles.includes("--wf-bullet-ring"),
			},
		).toStrictEqual(
			{
				bulletSvg: false,
				bulletRing: false,
			},
		);
	});

	it("contains upstream's halo rules", () =>
	{
		const rules = [
			".bullet>.bulletHalo{display:flex;width:var(--bullet-size);height:var(--bullet-size);border-radius:50%}",
			".bullet .zoomBulletIcon{display:block}",
			".collapsed>.name>.bullet>.bulletHalo,.bullet.bullet--show-halo>.bulletHalo{background-color:var(--wf-background-quaternary)}",
			".is-desktop .bullet:hover>.bulletHalo,.is-desktop .dragging>.bullet>.bulletHalo{background-color:color-mix(in srgb,var(--wf-background-quaternary) 85%,black)}",
			".bullet.noHalo>.bulletHalo{background-color:transparent}",
		];
		expect(rules.filter((rule) => !css.includes(normalizeCss(rule)))).toStrictEqual([]);
	});
});

describe("name and content CSS", () =>
{
	const css = normalizeCss(styles);

	it("drops the local completed-name rule", () =>
	{
		expect(styles.includes(".name.completed")).toBe(false);
	});

	it("contains upstream's name, content, done, and nameButtons rules", () =>
	{
		const rules = [
			".name{position:relative;display:flex;margin-left:calc(-1 * var(--name-left-overhang));padding-left:calc(var(--name-left-overhang) + 24px);font-size:var(--font-default-font-size);--line-height:var(--font-default-line-height)}",
			".name>.content{flex:1 1 auto;padding-right:10px;display:flex;line-height:var(--line-height);padding-top:var(--wf-content-padding-top);padding-bottom:var(--wf-content-padding-bottom);min-height:var(--font-default-line-height)}",
			".content .innerContentContainer{width:-moz-available}",
			".done>.name>.content{text-decoration:line-through}",
			".done .name>.content,.name>.content.done{opacity:37%}",
			".nameButtons{display:flex;position:absolute;left:100%;min-height:28px;flex-direction:row;align-items:center;top:0;gap:var(--wf-space-m);padding:0 var(--wf-space-s)}",
			".nameButtons:empty{display:none}",
		];
		expect(rules.filter((rule) => !css.includes(normalizeCss(rule)))).toStrictEqual([]);
	});
});

describe("expand arrow CSS", () =>
{
	const css = normalizeCss(styles);

	it("drops the local expand rules and offset tokens", () =>
	{
		expect(
			[".expand:hover", ".expand.expanded", ".expand-svg", ".leaf .expand", "--expand-collapse-left"].filter(
				(text) => styles.includes(text),
			),
		).toStrictEqual([]);
	});

	it("contains upstream's expand rules", () =>
	{
		const rules = [
			".expand{position:absolute;top:0;left:calc(var(--name-left-overhang) - 22px);width:20px;height:var(--line-height);padding:var(--wf-content-padding-top) 0 0;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;background:none;font:inherit;line-height:inherit}",
			".name:not(.name--root):hover>.expand{opacity:1 !important}",
			".name:hover>.expand{color:var(--wf-text-quaternary)!important}",
			".header1:not(.root)>.name>.expand,.header2:not(.root)>.name>.expand,.header3:not(.root)>.name>.expand,.paragraph:not(.root)>.name>.expand{color:var(--wf-text-quinary)}",
			".expand svg{display:block;transition:transform 0.2s ease}",
			".open>.name>.expand svg{transform:rotate(90deg)}",
			".open.halfExpanded>.name>.expand svg{transform:rotate(45deg)}",
			"body.moving .expand{display:none}",
		];
		expect(rules.filter((rule) => !css.includes(normalizeCss(rule)))).toStrictEqual([]);
	});
});

const PREFIX_OPEN =
	'<div class="prefix relative top-0 inline-flex items-center justify-center whitespace-nowrap" style="--prefix-count:1"><div style="height:12px"></div><div class="inline-flex space-x-2 items-center justify-center">';

/** Everything between the bullet and the content: the prefix slot. */
function prefixMarkup(html: string): string
{
	const start = html.indexOf("</a>") + "</a>".length;
	return html.slice(start, html.indexOf('<span class="innerContentContainer">'));
}

describe("OutlineRow prefix slot", () =>
{
	it("renders a to-do row's checkbox in the prefix after the visible bullet", () =>
	{
		const html = render(
			makeNode(
				{
					data:
					{
						layoutMode: "todo",
					},
				},
			),
			false,
		);
		expect(bulletMarkup(html)).toBe(expectedBullet("alice", "bullet", DOT_SVG));
		expect(
			prefixMarkup(html).startsWith(`${PREFIX_OPEN}<label class="item-checkbox"><div class="checkbox-bg"></div>`),
		).toBe(true);
		expect(prefixMarkup(html)).toContain('data-icon="square"');
		expect(prefixMarkup(html)).toContain('style="font-size:16px"');
		expect(
			prefixMarkup(html).endsWith(
				'<input type="checkbox" tabindex="-1" name="complete"/></label></div></div><div class="notranslate content whitespace-pre-wrap">',
			),
		).toBe(true);
	});

	it("renders a completed to-do as checked with the square-check icon", () =>
	{
		const html = render(
			makeNode(
				{
					data:
					{
						layoutMode: "todo",
					},
					completedAt: 1_760_745_600,
				},
			),
			false,
		);
		expect(html).toContain('<label class="item-checkbox checked">');
		expect(html).toContain('data-icon="square-check"');
		expect(html).toContain('<input type="checkbox" tabindex="-1" name="complete" checked=""/>');
	});

	it("renders no focusable button or aria-pressed in the prefix", () =>
	{
		const prefix = prefixMarkup(
			render(
				makeNode(
					{
						data:
						{
							layoutMode: "todo",
						},
					},
				),
				false,
			),
		);
		expect(prefix.includes("<button") || prefix.includes("aria-pressed")).toBe(false);
	});

	it("renders no prefix on a bullets row", () =>
	{
		expect(render(makeNode({}), false).includes('class="prefix')).toBe(false);
	});

	it("renders a numbered row's number as the only prefix piece", () =>
	{
		outlineState.expandedIds = new Set();
		const html = renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					OutlineRow,
					{
						node:
						{
							...makeNode(
								{
									data:
									{
										layoutMode: "numbered",
									},
								},
							),
							hasChildren: false,
						},
						number: 3,
					},
				),
			),
		);
		expect(prefixMarkup(html)).toBe(
			`${PREFIX_OPEN}<span class="[.done_&amp;]:line-through [.done_&amp;]:opacity-[.37]">3.</span></div></div><div class="notranslate content whitespace-pre-wrap">`,
		);
	});
});

describe("OutlineRow divider", () =>
{
	const DIVIDER_LINE =
		'<div class="\n    divider-line h-[var(--line-height)]\n    flex flex-1 items-center min-w-[24px]\n    cursor-text\n    name--item-selection-handle\n    name--meta-match-target\n  "><hr class="w-full h-px border-0 border-t border-solid border-color text-center m-0 mt-xs" style="border-top-color:var(--wf-border-primary)"/></div>';

	it("flanks the label with two divider lines, one after the bullet and one after nameButtons", () =>
	{
		const html = render(
			makeNode(
				{
					data:
					{
						layoutMode: "divider",
					},
				},
			),
			false,
		);
		const nameStart = html.indexOf('<div tabindex="-1" class="name');
		const name = html.slice(nameStart);
		const stripped = name.replaceAll(DIVIDER_LINE, "<LINE/>");
		expect(stripped.includes("divider-line")).toBe(false);
		expect(
			[
				stripped.indexOf("<a "),
				stripped.indexOf("<LINE/>"),
				stripped.indexOf('<div class="notranslate content'),
				stripped.indexOf('<div class="wf-menu nameButtons"'),
				stripped.lastIndexOf("<LINE/>"),
			].every(
				(position, index, positions) =>
					position >= 0 && (index === 0 || position > (positions[index - 1] ?? 0)),
			),
		).toBe(true);
		expect(name.split(DIVIDER_LINE)).toHaveLength(3);
	});

	it("renders no divider line on a bullets row", () =>
	{
		expect(render(makeNode({}), false).includes("divider-line")).toBe(false);
	});
});
