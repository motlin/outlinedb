import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";
import type {PickerRow} from "../src/client/location-picker-model.js";

vi.mock(import("react-dom"), async (importOriginal) => (
{
	...(await importOriginal()),
	createPortal: (node: ReactNode): ReactPortal => node as ReactPortal,
}));
vi.mock(import("../src/client/breadcrumb-layout.js"), async (importOriginal) => (
{
	...(await importOriginal()),
	measureCrumbLabel: (label: string) => label.length * 7,
}));
vi.stubGlobal(
	"document",
	{
		body: {},
	},
);

const {LocationPicker} = await import("../src/client/components/location-picker.js");
const {popperTransform} = await import("../src/client/components/flyout/place-popper.js");

// Class strings below are copied from .llm/upstream-sync/dumps/inline-location-picker-upstream-empty-dom.html,
// inline-location-picker-upstream-more-row.html and move-reorder-upstream-moveto-dom.html (whitespace collapsed).
const WRAPPER =
	"[&amp;_.flyout]:static [&amp;_.flyout]:m-0 [&amp;_.flyout]:min-w-[480px] [&amp;_.flyout]:p-0 [&amp;_.flyout:empty]:hidden [&amp;_.flyout.menu]:border-0 [&amp;_.flyout.menu]:rounded-none ";
const SURFACE =
	"wf-menu flex flex-col border border-solid border-primary font-normal text-xs rounded-md bg-primary shadow-md overflow-x-hidden [transition:200ms_opacity] print:hidden absolute flyout ";
const HEADER =
	"py-m px-l text-tertiary text-xs uppercase bg-inherit mobile:bg-secondary menu-section-header mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right ";
const INPUT =
	"block w-full box-border appearance-none p-m rounded-s outline-none border border-solid border-primary bg-primary focus:border-tint text-s leading-s text-primary placeholder:text-tertiary selection:bg-selected [&amp;:-webkit-autofill]:shadow-[0_0_0_1000px_#e4f5ff_inset] [&amp;:-webkit-autofill]:[-webkit-text-fill-color:inherit] [&amp;:-webkit-autofill]:border-tint [&amp;:-webkit-autofill:hover]:shadow-[0_0_0_1000px_#e4f5ff_inset] [&amp;:-webkit-autofill:focus]:shadow-[0_0_0_1000px_#e4f5ff_inset] [&amp;:autofill]:shadow-[0_0_0_1000px_#e4f5ff_inset] [&amp;:autofill:hover]:shadow-[0_0_0_1000px_#e4f5ff_inset] [&amp;:autofill:focus]:shadow-[0_0_0_1000px_#e4f5ff_inset] ";
const INNER_STYLE =
	"pointer-events:auto;z-index:300;max-width:240px;margin-top:4px;left:0;top:100%;transform:scale(1, 1) translateX(0);transform-origin:10% 0;opacity:1";
const SCROLLER_BASE =
	" scroller overflow-y-auto desktop:max-h-[min(var(--menu-max-h),calc(100vh-50px))] mobile:max-h-[min(var(--menu-max-h),50vh)] ";
const SCROLLER_TAIL = "[&amp;&gt;*:first-child]:mt-xs [&amp;&gt;*:last-child]:mb-xs ";
const ROW_HEAD =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary";
const ROW_MOBILE =
	"mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem [&amp;:not(:last-child)]:mb-xs [&amp;_.menuItemIcon]:w-auto";
const ROW_ACTIVE = `${ROW_HEAD} text-primary bg-secondary ${ROW_MOBILE} [&amp;.active]:bg-secondary [&amp;.canHover:hover]:bg-secondary active `;
const ROW_ENABLED = `${ROW_HEAD} text-primary ${ROW_MOBILE} [&amp;.active]:bg-secondary [&amp;.canHover:hover]:bg-secondary `;
const ROW_DISABLED = `${ROW_HEAD} text-tertiary ${ROW_MOBILE} [&amp;_span]:text-inherit `;
const ROW_INNER =
	'<span class="relative flex justify-between items-center"><span class="grow flex items-center gap-m whitespace-nowrap text-ellipsis overflow-hidden desktop:text-xs">';
