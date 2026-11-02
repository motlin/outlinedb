import {describe, expect, it, vi} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ReactElement, ReactNode} from "react";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {SwitcherDialog} from "../src/client/components/jump-menu.js";
import {switcherCrumb} from "../src/client/switcher-model.js";
import type {SwitcherDialogProps} from "../src/client/components/jump-menu.js";
import type {SwitcherRow} from "../src/client/switcher-rows.js";
import {hasSelector} from "./helpers/css-block.js";

// The outline store reads localStorage at import time; the dialog view never touches it.
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: () =>
	{
	},
}));

interface ElementProps
{
	children?: ReactNode;
	className?: string;
	[key: string]: unknown;
}

function isElement(node: unknown): node is ReactElement<ElementProps>
{
	return typeof node === "object" && node !== null && "props" in node && typeof node.props === "object";
}

function isMemo(type: unknown): type is
{
	type: unknown;
}
{
	return typeof type === "object" && type !== null && "type" in type;
}

/** Every element in the tree, expanding function components the way React would. */
function elements(node: ReactNode): ReactElement<ElementProps>[]
{
	if (Array.isArray(node))
	{
		return node.flatMap(elements);
	}
	if (!isElement(node))
	{
		return [];
	}
	const component = isMemo(node.type) ? node.type.type : node.type;
	if (typeof component === "function")
	{
		const rendered: unknown = Reflect.apply(component, undefined, [node.props]);
		return elements(isElement(rendered) ? rendered : null);
	}
	return [node, ...elements(node.props.children)];
}

function row(overrides: Partial<SwitcherRow> = {}): SwitcherRow
{
	const id = overrides.id ?? "a";
	return {
		key: id,
		id,
		nodeId: id,
		query: null,
		search: null,
		labelHtml: "Alpha",
		completed: false,
		starred: false,
		ancestors: [],
		...overrides,
	};
}

function render(overrides: Partial<SwitcherDialogProps> = {}): ReactElement<ElementProps>
{
	const props: SwitcherDialogProps =
	{
		query: "",
		rows: [],
		selectedIndex: 0,
		emptyText: null,
		indexing: false,
		onQueryChange: () =>
		{
		},
		onKeyDown: () =>
		{
		},
		onSelect: () =>
		{
		},
		onOpenInPane: () =>
		{
		},
		onHover: () =>
		{
		},
		onClose: () =>
		{
		},
		onScrollNearEnd: () =>
		{
		},
		...overrides,
	};
	const rendered = SwitcherDialog(props);
	if (!isElement(rendered))
	{
		throw new TypeError("SwitcherDialog rendered nothing");
	}
	return rendered;
}

function options(root: ReactElement<ElementProps>): ReactElement<ElementProps>[]
{
	return elements(root).filter((element) => element.props.className?.startsWith("switcher-option") === true);
}

