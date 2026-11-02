import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";
import type {SlashGroup} from "../src/client/slash-commands.js";

vi.mock(import("react-dom"), async (importOriginal) => (
{
	...(await importOriginal()),
	createPortal: (node: ReactNode): ReactPortal => node as ReactPortal,
}));
vi.stubGlobal(
	"document",
	{
		body: {},
	},
);

const {SlashMenu} = await import("../src/client/components/slash-menu.js");

const LIST_UL_PATH =
	"M64 64a32 32 0 1 0 0 64 32 32 0 1 0 0-64zM176 80c-8.8 0-16 7.2-16 16s7.2 16 16 16l320 0c8.8 0 16-7.2 16-16s-7.2-16-16-16L176 80zm0 160c-8.8 0-16 7.2-16 16s7.2 16 16 16l320 0c8.8 0 16-7.2 16-16s-7.2-16-16-16l-320 0zm0 160c-8.8 0-16 7.2-16 16s7.2 16 16 16l320 0c8.8 0 16-7.2 16-16s-7.2-16-16-16l-320 0zM96 256a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM64 384a32 32 0 1 0 0 64 32 32 0 1 0 0-64z";
const TABLE_COLUMNS_PATH =
	"M448 64c17.7 0 32 14.3 32 32l0 64L32 160l0-64c0-17.7 14.3-32 32-32l384 0zM32 416l0-224 208 0 0 256L64 448c-17.7 0-32-14.3-32-32zm240 32l0-256 208 0 0 224c0 17.7-14.3 32-32 32l-176 0zM64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32z";

const FLYOUT_OPEN =
	'<div style="pointer-events:auto;z-index:300;min-width:0;max-width:240px;margin-top:4px;left:188.758px;top:195.5px;transform:scale(1, 1) translateX(0);transform-origin:90% 0;opacity:1" class="wf-menu flex flex-col border border-solid border-primary font-normal text-xs rounded-md bg-primary shadow-md overflow-x-hidden [transition:200ms_opacity] print:hidden absolute flyout menu ">' +
	'<div style="--menu-max-h:calc(100vh - 50px)" class=" scroller overflow-y-auto desktop:max-h-[min(var(--menu-max-h),calc(100vh-50px))] mobile:max-h-[min(var(--menu-max-h),50vh)] [&amp;&gt;*:first-child]:mt-xs [&amp;&gt;*:last-child]:mb-xs ">';
const FLYOUT_CLOSE = "</div></div>";

function header(name: string, ascii: string): string
{
	return `<div class="py-m px-l text-tertiary text-xs uppercase bg-inherit mobile:bg-secondary menu-section-header mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right "><span data-ascii="${ascii}" class="mention-group-${name}">${name === "actions" ? "Actions" : name}</span></div>`;
}

function itemClass(active: boolean, canHover: boolean): string
{
	return `pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary ${active ? "bg-secondary" : ""} ${canHover ? "hover:bg-secondary" : ""} mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem undefined ${active ? "active" : ""} ${canHover ? "canHover" : ""}`.replaceAll(
		/\s+/gu,
		" ",
	);
}

function commandItem(key: string, icon: string, path: string, label: string, cls: string): string
{
	return (
		`<a data-handbook="${key}" data-handbook-placement="right" class="${cls}"><span class="relative flex justify-between items-center"><span class="grow flex items-center gap-m whitespace-nowrap text-ellipsis overflow-hidden desktop:text-xs">` +
		`<div class="menuItemIcon flex items-center text-secondary"><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="${icon}" class="svg-inline--fa fa-${icon} fa-fw fa-1x " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="${path}"></path></svg></div>` +
		`<span>${label}</span></span></span></a>`
	);
}

const ACTIONS: SlashGroup[] = [
	{
		name: "Actions",
		options: [
			{
				key: "toggle_bullet",
				label: "Bullets",
				icon: "fal:list-ul",
			},
			{
				key: "toggle_board",
				label: "Board",
				icon: "fal:table-columns",
			},
		],
	},
];

function render(groups: SlashGroup[], index: number, keyboardMode: boolean): string
{
	const html = renderToStaticMarkup(
		createElement(
			SlashMenu,
			{
				groups,
				index,
				keyboardMode,
				left: 188.758,
				top: 195.5,
				onSelect: () =>
				{
				},
				onHover: () =>
				{
				},
				onMouseMove: () =>
				{
				},
			},
		),
	);
	return html.replaceAll(/\s+/gu, " ");
}

describe("SlashMenu", () =>
{
	it("renders upstream's flyout with the Actions header and the active row in keyboard mode", () =>
	{
		expect(render(ACTIONS, 0, true)).toBe(
			FLYOUT_OPEN +
				header("actions", "# Actions") +
				commandItem("toggle_bullet", "list-ul", LIST_UL_PATH, "Bullets", itemClass(true, false)) +
				commandItem("toggle_board", "table-columns", TABLE_COLUMNS_PATH, "Board", itemClass(false, false)) +
				FLYOUT_CLOSE,
		);
	});

	it("drops active and lets every row hover in mouse mode", () =>
	{
		expect(render(ACTIONS, 0, false)).toBe(
			FLYOUT_OPEN +
				header("actions", "# Actions") +
				commandItem("toggle_bullet", "list-ul", LIST_UL_PATH, "Bullets", itemClass(false, true)) +
				commandItem("toggle_board", "table-columns", TABLE_COLUMNS_PATH, "Board", itemClass(false, true)) +
				FLYOUT_CLOSE,
		);
	});

	it("renders the math result under the = header with no handbook and no icon", () =>
	{
		const mathItem = `<a data-handbook-placement="right" class="${itemClass(true, false)}"><span class="relative flex justify-between items-center"><span class="grow flex items-center gap-m whitespace-nowrap text-ellipsis overflow-hidden desktop:text-xs">4</span></span></a>`;
		expect(
			render(
				[
					{
						name: "=",
						options: [
							{
								label: "4",
							},
						],
					},
				],
				0,
				true,
			),
		).toBe(FLYOUT_OPEN + header("=", "# =") + mathItem + FLYOUT_CLOSE);
	});

	it("renders nothing when there are no options", () =>
	{
		expect([
			render([], 0, true),
			render(
				[
					{
						name: "Actions",
						options: [],
					},
				],
				0,
				true,
			),
		]).toStrictEqual(["", ""]);
	});
});
