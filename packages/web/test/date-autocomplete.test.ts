import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vite-plus/test";
import {DateAutocompleteFlyout, dateAutocompleteKeyAction} from "../src/client/components/date-autocomplete.js";

function noop(): void
{
}

describe("DateAutocompleteFlyout", () =>
{
	it("renders upstream's flyout: label, calendar and gear buttons, and the Tab hint", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				DateAutocompleteFlyout,
				{
					label: "2026-10-02 Fri",
					position:
					{
						left: 241,
						top: 230,
					},
					onApply: noop,
					onOpenPicker: noop,
					onOpenSettings: noop,
				},
			),
		);
		const shell = /^<div class="([^"]*)" style="([^"]*)">/u.exec(html);
		expect(
			{
				classes: shell?.[1]?.split(/\s+/u).filter(Boolean),
				style: shell?.[2],
				label: /<span>([^<]*)<\/span>/u.exec(html)?.[1],
				icons: [...html.matchAll(/data-icon="([^"]*)"/gu)].map((match) => match[1]),
				hint: /<p class="text-xs">(.*)<\/p>/u.exec(html)?.[1],
			},
		).toStrictEqual(
			{
				classes: [
					"wf-menu",
					"flex",
					"flex-col",
					"border",
					"border-solid",
					"border-primary",
					"font-normal",
					"text-xs",
					"rounded-md",
					"bg-primary",
					"shadow-md",
					"overflow-x-hidden",
					"[transition:200ms_opacity]",
					"print:hidden",
					"absolute",
					"flyout",
					"!pt-s",
					"!pb-m",
					"!px-m",
					"text-center",
					"gap-m",
				],
				style: "pointer-events:auto;z-index:300;max-width:240px;margin-top:4px;left:241px;top:250px",
				label: "2026-10-02 Fri",
				icons: ["calendar-days", "gear"],
				hint: 'Press <span class="tooltip-key">Tab</span> or click here',
			},
		);
	});
});

describe("DateAutocompleteFlyout icon buttons", () =>
{
	it("spreads upstream's `icon` attribute instead of data-icon-name", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				DateAutocompleteFlyout,
				{
					label: "x",
					position:
					{
						left: 0,
						top: 0,
					},
					onApply: noop,
					onOpenPicker: noop,
					onOpenSettings: noop,
				},
			),
		);
		expect(
			{
				buttons: [...html.matchAll(/<div (role="button" tabindex="0" icon="[^"]*" class="[^"]*")>/gu)].map(
					(m) => m[1],
				),
				dataIconName: html.includes("data-icon-name"),
			},
		).toStrictEqual(
			{
				buttons: [
					'role="button" tabindex="0" icon="calendar-alt" class="iconButton md shape-square"',
					'role="button" tabindex="0" icon="gear" class="iconButton md shape-square"',
				],
				dataIconName: false,
			},
		);
	});
});

describe("dateAutocompleteKeyAction", () =>
{
	it("applies on Tab and hides on any other key", () =>
	{
		expect(
			["Tab", "a", "Escape", "Enter", "Shift"].map((key) =>
				dateAutocompleteKeyAction(
					{
						key,
						shiftKey: false,
					},
				),
			),
		).toStrictEqual(["apply", "hide", "hide", "hide", "hide"]);
	});

	it("applies on Shift+Tab too, as upstream checks only the key", () =>
	{
		expect(
			dateAutocompleteKeyAction(
				{
					key: "Tab",
					shiftKey: true,
				},
			),
		).toBe("apply");
	});
});