const ICON = '<div class="menuItemIcon flex items-center text-secondary">';
const LABEL = '<div data-menu-item-label="" class="flex flex-row gap-m">';
const SUBTEXT = "text -mt-s pt-s block whitespace-nowrap text-xs text-ellipsis text-tertiary overflow-hidden ";
const CRUMBS =
	'<div class="breadcrumbs grow shrink min-w-0 flex gap-m items-center text-s leading-base overflow-hidden" style="height:24px;color:var(--wf-text-primary)">';
const CRUMB =
	'<div class="breadcrumb-item flex-shrink-0 whitespace-nowrap overflow-hidden truncate opacity-70 data-hj-suppress hover:pointer-fine:opacity-100 hover:pointer-fine:underline cursor-pointer">';
const SEPARATOR =
	'<svg width="5" height="8" viewBox="0 0 5 8" fill="none" class="flex-shrink-0"><path d="…" stroke="currentColor" stroke-linecap="round"></path></svg>';
const FOOTER_A_STYLE =
	"overflow:hidden;height:32px;display:flex;align-items:center;border-top:1px solid var(--wf-border-primary)";
const FOOTER_B_STYLE = "height:32px;display:flex;align-items:center";
const PLUS =
	'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="plus" class="svg-inline--fa fa-plus fa-fw fa-1x " role="img" viewBox="0 0 448 512"><path fill="currentColor" d="…"></path></svg>';
const ARROW_UP =
	'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="arrow-up" class="svg-inline--fa fa-arrow-up fa-1x " role="img" viewBox="0 0 384 512" style="transform:rotate(45deg)"><path fill="currentColor" d="…"></path></svg>';

const CRUMBS_BY_ID: Record<
	string,
	{
		id: string;
		name: string;
	}[]
> =
{
	hub: [
		{
			id: "sandbox",
			name: "🧪 Sync sandbox",
		},
	],
	deep: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name) => (
	{
		id: name.toLowerCase(),
		name: `${name} ${"x".repeat(14 - name.length)}`,
	})),
	t0: [
		{
			id: "t1",
			name: "T1",
		},
	],
	r1: [
		{
			id: "sandbox",
			name: "🧪 Sync sandbox",
		},
	],
	r2: [
		{
			id: "hub",
			name: "Qzpick Hub",
		},
	],
};

/** Collapses whitespace inside class attributes, elides svg paths, and drops React's svg xmlns. */
function normalize(html: string): string
{
	return html
		.replaceAll(/ class="([^"]*)"/gu, (_match, value: string) => ` class="${value.replaceAll(/\s+/gu, " ")}"`)
		.replaceAll(/ d="[^"]*"/gu, ' d="…"')
		.replaceAll(' xmlns="http://www.w3.org/2000/svg"', "");
}

interface RenderOptions
{
	step?: 1 | 2;
	query: string;
	rows: PickerRow[];
	name?: string;
	active?: number;
}

function render({step = 1, query, rows, name, active}: RenderOptions): string
{
	return normalize(
		renderToStaticMarkup(
			createElement(
				LocationPicker,
				{
					position: [203, 361.5],
					step,
					headerText: "Move To...",
					name,
					query,
					active,
					onQueryChange: () =>
					{
					},
					rows,
					crumbsOf: (id: string) => CRUMBS_BY_ID[id] ?? [],
					onSelect: () =>
					{
					},
				},
			),
		),
	);
}

function shell(header: string, inputWrapper: string, query: string, menuClass: string, menu: string): string
{
	return (
		`<div class="${WRAPPER}" data-popper-reference-hidden="false" data-popper-escaped="false" data-popper-placement="bottom-start" style="position:absolute;inset:0 auto auto 0;z-index:300;transform:translate(203px, 362px)">` +
		`<div style="pointer-events:auto;z-index:300;max-width:240px;margin-top:4px;left:203px;top:361.5px;transform:scale(1, 1) translateX(0);transform-origin:10% 0;opacity:1" class="${SURFACE}">` +
		`<div class="${HEADER}">${header}</div>` +
		`<div class="${inputWrapper}"><div class="flex flex-col w-full"><input class="${INPUT}" type="text" placeholder="Find location..." autofocus="" value="${query}"/></div></div>` +
		`<div><div style="${INNER_STYLE}" class="${SURFACE}menu ${menuClass}">${menu}</div></div>` +
		`</div></div>`
	);
}

