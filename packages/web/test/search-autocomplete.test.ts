import {describe, expect, it} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {SearchAutocomplete, autocompleteClassName} from "../src/client/components/search-autocomplete.js";

const BASE =
	"menu [&.menu.flyout]:m-0 [&.menu.flyout]:-mt-px [&.menu.flyout]:box-border [&.menu.flyout]:border-solid [&.menu.flyout]:border-t-0 [&.menu.flyout]:rounded-[16px] [&.menu.flyout]:rounded-tl-none [&.menu.flyout]:rounded-tr-none [&.menu.flyout]:shadow-none ";

describe("SearchAutocomplete", () =>
{
	it("uses upstream's flyout class with the tint border for a committed query", () =>
	{
		expect(autocompleteClassName(true)).toBe(`${BASE}[&.menu.flyout]:border-[var(--wf-border-tint)]`);
		expect(autocompleteClassName(false)).toBe(`${BASE}[&.menu.flyout]:border-primary-x`);
	});

	it("renders the Tags header with upstream's exact markup", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				SearchAutocomplete,
				{
					rows: [
						{
							type: "header",
							label: "Tags",
						},
						{
							type: "row",
							label: "@sa",
							value: "@sa",
						},
					],
					committed: true,
					onSelect: () =>
					{
					},
				},
			),
		);

		expect(html).toContain(
			'<div class="py-m px-l text-tertiary text-xs uppercase bg-inherit mobile:bg-secondary menu-section-header mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right "><span>Tags</span></div>',
		);
		expect(html).toContain(`class="wf-header flex flex-col`);
		expect(html).toContain(autocompleteClassName(true).replaceAll("&", "&amp;"));
	});
});
