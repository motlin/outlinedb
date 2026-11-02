import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vite-plus/test";
import {ActionBlock, ControlRow, SettingsButton} from "../src/client/components/settings-rows.js";
import {Toggle} from "../src/client/components/toggle.js";

function collapse(value: string): string
{
	return value.replaceAll(/\s+/gu, " ").trim();
}

const CONTROL =
	"shrink-0 [&_.menu>div:first-child>div]:!h-2xl [&>.toggle]:!gap-0 [&>.toggle>div:first-child]:!box-border [&>.toggle>div:first-child]:!h-[21px] [&>.toggle>div:first-child]:!w-[36px] [&>.toggle>div:first-child]:!p-[3px] [&>.toggle>div:first-child]:!rounded-pill [&>.toggle>div:first-child>div]:!h-[15px] [&>.toggle>div:first-child>div]:!w-[15px] [&>.toggle.on>div:first-child>div]:!translate-x-[15px] [&>.toggle>div:last-child]:hidden";

describe("settings rows", () =>
{
	it("renders a control row with a badge and hint like upstream", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				ControlRow,
				{
					label: "All updates",
					badge: "LABS",
					hint: "x",
				},
				createElement(
					Toggle,
					{
						on: true,
						className: "update_notifications",
					},
				),
			),
		);
		const normalized = collapse(html.replaceAll(/(<[^>]*>)\s+/gu, "$1"));
		expect(
			normalized.startsWith(
				'<div class="flex flex-row gap-m w-full min-h-2xl items-center justify-between !gap-l overflow-hidden"><div class="min-w-0 flex-1 flex flex-col justify-center gap-xs"><div class="text-base leading-s text-primary">All updates<div class="relative -top-2xs ml-s p-xs inline-block text-2xs align-baseline rounded-s" style="color:var(--wf-gray-0);background:var(--wf-blue-300)">LABS</div></div><div class="text-s leading-xs text-tertiary">x</div></div>',
			),
		).toBe(true);
		const control = /<div class="(\s*shrink-0[^"]*)"/u.exec(html)?.[1] ?? "";
		expect(collapse(control.replaceAll("&amp;", "&").replaceAll("&gt;", ">"))).toBe(CONTROL);
		expect(html).toContain("toggle on inline-flex");
	});

	it("renders a danger action block with the padded button wrapper", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				ActionBlock,
				{
					label: "Delete",
					hint: "Gone",
					danger: true,
				},
				createElement(
					SettingsButton,
					{
						danger: true,
					},
					"Delete",
				),
			),
		);
		expect(html).toBe(
			'<div class="flex flex-col items-start justify-center gap-xs"><div class="text-base leading-s text-primary">Delete</div><div class="text-s    leading-xs text-tertiary">Gone</div><div class="pt-s"><div><button tabindex="0" class=" hover:no-underline button danger" type="button"><span class="">Delete</span></button></div></div></div>',
		);
	});
});