function crumbs(...names: string[]): string
{
	return `${CRUMBS}${names.map((name) => `${CRUMB}${name}</div>${SEPARATOR}`).join("")}</div>`;
}

const footerA = (rowClass: string, query: string, recent: string) =>
	`<a data-handbook-placement="right" style="${FOOTER_A_STYLE}" class="${rowClass}">${ROW_INNER}${ICON}${PLUS}</div>${LABEL}New "${query}" in: <b>${recent}</b></div></span></span></a>`;
const footerB = (rowClass: string, query: string) =>
	`<a data-handbook-placement="right" style="${FOOTER_B_STYLE}" class="${rowClass}">${ROW_INNER}${ICON}${ARROW_UP}</div>${LABEL}<div>New "${query}" in…</div></div></span></span></a>`;

function createRows(query: string, disabled: boolean): PickerRow[]
{
	return [
		{
			kind: "create-default",
			labelHtml: `New "${query}" in: <b>Qzpick Hub</b>`,
			disabled,
			icon: "plus",
		},
		{
			kind: "create-elsewhere",
			labelHtml: `New "${query}" in…`,
			disabled,
			icon: "arrow-up",
		},
	];
}

describe("popperTransform", () =>
{
	it("rounds to device pixels and writes translate at dpr 1", () =>
	{
		expect(popperTransform(188.359375, 221.5, 1)).toBe("translate(188px, 222px)");
	});

	it("writes translate3d above dpr 1", () =>
	{
		expect(popperTransform(188.359375, 221.5, 2)).toBe("translate3d(188.5px, 221.5px, 0px)");
	});
});

