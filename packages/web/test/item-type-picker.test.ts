import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ITEM_TYPES as ALL_ITEM_TYPES} from "../src/client/layout-types.js";
import type {ItemType} from "../src/client/layout-types.js";

/** The flag-off picker: Dashboard is a Labs type, hidden by default. */
const ITEM_TYPES = ALL_ITEM_TYPES.filter((type) => type.key !== "dashboard");

vi.mock(import("react-dom"), async (importOriginal) => (
{
	...(await importOriginal()),
	createPortal: (node: ReactNode): ReactPortal => node as ReactPortal,
}));

const blur = vi.fn<() => void>();
class FakeElement
{
	blur = blur;
}
vi.stubGlobal("HTMLElement", FakeElement);
vi.stubGlobal(
	"document",
	{
		activeElement: new FakeElement(),
		body:
		{
			classList:
			{
				add: () =>
				{
				},
				remove: () =>
				{
				},
			},
		},
	},
);

const {ItemTypePicker, nodeTypeMenuItems} = await import("../src/client/components/layout-menu.js");

function tokens(className: string): string[]
{
	return className.split(/\s+/u).filter(Boolean);
}

function renderItems(): string[]
{
	return nodeTypeMenuItems(ITEM_TYPES, () => {}).map((item) => renderToStaticMarkup(item));
}

function anchorAttribute(markup: string, name: string): string | undefined
{
	const open = /^<a[^>]*>/u.exec(markup)?.[0] ?? "";
	return new RegExp(` ${name}="([^"]*)"`, "u").exec(open)?.[1];
}

const UPSTREAM_ROW_CLASS =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary hover:bg-secondary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem";

describe("ItemTypePicker items", () =>
{
	it("renders the twelve turn_into rows with exact upstream class tokens, handbooks and labels in order", () =>
	{
		const rows = renderItems();
		expect(
			rows.map((row) => (
			{
				classes: tokens(anchorAttribute(row, "class") ?? ""),
				handbook: anchorAttribute(row, "data-handbook"),
				placement: anchorAttribute(row, "data-handbook-placement"),
				label: /<\/div>([^<]*)<\/span>/u.exec(row)?.[1],
				shortcut: row.includes("shortcut"),
			})),
		).toStrictEqual(
			[
				["turn_into_bullet", "Bullets"],
				["turn_into_h1", "Heading 1"],
				["turn_into_h2", "Heading 2"],
				["turn_into_h3", "Heading 3"],
				["turn_into_paragraph", "Paragraph"],
				["turn_into_todo", "To-do"],
				["turn_into_numbered", "Number"],
				["turn_into_board", "Board"],
				["turn_into_table", "Table"],
				["turn_into_quote_block", "Quote"],
				["turn_into_code_block", "Code Block"],
				["turn_into_divider", "Divider"],
			].map(([handbook, label]) => (
			{
				classes: [...tokens(UPSTREAM_ROW_CLASS), "menuItem", "canHover"],
				handbook,
				placement: "right",
				label,
				shortcut: false,
			})),
		);
	});

	it("passes the chosen type to onSelect and blurs the focused picker so it closes", () =>
	{
		const onSelect = vi.fn<(type: ItemType) => void>();
		nodeTypeMenuItems(ITEM_TYPES, onSelect)[7]?.props.onSelect?.();
		expect(
			{
				selected: onSelect.mock.calls,
				blurs: blur.mock.calls.length,
			},
		).toStrictEqual(
			{
				selected: [[ITEM_TYPES[7]]],
				blurs: 1,
			},
		);
	});
});

describe("ItemTypePicker host", () =>
{
	it("renders an absolutely positioned host around a ButtonMenu with no button", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					ItemTypePicker,
					{
						position:
						{
							top: 46,
							left: 1131,
						},
						types: ITEM_TYPES,
						onSelect: () =>
						{
						},
						onClose: () =>
						{
						},
					},
				),
			),
		).toBe(
			`<div style="position:absolute;top:46px;left:1131px"><div tabindex="0" class="relative outline-none menu "><div></div></div></div>`,
		);
	});
});
