import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";
import type {TagPopupState} from "../src/client/components/tag-autocomplete-popup.js";

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
vi.stubGlobal("devicePixelRatio", 2);

const {TagAutocompletePopup, tagPopupInput, tagPopupKey} =
	await import("../src/client/components/tag-autocomplete-popup.js");

/** Upstream's popup (`dumps/tags-autocomplete-upstream-popup.html`) cut to its first two rows, in React's attribute order. */
const UPSTREAM_TWO_ROWS =
	'<div class="z-[100]" style="position:fixed;inset:0px auto auto 0px;transform:translate3d(190px, 361.5px, 0px)" data-popper-reference-hidden="false" data-popper-escaped="false" data-popper-placement="bottom-start">' +
	'<div style="pointer-events:auto;z-index:300;min-width:100%;max-width:240px;margin-top:4px;top:100%;transform:scale(1, 1) translateX(0);transform-origin:90% 0;opacity:1" class="wf-menu flex flex-col border border-solid border-primary font-normal text-xs rounded-md bg-primary shadow-md overflow-x-hidden [transition:200ms_opacity] print:hidden absolute flyout menu ">' +
	'<div style="--menu-max-h:calc(100vh - 50px)" class=" scroller overflow-y-auto desktop:max-h-[min(var(--menu-max-h),calc(100vh-50px))] mobile:max-h-[min(var(--menu-max-h),50vh)] [&amp;&gt;*:first-child]:mt-xs [&amp;&gt;*:last-child]:mb-xs ">' +
	'<a data-handbook-placement="right" class="pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary bg-secondary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem menuItem active "><span class="relative flex justify-between items-center"><span class="grow flex items-center gap-m whitespace-nowrap text-ellipsis overflow-hidden desktop:text-xs">#taZebra</span></span></a>' +
	'<a data-handbook-placement="right" class="pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem menuItem "><span class="relative flex justify-between items-center"><span class="grow flex items-center gap-m whitespace-nowrap text-ellipsis overflow-hidden desktop:text-xs">#taApple</span></span></a>' +
	"</div></div></div>";

/** Collapses the class templates' newlines and indents the way the browser's class list does. */
function collapse(html: string): string
{
	return html.replaceAll(/\s+/gu, " ");
}

describe("TagAutocompletePopup", () =>
{
	it("renders upstream's flyout menu at the anchor with the active row highlighted", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				TagAutocompletePopup,
				{
					tags: ["#taZebra", "#taApple"],
					active: 0,
					left: 190,
					top: 361.5,
					onAccept: () =>
					{
					},
				},
			),
		);
		expect(collapse(html)).toBe(UPSTREAM_TWO_ROWS);
	});
});

const SHOWN: TagPopupState =
{
	attached: true,
	visible: true,
	active: 0,
};

describe("tagPopupKey", () =>
{
	it("hides on Escape but stays attached, and the next input shows it again", () =>
	{
		const escaped = tagPopupKey(
			SHOWN,
			{
				key: "Escape",
			},
			2,
		);
		expect([escaped, tagPopupInput(escaped.state)]).toStrictEqual([
			{
				state:
				{
					attached: true,
					visible: false,
					active: 0,
				},
				accept: null,
				preventDefault: true,
			},
			{
				attached: true,
				visible: true,
				active: 0,
			},
		]);
	});

	it("lets a second Escape fall through to the editor", () =>
	{
		expect(
			tagPopupKey(
				{
					attached: true,
					visible: false,
					active: 0,
				},
				{
					key: "Escape",
				},
				2,
			),
		).toStrictEqual(
			{
				state:
				{
					attached: true,
					visible: false,
					active: 0,
				},
				accept: null,
				preventDefault: false,
			},
		);
	});

	it("accepts the active row on Enter and Tab", () =>
	{
		expect([
			tagPopupKey(
				{
					...SHOWN,
					active: 1,
				},
				{
					key: "Enter",
				},
				2,
			),
			tagPopupKey(
				SHOWN,
				{
					key: "Tab",
				},
				2,
			),
		]).toStrictEqual([
			{
				state:
				{
					attached: true,
					visible: true,
					active: 1,
				},
				accept: 1,
				preventDefault: true,
			},
			{
				state: SHOWN,
				accept: 0,
				preventDefault: true,
			},
		]);
	});

	it("hides the popup on Enter and Tab with no active row, and the next input re-shows it", () =>
	{
		const idle =
		{
			...SHOWN,
			active: -1,
		};
		const hidden =
		{
			state:
			{
				attached: true,
				visible: false,
				active: -1,
			},
			accept: null,
			preventDefault: true,
		};
		expect([
			tagPopupKey(
				idle,
				{
					key: "Enter",
				},
				2,
			),
			tagPopupKey(
				idle,
				{
					key: "Tab",
				},
				2,
			),
		]).toStrictEqual([hidden, hidden]);
		expect(tagPopupInput(hidden.state)).toStrictEqual(
			{
				attached: true,
				visible: true,
				active: -1,
			},
		);
	});

	it("moves the active row with the arrows, clamping at the last row", () =>
	{
		const down = tagPopupKey(
			SHOWN,
			{
				key: "ArrowDown",
			},
			2,
		);
		expect([
			down,
			tagPopupKey(
				down.state,
				{
					key: "ArrowDown",
				},
				2,
			),
			tagPopupKey(
				down.state,
				{
					key: "ArrowUp",
				},
				2,
			),
		]).toStrictEqual([
			{
				state:
				{
					attached: true,
					visible: true,
					active: 1,
				},
				accept: null,
				preventDefault: true,
			},
			{
				state:
				{
					attached: true,
					visible: true,
					active: 1,
				},
				accept: null,
				preventDefault: true,
			},
			{
				state: SHOWN,
				accept: null,
				preventDefault: true,
			},
		]);
	});

	it("leaves other keys, and every key while hidden, to the editor", () =>
	{
		expect([
			tagPopupKey(
				SHOWN,
				{
					key: "a",
				},
				2,
			),
			tagPopupKey(
				{
					attached: false,
					visible: false,
					active: 0,
				},
				{
					key: "Enter",
				},
				2,
			),
		]).toStrictEqual([
			{
				state: SHOWN,
				accept: null,
				preventDefault: false,
			},
			{
				state:
				{
					attached: false,
					visible: false,
					active: 0,
				},
				accept: null,
				preventDefault: false,
			},
		]);
	});
});