describe("LocationPicker markup", () =>
{
	it("renders the empty-query state: a recent and a starred row over two disabled footers", () =>
	{
		const html = render(
			{
				query: "",
				rows: [
					{
						kind: "recent",
						id: "hub",
						labelHtml: "Qzpick Hub",
						disabled: false,
						icon: "clock",
					},
					{
						kind: "starred",
						id: "t0",
						labelHtml: "T0",
						disabled: false,
						icon: "star",
					},
					...createRows("", true),
				],
			},
		);
		const recent =
			`<a data-handbook-placement="right" class="${ROW_ACTIVE}">${ROW_INNER}${ICON}` +
			'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="clock" class="svg-inline--fa fa-clock fa-fw fa-1x " role="img" viewBox="0 0 512 512"><path fill="currentColor" d="…"></path></svg>' +
			`</div>${LABEL}<div>Qzpick Hub</div></div></span></span><span class="${SUBTEXT}ml-xl">${crumbs("🧪 Sync sandbox")}</span></a>`;
		const starred =
			`<a data-handbook-placement="right" class="${ROW_ENABLED}">${ROW_INNER}${ICON}` +
			'<svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="star" class="svg-inline--fa fa-star fa-1x " role="img" viewBox="0 0 576 512" style="color:var(--wf-yellow-200)"><path fill="currentColor" d="…"></path></svg>' +
			`</div>${LABEL}<div>T0</div></div></span></span><span class="${SUBTEXT}">${crumbs("T1")}</span></a>`;
		expect(html).toBe(
			shell(
				"Move To...",
				"p-l pt-0 mobile:pl-ml",
				"",
				"[&amp;_.help-text]:p-l !static",
				`<div style="--menu-max-h:240px" class="${SCROLLER_BASE}border-b border-primary ${SCROLLER_TAIL}">${recent}${starred}</div>${footerA(
					ROW_DISABLED,
					"",
					"Qzpick Hub",
				)}${footerB(ROW_DISABLED, "")}`,
			),
		);
	});

	it("renders the query state: highlighted results, More results, and enabled footers", () =>
	{
		const html = render(
			{
				query: "qzpick",
				rows: [
					{
						kind: "result",
						id: "r1",
						labelHtml: "<b><u>Qzpick</u></b> Hub",
						disabled: false,
						icon: null,
					},
					{
						kind: "result",
						id: "r2",
						labelHtml: "<b><u>Qzpick</u></b> Two",
						disabled: false,
						icon: null,
					},
					{
						kind: "more",
						labelHtml: "More results",
						disabled: false,
						icon: "ellipsis",
					},
					...createRows("qzpick", false),
				],
			},
		);
		const result = (rowClass: string, label: string, crumb: string) =>
			`<a data-handbook-placement="right" class="${rowClass}">${ROW_INNER}${LABEL}<div>${label}</div></div></span></span><span class="${SUBTEXT}">${crumbs(crumb)}</span></a>`;
		const more =
			`<a data-handbook-placement="right" class="${ROW_ENABLED}">${ROW_INNER}${ICON}` +
			'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="ellipsis" class="svg-inline--fa fa-ellipsis fa-fw fa-1x " role="img" viewBox="0 0 448 512"><path fill="currentColor" d="…"></path></svg>' +
			`</div>${LABEL}<div>More results</div></div></span></span></a>`;
		expect(html).toBe(
			shell(
				"Move To...",
				"p-l pt-0 mobile:pl-ml",
				"qzpick",
				"[&amp;_.help-text]:p-l [&amp;_.help-text]:pt-m !static",
				`<div style="--menu-max-h:240px" class="${SCROLLER_BASE}border-b border-primary ${SCROLLER_TAIL}">${result(
					ROW_ACTIVE,
					"<b><u>Qzpick</u></b> Hub",
					"🧪 Sync sandbox",
				)}${result(ROW_ENABLED, "<b><u>Qzpick</u></b> Two", "Qzpick Hub")}${more}</div>${footerA(
					ROW_ENABLED,
					"qzpick",
					"Qzpick Hub",
				)}${footerB(ROW_ENABLED, "qzpick")}`,
			),
		);
	});

	it("renders the no-match help text and makes the first footer active", () =>
	{
		const html = render(
			{
				query: "zzz",
				rows: [
					{
						kind: "help",
						labelHtml: "No matching locations found",
						disabled: true,
						icon: null,
					},
					...createRows("zzz", false),
				],
			},
		);
		expect(html).toBe(
			shell(
				"Move To...",
				"p-l pt-0 mobile:pl-ml",
				"zzz",
				"[&amp;_.help-text]:p-l [&amp;_.help-text]:pt-m !static",
				`<div style="--menu-max-h:240px" class="${SCROLLER_BASE}border-b border-primary ${SCROLLER_TAIL}"><div class="help-text">No matching locations found</div></div>${footerA(
					ROW_ACTIVE,
					"zzz",
					"Qzpick Hub",
				)}${footerB(ROW_ENABLED, "zzz")}`,
			),
		);
	});

	it("renders step 2 with the bold name header, its own wrapper class and no footers", () =>
	{
		const html = render(
			{
				step: 2,
				name: "qzpick",
				query: "",
				rows: [
					{
						kind: "recent",
						id: "hub",
						labelHtml: "Qzpick Hub",
						disabled: false,
						icon: "clock",
					},
				],
			},
		);
		const recent =
			`<a data-handbook-placement="right" class="${ROW_ACTIVE}">${ROW_INNER}${ICON}` +
			'<svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="clock" class="svg-inline--fa fa-clock fa-fw fa-1x " role="img" viewBox="0 0 512 512"><path fill="currentColor" d="…"></path></svg>' +
			`</div>${LABEL}<div>Qzpick Hub</div></div></span></span><span class="${SUBTEXT}ml-xl">${crumbs("🧪 Sync sandbox")}</span></a>`;
		expect(html).toBe(
			shell(
				"New &quot;<b>qzpick</b>&quot; in…",
				"pt-0 pb-l px-l mobile:pl-ml",
				"",
				"[&amp;_.help-text]:pt-0 [&amp;_.help-text]:px-l [&amp;_.help-text]:pb-l !static",
				`<div style="--menu-max-h:240px" class="${SCROLLER_BASE}${SCROLLER_TAIL}">${recent}</div>`,
			),
		);
	});

	it("shows Home as the only crumb for a top-level location", () =>
	{
		const html = render(
			{
				query: "",
				rows: [
					{
						kind: "recent",
						id: "top",
						labelHtml: "Top",
						disabled: false,
						icon: "clock",
					},
				],
			},
		);
		expect(html).toContain(`<span class="${SUBTEXT}ml-xl">${crumbs("Home")}</span>`);
	});

	it("collapses the leftmost crumbs and truncates the rest to fit a narrow window", () =>
	{
		vi.stubGlobal(
			"window",
			{
				innerWidth: 400,
			},
		);
		const html = render(
			{
				query: "",
				rows: [
					{
						kind: "recent",
						id: "deep",
						labelHtml: "Deep",
						disabled: false,
						icon: "clock",
					},
				],
			},
		);
		vi.stubGlobal("window", undefined);
		const trail = html.slice(html.indexOf(CRUMBS) + CRUMBS.length);
		expect(
			{
				menus: html.split('<div tabindex="0" class="relative outline-none menu ">').length - 1,
				ellipsis: trail.startsWith(
					'<div tabindex="0" class="relative outline-none menu "><div><div role="button" tabindex="0" class="iconButton md shape-circle"><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="ellipsis"',
				),
				visible: [
					...trail.matchAll(
						/<div style="max-width:(\d+)px" class="breadcrumb-item [^"]*">([^<]*)<\/div><svg/gu,
					),
				].map(([, width, name]) => [name, Number(width)]),
			},
		).toStrictEqual(
			{
				menus: 1,
				ellipsis: true,
				visible: [
					["Charlie xxxxxxx", 94],
					["Delta xxxxxxxxx", 94],
					["Echo xxxxxxxxxx", 95],
				],
			},
		);
	});

	it("starts the keyboard selection on the reducer's active enabled row", () =>
	{
		const html = render(
			{
				query: "qzpick",
				active: 2,
				rows: [
					{
						kind: "result",
						id: "r1",
						labelHtml: "One",
						disabled: false,
						icon: null,
					},
					{
						kind: "more",
						labelHtml: "More results",
						disabled: false,
						icon: "ellipsis",
					},
					...createRows("qzpick", false),
				],
			},
		);
		expect(
			[...html.matchAll(/<a [^>]*class="([^"]*)"/gu)].map(([, rowClass]) => rowClass === ROW_ACTIVE),
		).toStrictEqual([false, false, true, false]);
	});
});