describe("SwitcherDialog", () =>
{
	it("asks for the next page only when the dialog scrolls within 300px of its bottom", () =>
	{
		const onScrollNearEnd = vi.fn<() => void>();
		const box = elements(
			render(
				{
					onScrollNearEnd,
				},
			),
		).find((element) => element.props.className?.startsWith("wf-dialog ") === true);
		const onScroll = box?.props.onScroll as (event: {currentTarget: object}) => void;
		onScroll(
			{
				currentTarget:
				{
					scrollTop: 0,
					scrollHeight: 1000,
					clientHeight: 600,
				},
			},
		);
		onScroll(
			{
				currentTarget:
				{
					scrollTop: 200,
					scrollHeight: 1000,
					clientHeight: 600,
				},
			},
		);
		expect(onScrollNearEnd.mock.calls).toStrictEqual([[]]);
	});

	it("renders upstream's dialog backdrop at z-index 600", () =>
	{
		const root = render();
		expect(
			{
				className: root.props.className,
				style: root.props.style,
			},
		).toStrictEqual(
			{
				className:
					"fixed top-sat left-sal right-sar bottom-sab flex items-start justify-center print:hidden dialog-backdrop",
				style:
				{
					zIndex: 600,
				},
			},
		);
	});

	it("uses the Jump to... placeholder, a circle-xmark close icon and no footer", () =>
	{
		const all = elements(render());
		expect(
			all.filter((element) => element.type === "input").map((element) => element.props.placeholder),
		).toStrictEqual(["Jump to..."]);
		expect(all.filter((element) => element.props["data-icon"] === "circle-xmark")).toHaveLength(1);
		expect(all.filter((element) => element.props.className?.includes("jump-menu") === true)).toStrictEqual([]);
		expect(all.filter((element) => element.type === "button")).toStrictEqual([]);
	});

	it("marks the selected row with bg-secondary only", () =>
	{
		const rows = options(
			render(
				{
					rows: [
						row(
							{
								id: "a",
							},
						),
						row(
							{
								id: "b",
							},
						),
					],
					selectedIndex: 1,
				},
			),
		);
		expect(rows.map((option) => option.props.className?.split(" ").includes("bg-secondary"))).toStrictEqual([
			false,
			true,
		]);
	});

	it("uses the two-row grid with crumbs and the single-row grid without", () =>
	{
		const rows = options(
			render(
				{
					rows: [
						row(
							{
								id: "a",
								ancestors: [
									{
										id: "p",
										name: "Parent",
									},
								],
							},
						),
						row(
							{
								id: "b",
							},
						),
					],
				},
			),
		);
		expect(rows.map((option) => option.props.className)).toStrictEqual([
			"switcher-option grid grid-cols-[auto_1fr] gap-x-m grid-rows-[auto_auto] gap-y-xs pb-ml bg-secondary pt-m px-l items-center cursor-pointer overflow-hidden whitespace-nowrap rounded-s",
			"switcher-option grid grid-cols-[auto_1fr] gap-x-m grid-rows-[auto] gap-y-xs pb-m pt-m px-l items-center cursor-pointer overflow-hidden whitespace-nowrap rounded-s",
		]);
	});

	it("shows a star on starred rows", () =>
	{
		const [starred, plain] = options(
			render(
				{
					rows: [
						row(
							{
								id: "a",
								starred: true,
							},
						),
						row(
							{
								id: "b",
							},
						),
					],
				},
			),
		);
		const stars = (option: ReactElement<ElementProps> | undefined) =>
			elements(option).filter((element) => element.type === "svg" && element.props["data-icon"] === "star");
		expect([stars(starred).length, stars(plain).length]).toStrictEqual([1, 0]);
	});

	it("shows the star and an SVG magnifier on every starred location, never the magnifying-glass icon", () =>
	{
		const check = (overrides: Partial<SwitcherRow>) =>
		{
			const [option] = options(
				render(
					{
						rows: [
							row(
								{
									id: "a",
									starred: true,
									search: "Alpha",
									...overrides,
								},
							),
						],
						selectedIndex: 1,
					},
				),
			);
			const svgs = elements(option).filter((element) => element.type === "svg");
			return {
				icons: svgs.map((element) => element.props["data-icon"]).filter(Boolean),
				magnifier: svgs.filter((element) => element.props.width === 12 && element.props.className === "mr-s")
					.length,
			};
		};
		expect([
			check({}),
			check(
				{
					query: "#todo",
				},
			),
		]).toStrictEqual([
			{
				icons: ["star"],
				magnifier: 1,
			},
			{
				icons: ["star"],
				magnifier: 1,
			},
		]);
	});

	it("shows no magnifier on a row without a search label", () =>
	{
		const [option] = options(
			render(
				{
					rows: [
						row(
							{
								id: "a",
							},
						),
					],
				},
			),
		);
		expect(
			elements(option).filter((element) => element.type === "svg" && element.props.width === 12),
		).toStrictEqual([]);
	});

	it("shows a spinner beside the indexing text", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				SwitcherDialog,
				{
					query: "zz",
					rows: [],
					selectedIndex: 0,
					emptyText: "Indexing your data! One sec \u2026",
					indexing: true,
					onQueryChange: () =>
					{
					},
					onKeyDown: () =>
					{
					},
					onSelect: () =>
					{
					},
					onOpenInPane: () =>
					{
					},
					onHover: () =>
					{
					},
					onClose: () =>
					{
					},
					onScrollNearEnd: () =>
					{
					},
				},
			),
		);
		expect(html).toContain(
			'<div>Indexing your data! One sec \u2026</div><div style="margin:auto;margin-top:8px"><div class="loading-spinner loading-spinner-small">',
		);
	});

	it("strikes through a completed row unless it is selected", () =>
	{
		const rows = options(
			render(
				{
					rows: [
						row(
							{
								id: "a",
								completed: true,
							},
						),
						row(
							{
								id: "b",
								completed: true,
							},
						),
					],
					selectedIndex: 0,
				},
			),
		);
		const labelClass = (option: ReactElement<ElementProps> | undefined) =>
			elements(option).find((element) => element.props.className?.includes("text-base leading-base") === true)
				?.props.className;
		expect(rows.map(labelClass)).toStrictEqual([
			"items-center text-base leading-base truncate",
			"items-center line-through opacity-[0.37] text-base leading-base truncate",
		]);
	});

	it("renders the highlighted label html and sliced crumbs, each followed by a chevron", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				SwitcherDialog,
				{
					query: "qw",
					rows: [
						row(
							{
								labelHtml: "<b><u>Qw</u></b>zx",
								ancestors: [
									{
										id: "p",
										name: "abcdefghijklmnopqrstuvwxy",
									},
									{
										id: "q",
										name: "Short",
									},
								],
							},
						),
					],
					selectedIndex: 0,
					emptyText: null,
					indexing: false,
					onQueryChange: () =>
					{
					},
					onKeyDown: () =>
					{
					},
					onSelect: () =>
					{
					},
					onOpenInPane: () =>
					{
					},
					onHover: () =>
					{
					},
					onClose: () =>
					{
					},
					onScrollNearEnd: () =>
					{
					},
				},
			),
		);
		expect(html).toContain("<span><b><u>Qw</u></b>zx</span>");
		expect(html.match(/data-icon="chevron-right"/gu)).toHaveLength(2);
		expect(html).toContain("<span>abcdefghijklmnopqrst…<svg");
		expect(html).toContain("<span>Short<svg");
	});

	it("renders the empty-state text after the list", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				SwitcherDialog,
				{
					query: "zz",
					rows: [],
					selectedIndex: 0,
					emptyText: "No matches found. Try adjusting your search.",
					indexing: false,
					onQueryChange: () =>
					{
					},
					onKeyDown: () =>
					{
					},
					onSelect: () =>
					{
					},
					onOpenInPane: () =>
					{
					},
					onHover: () =>
					{
					},
					onClose: () =>
					{
					},
					onScrollNearEnd: () =>
					{
					},
				},
			),
		);
		expect(html).toContain(
			'<div class="flex flex-col gap-s"></div><div>No matches found. Try adjusting your search.</div>',
		);
	});
});

describe("switcherCrumb", () =>
{
	it("slices names of 20 or more characters to 20 plus an ellipsis", () =>
	{
		expect([
			switcherCrumb("abcdefghijklmnopqrstuvwxy"),
			switcherCrumb("abcdefghijklmnopqrst"),
			switcherCrumb("abcdefghijklmnopqrs"),
		]).toStrictEqual(["abcdefghijklmnopqrst…", "abcdefghijklmnopqrst…", "abcdefghijklmnopqrs"]);
	});
});

describe("jump menu styles", () =>
{
	it("drops every local .jump-menu- rule", () =>
	{
		const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
		expect(hasSelector(styles, /\.jump-menu-/u)).toBe(false);
	});
});
