// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import {homeButtonOpacity, truncateCrumb} from "../src/client/mobile-crumbs.js";
import {MobileBreadcrumbsView} from "../src/client/components/mobile-top-bar.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const noop = () =>
{
};

function render(
	crumbs:
	{
		id: string;
		label: string;
	}[],
	searching = false,
): HTMLElement
{
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(
		createElement(
			MobileBreadcrumbsView,
			{
				crumbs,
				searching,
				onHome: noop,
				onCrumb: noop,
				onKebab: noop,
			},
		),
	);
	return host;
}

describe("truncateCrumb", () =>
{
	it("cuts at 15 characters plus an ellipsis, and names an empty crumb Untitled", () =>
	{
		expect(
			{
				long: truncateCrumb("Seed rows with a long name"),
				exact: truncateCrumb("123456789012345"),
				short: truncateCrumb("Delta"),
				empty: truncateCrumb(""),
			},
		).toStrictEqual(
			{
				long: "Seed rows with …",
				exact: "123456789012345",
				short: "Delta",
				empty: "Untitled",
			},
		);
	});
});

describe("homeButtonOpacity", () =>
{
	it("dims the home button at the root unless a search can be left", () =>
	{
		expect([
			homeButtonOpacity(
				{
					atRoot: true,
					searching: false,
				},
			),
			homeButtonOpacity(
				{
					atRoot: true,
					searching: true,
				},
			),
			homeButtonOpacity(
				{
					atRoot: false,
					searching: false,
				},
			),
		]).toStrictEqual([0.5, 1, 1]);
	});
});

describe("MobileBreadcrumbsView", () =>
{
	const trail = [
		{
			id: "a",
			label: "Seed rows with a long name",
		},
		{
			id: "b",
			label: "Delta",
		},
	];

	it("renders the home button, chevron, scrolling crumb trail and kebab", () =>
	{
		const host = render(trail);
		const root = host.firstElementChild as HTMLElement;
		const home = root.querySelector<HTMLElement>(".homeButton");
		const spans = [...root.querySelectorAll(".italic")].map((italic) =>
		{
			const inner = italic.firstElementChild as HTMLElement;
			return {
				text: inner.textContent,
				underline: inner.classList.contains("underline"),
			};
		});
		const scroller = root.querySelector(".overflow-x-auto");
		const kebab = root.querySelector<HTMLElement>(String.raw`.basis-\[44px\]`);
		expect(
			{
				rootClass: root.className,
				homeClass: home?.className,
				homeStyle: home?.getAttribute("style"),
				leadingChevron: root.children[1]?.getAttribute("style"),
				scrollerClass: scroller?.className,
				spans,
				trailChevrons: scroller?.querySelectorAll(".pointer-events-none").length,
				kebabStyle: kebab?.getAttribute("style"),
				kebabIcon: kebab?.querySelector("svg")?.getAttribute("data-icon"),
			},
		).toStrictEqual(
			{
				rootClass:
					"h-[var(--wf-header-height)] flex items-stretch justify-start overflow-hidden bg-primary MobileBreadcrumbs",
				homeClass:
					"h-full shrink-0 flex items-center justify-center transition-opacity duration-100 ease-base homeButton",
				homeStyle: "width:48px;opacity:1",
				leadingChevron: "left:-8px",
				scrollerClass:
					"relative h-full flex-[1_1_auto] flex items-stretch flex-nowrap overflow-x-auto [--webkit-overflow-scrolling:touch]",
				spans: [
					{
						text: "Seed rows with …",
						underline: true,
					},
					{
						text: "Delta",
						underline: false,
					},
				],
				trailChevrons: 1,
				kebabStyle: "margin-right:4px",
				kebabIcon: "ellipsis-vertical",
			},
		);
	});

	it("dims home and drops the chevron at the root", () =>
	{
		const host = render([]);
		const home = host.querySelector<HTMLElement>(".homeButton");
		expect(
			{
				homeStyle: home?.getAttribute("style"),
				chevron: host.querySelectorAll("[style='left:-8px']").length,
			},
		).toStrictEqual(
			{
				homeStyle: "width:48px;opacity:0.5",
				chevron: 0,
			},
		);
	});

	it("shows Untitled for an empty name", () =>
	{
		const host = render([
			{
				id: "a",
				label: "",
			},
		]);
		expect(host.querySelector(".italic")?.textContent).toBe("Untitled");
	});

	it("taps navigate only on ancestors, go home and open the kebab", () =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		const calls: string[] = [];
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		act(() =>
		{
			root.render(
				createElement(
					MobileBreadcrumbsView,
					{
						crumbs: trail,
						searching: false,
						onHome: () =>
						{
							calls.push("home");
						},
						onCrumb: (id) =>
						{
							calls.push(`crumb:${id}`);
						},
						onKebab: () =>
						{
							calls.push("kebab");
						},
					},
				),
			);
		});
		const italics = host.querySelectorAll<HTMLElement>(".italic > span");
		act(() =>
		{
			italics[0]?.click();
			italics[1]?.click();
			host.querySelector<HTMLElement>(".homeButton")?.click();
			host.querySelector<HTMLElement>(String.raw`.basis-\[44px\]`)?.click();
		});
		act(() =>
		{
			root.unmount();
		});
		expect(calls).toStrictEqual(["crumb:a", "home", "kebab"]);
	});
});
