import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {NodeResponse} from "../src/node-types.js";
import type {ItemMenuActions} from "../src/client/components/node-context-menu.js";

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore:
	{
		getState: () => ({}),
	},
}));

const {ItemMenuTrigger} = await import("../src/client/components/node-context-menu.js");
const NOOP_ACTIONS: ItemMenuActions =
{
	onOpenInPane: () =>
	{
	},
	onComplete: () =>
	{
	},
	onAddNote: () =>
	{
	},
	onAddDate: () =>
	{
	},
	onPresent: () =>
	{
	},
	onMoveTo: () =>
	{
	},
	onMirrorTo: () =>
	{
	},
	onMirror: () =>
	{
	},
	onDetachMirror: () =>
	{
	},
	onDuplicate: () =>
	{
	},
	onExport: () =>
	{
	},
	onCopyLink: () =>
	{
	},
	onMakeTemplate: () =>
	{
	},
	onDelete: () =>
	{
	},
	onExpandAll: () =>
	{
	},
	onCollapseAll: () =>
	{
	},
	onSort: () =>
	{
	},
};

const node: NodeResponse =
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
};

const TRIGGER_CLASS =
	"relative outline-none menu \n        [body.moving_&amp;]:hidden\n        !absolute left-[var(--item-menu-left)] top-0\n\n        h-[var(--line-height)] pt-[var(--wf-content-padding-top)]\n        flex items-center\n        opacity-100 cursor-pointer transition-opacity duration-200\n        \n        itemMenu\n      ";
const DOTS_CLASS = `
            block size-xl rounded-[12px]
            text-tertiary
            hover:bg-tertiary
            [.menu:focus_&amp;]:text-quaternary
            [.menu:focus_&amp;]:bg-tertiary
          `;
const DOTS = `<span class="${DOTS_CLASS}"><svg viewBox="0 0 24 24" fill="currentColor" class="block size-full"><circle cx="6" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="18" cy="12" r="2"></circle></svg></span>`;

describe("ItemMenuTrigger", () =>
{
	it("renders upstream's ButtonMenu trigger with the computed --item-menu-left", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				ItemMenuTrigger,
				{
					node,
					left: "calc(var(--name-left-overhang) - 46px)",
					actions: NOOP_ACTIONS,
					onOpenChange: () =>
					{
					},
				},
			),
		);
		expect(html).toBe(
			`<div tabindex="0" style="--item-menu-left:calc(var(--name-left-overhang) - 46px)" class="${TRIGGER_CLASS}"><div>${DOTS}</div></div>`,
		);
	});
});
