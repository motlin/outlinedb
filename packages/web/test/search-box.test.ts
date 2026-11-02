import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

const state =
{
	searchInput: "",
	setSearchInput: (_value: string) =>
	{
	},
	searchFocused: false,
	setSearchFocused: (_focused: boolean) =>
	{
	},
};

const media =
{
	wide: true,
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.mock("react-router-dom", () => (
{
	useNavigate: () => () =>
	{
	},
}));
vi.mock("@tanstack/react-query", () => (
{
	useQueryClient: () => ({}),
	useQuery: () => (
	{
		data: undefined,
	}),
}));
const breakpointCalls: number[] = [];
vi.mock("../src/client/hooks/use-breakpoint.js", () => (
{
	useBreakpoint: (min: number) =>
	{
		breakpointCalls.push(min);
		return media.wide;
	},
}));

const STAR_MARKER = '<div role="button" tabindex="0" class="starring-star iconButton ms shape-circle"></div>';
vi.mock("../src/client/components/star-button.js", async () =>
{
	const {createElement: h} = await import("react");
	return {
		StarButton: (props: Record<string, unknown>) =>
			Object.keys(props).length === 0
				? h(
						"div",
						{
							role: "button",
							tabIndex: 0,
							className: "starring-star iconButton ms shape-circle",
						},
					)
				: null,
	};
});

const {SearchBox} = await import("../src/client/components/search-box.js");

const INPUT_CLASS =
	"m-0 w-full py-[7px] pl-[30px] box-border font-[inherit] leading-[16px] border-transparent rounded-[16px] bg-transparent placeholder:text-primary pr-[72px] searchBoxInput";
const CLEAR_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" class="cursor-pointer text-secondary">';

function render(overrides: Partial<Pick<typeof state, "searchInput" | "searchFocused">>, wide = true): string
{
	const saved =
	{
		searchInput: state.searchInput,
		searchFocused: state.searchFocused,
	};
	Object.assign(state, overrides);
	media.wide = wide;
	const html = renderToStaticMarkup(createElement(SearchBox));
	Object.assign(state, saved);
	media.wide = true;
	return html;
}

function labelStyle(html: string): string
{
	return /<label[^>]*style="([^"]*)"/u.exec(html)?.[1] ?? "";
}

function innerDivStyle(html: string): string
{
	return /<label[^>]*><div[^>]*style="([^"]*)"/u.exec(html)?.[1] ?? "";
}

describe("SearchBox", () =>
{
	it("compacts at upstream's 1000px breakpoint", () =>
	{
		breakpointCalls.length = 0;
		render({});
		expect(breakpointCalls).toStrictEqual([1000]);
	});

	it("renders the idle empty wide box with upstream markup", () =>
	{
		const html = render({});
		expect(
			html.startsWith(
				'<div class="flex items-center"><label class="relative shrink-0 max-w-[60vw] transition-[width] duration-300 ease-base searchBox" style="margin-right:6px;width:210px">',
			),
		).toBe(true);
		expect(html).toContain('id="srch-input"');
		expect(html).toContain('placeholder="Search"');
		expect(html).toContain('data-handbook="search.search"');
		// React keeps the JSX casing in static markup.
		expect(html).toContain('readOnly=""');
		expect(html).toContain(`class="${INPUT_CLASS}"`);
		expect(html).toContain("var(--wf-border-primary)");
		expect(html).not.toContain('<svg width="14"');
	});

	it("tints the border and shows the clear button once there is text", () =>
	{
		const html = render(
			{
				searchInput: "apple",
			},
		);
		expect(html).toContain("var(--wf-border-tint)");
		expect(html).not.toContain("var(--wf-border-primary)");
		expect(html).toContain(CLEAR_SVG);
		expect(html).toContain('value="apple"');
	});

	it("shows the star, with no props, between the shortcut slot and the clear svg once there is text", () =>
	{
		expect(render({})).not.toContain("starring-star");
		expect(
			render(
				{
					searchInput: "zzq",
				},
			),
		).toContain(
			`<div class="absolute top-0 right-[11px] h-full flex items-center justify-center">${STAR_MARKER}${CLEAR_SVG}`,
		);
	});

	it("widens to 320px and squares the bottom corners when focused", () =>
	{
		const html = render(
			{
				searchFocused: true,
			},
		);
		expect(labelStyle(html)).toContain("width:320px");
		expect(innerDivStyle(html)).toContain("border-radius:20px 20px 0 0");
		expect(innerDivStyle(html)).toContain("background:var(--wf-background-primary)");
	});

	it("collapses to a 36px circle when compact, empty and unfocused", () =>
	{
		const html = render({}, false);
		expect(labelStyle(html)).toBe("width:36px;height:36px;border-radius:18px");
		expect(html).toContain("opacity-0 cursor-pointer");
	});

	it("draws no border in the collapsed compact state, like upstream", () =>
	{
		const html = render({}, false);
		expect(innerDivStyle(html)).toBe("border-radius:20px");
	});

	it("uses the default-size magnifier and drops the clear-button padding when compact", () =>
	{
		const html = render({}, false);
		expect(html).toContain(
			'class="svg-inline--fa fa-magnifying-glass fa-1x absolute left-[10px] pt-xs pointer-events-none"',
		);
		expect(html).not.toContain("pr-[72px]");
	});

	it("keeps the small magnifier when wide", () =>
	{
		expect(render({})).toContain(
			'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="magnifying-glass" class="svg-inline--fa fa-magnifying-glass fa-sm absolute left-ml pointer-events-none" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
		);
	});

	it("draws the clear icon with upstream's evenodd fill rule", () =>
	{
		expect(
			render(
				{
					searchInput: "apple",
				},
			),
		).toContain('<path clip-rule="evenodd" d=');
		expect(
			render(
				{
					searchInput: "apple",
				},
			),
		).toContain('fill="currentColor" fill-rule="evenodd"');
	});

	it("stays 210px in compact mode while it has text", () =>
	{
		expect(
			labelStyle(
				render(
					{
						searchInput: "apple",
					},
					false,
				),
			),
		).toBe("margin-right:6px;width:210px");
	});
});

describe("compact search input CSS", () =>
{
	it("uses a 2px right padding", async () =>
	{
		const {readFileSync} = await import("node:fs");
		const {cssBlock} = await import("./helpers/css-block.js");
		const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
		expect(cssBlock(styles, ".searchBoxInput").padding).toBe("7px 2px 7px 30px");
	});
});