describe("MoveAssistant removal", () =>
{
	it("renders Move To as the inline picker with no move-assistant markup", () =>
	{
		const html = render(
			{
				query: "qzpick",
				rows: [
					{
						kind: "result",
						id: "r1",
						labelHtml: "One",
						disabled: false,
						icon: null,
					},
					...createRows("qzpick", false),
				],
			},
		);
		expect(html.includes("move-assistant")).toBe(false);
	});

	it("deletes the modal component and its app mount", () =>
	{
		const source = (path: string) => fileURLToPath(new URL(`../src/client/${path}`, import.meta.url));
		expect(existsSync(source("components/move-assistant.tsx"))).toBe(false);
		expect(/MoveAssistant|move-assistant/u.test(readFileSync(source("app.tsx"), "utf8"))).toBe(false);
		expect(/MoveAssistant|moveAssistant/u.test(readFileSync(source("stores/outline.ts"), "utf8"))).toBe(false);
	});
});

describe("picker styles", () =>
{
	it("leaves the footer rows content-box like upstream", () =>
	{
		const css = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
		expect(css).not.toMatch(/\[data-popper-placement\] > \.flyout a\.menuItem\[style\*="height: 32px"\]/u);
	});
});

describe("LocationPicker driven by an outside filter", () =>
{
	it("renders the link-to header with no input wrapper when hideInput is set", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				LocationPicker,
				{
					position: [203, 361.5],
					step: 1,
					headerText: "link to",
					hideInput: true,
					query: "tar",
					onQueryChange: () =>
					{
					},
					rows: [
						{
							kind: "result",
							id: "r1",
							labelHtml: "<b><u>Tar</u></b>get",
							disabled: false,
							icon: null,
						},
					],
					crumbsOf: () => [],
					onSelect: () =>
					{
					},
				},
			),
		);

		expect(
			{
				header: html.includes(">link to</div>"),
				input: html.includes("<input"),
				wrapper: html.includes("p-l pt-0 mobile:pl-ml"),
				menuClass: html.includes("[&amp;_.help-text]:p-l [&amp;_.help-text]:pt-m !static"),
			},
		).toStrictEqual(
			{
				header: true,
				input: false,
				wrapper: false,
				menuClass: true,
			},
		);
	});
});
