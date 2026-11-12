import {describe, expect, it, vi} from "vite-plus/test";
import {createElement, isValidElement} from "react";
import type {ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {SearchCountIndicatorProps} from "../src/client/components/search-count-indicator.js";

const outlineState =
{
	searchQuery: "apple",
	editingId: "row-with-caret" as string | null,
	showCompleted: false,
	toggleShowCompleted: () =>
	{
	},
};
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (select: (state: typeof outlineState) => unknown) => select(outlineState),
}));
vi.mock("../src/client/hooks/use-tree-search.js", () => (
{
	useSearchProgress: () => (
	{
		result:
		{
			matchCount: 4,
			completedMatchCount: 0,
		},
		searching: false,
	}),
}));

const {SearchCountIndicator, SearchCountIndicatorView} =
	await import("../src/client/components/search-count-indicator.js");

const PILL_CLASS =
	" matching-node fixed mobile:bottom-[64px] desktop:bottom-l min-w-[256px] flex items-center justify-center px-l py-m rounded-pill bg-secondary whitespace-nowrap text-secondary overflow-hidden text-s ";

function props(overrides: Partial<SearchCountIndicatorProps>): SearchCountIndicatorProps
{
	return {
		matchCount: 4,
		completedMatchCount: 1,
		shown: false,
		searching: false,
		onToggleCompleted: () =>
		{
		},
		...overrides,
	};
}

function render(overrides: Partial<SearchCountIndicatorProps>): string
{
	return renderToStaticMarkup(createElement(SearchCountIndicatorView, props(overrides)));
}

/** Depth-first search of a rendered element tree for the first element whose className is `className`. */
function findByClass(
	node: ReactNode,
	className: string,
):
	|
	  {
			onClick?: () => void;
	  }
	| undefined
{
	if (
		!isValidElement<
		{
			className?: string;
			children?: ReactNode;
			onClick?: () => void;
		}>(node)
	)
	{
		return Array.isArray(node) ? node.map((child) => findByClass(child, className)).find(Boolean) : undefined;
	}
	if (node.props.className === className)
	{
		return node.props;
	}
	const {children} = node.props;
	return (Array.isArray(children) ? children : [children])
		.map((child: ReactNode) => findByClass(child, className))
		.find(Boolean);
}

describe("SearchCountIndicatorView", () =>
{
	it("renders upstream's pill with the match count and the hidden-completed toggle", () =>
	{
		const html = render({});
		expect(
			{
				wrapper: html.startsWith('<div class="flex justify-center print:hidden">'),
				pill: html.includes(
					`<span class="${PILL_CLASS}" style="margin-bottom:var(--safe-area-inset-bottom);z-index:500">`,
				),
				count: html.includes("<span>4 Matches</span>"),
				divider: html.includes('<div class=" border-solid border-l-[1px] border-primary h-full mx-m "></div>'),
				toggle: html.includes(
					'<div class="flex cursor-pointer h-full items-center "><span class="mr-s">1 completed</span><div class="w-[20px] flex justify-center"><svg',
				),
				icon: html.includes('data-icon="eye-slash"'),
				trailingSpace: html.endsWith("</div></div> </span></div>"),
			},
		).toStrictEqual(
			{
				wrapper: true,
				pill: true,
				count: true,
				divider: true,
				toggle: true,
				icon: true,
				trailingSpace: true,
			},
		);
	});

	it("uses the singular and omits the toggle when no completed item matches", () =>
	{
		const html = render(
			{
				matchCount: 1,
				completedMatchCount: 0,
			},
		);
		expect(
			{
				single: html.includes("<span>1 Match</span>"),
				toggle: html.includes("mr-s"),
				divider: html.includes("mx-m"),
			},
		).toStrictEqual(
			{
				single: true,
				toggle: false,
				divider: false,
			},
		);
	});

	it("shows the eye icon while completed items are shown", () =>
	{
		const html = render(
			{
				shown: true,
			},
		);
		expect(
			{
				eye: html.includes('data-icon="eye"'),
				slash: html.includes("eye-slash"),
			},
		).toStrictEqual(
			{
				eye: true,
				slash: false,
			},
		);
	});

	it("labels the completed count and drops the toggle when no match is completed", () =>
	{
		expect([
			render(
				{
					matchCount: 5,
					completedMatchCount: 3,
					shown: true,
				},
			).includes('<span class="mr-s">3 completed</span>'),
			render(
				{
					matchCount: 2,
					completedMatchCount: 0,
					shown: true,
				},
			).includes("mr-s"),
		]).toStrictEqual([true, false]);
	});

	it("shows only the spinner and 'Still searching' while the search runs", () =>
	{
		const html = render(
			{
				searching: true,
			},
		);
		expect(
			{
				still: html.includes(" Still searching <div"),
				spinner: html.includes(
					' Still searching <div class="relative box-border" style="width:24px;height:24px;display:inline-block;margin-left:8px">',
				),
				spinnerOrder: [...html.matchAll(/animation:(dom-kit-spinner-b\d)/gu)].map((match) => match[1]),
				count: html.includes("Matches"),
				toggle: html.includes("mr-s"),
			},
		).toStrictEqual(
			{
				still: true,
				spinner: true,
				spinnerOrder: ["dom-kit-spinner-b4", "dom-kit-spinner-b1", "dom-kit-spinner-b3"],
				count: false,
				toggle: false,
			},
		);
	});

	it("defines the upstream DomKit spinner keyframes", async () =>
	{
		const {readFileSync} = await import("node:fs");
		const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
		expect(["b1", "b3", "b4"].map((name) => styles.includes(`@keyframes dom-kit-spinner-${name}`))).toStrictEqual([
			true,
			true,
			true,
		]);
	});

	it("calls onToggleCompleted once when the toggle is clicked", () =>
	{
		const onToggleCompleted = vi.fn<() => void>();
		const tree = SearchCountIndicatorView(
			props(
				{
					onToggleCompleted,
				},
			),
		);
		findByClass(tree, "flex cursor-pointer h-full items-center ")?.onClick?.();
		expect(onToggleCompleted).toHaveBeenCalledOnce();
	});
});

describe("SearchCountIndicator", () =>
{
	it("keeps the pill while the caret is in a row, as upstream does after Tab or browser Back restores ?q=", () =>
	{
		const html = renderToStaticMarkup(createElement(SearchCountIndicator));
		expect(html.includes("<span>4 Matches</span>")).toBe(true);
	});
});

describe("match pill CSS", () =>
{
	it("leaves the pill content-box (the default)", async () =>
	{
		const {readFileSync} = await import("node:fs");
		const {cssBlock} = await import("./helpers/css-block.js");
		const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
		expect(cssBlock(styles, ".matching-node")["box-sizing"]).toBeUndefined();
	});
});
