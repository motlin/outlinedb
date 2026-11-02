import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		() => {},
		{
			getState: () => ({}),
		},
	),
	outlineActions: {},
}));

const {MirrorsDialogView, lodashTruncate, deletionOrder} = await import("../src/client/components/mirrors-dialog.js");

const data =
{
	originalId: "O",
	nodeName: "Orig M",
	mirrors: [
		{
			id: "O",
			isOriginal: true,
			path: [
				{
					id: "P",
					name: "Park",
				},
				{
					id: "O",
					name: "Orig M",
				},
			],
		},
		{
			id: "M1",
			isOriginal: false,
			path: [
				{
					id: "M1",
					name: "Orig M",
				},
			],
		},
	],
};

describe("lodashTruncate", () =>
{
	it("cuts to the length including the ellipsis like lodash", () =>
	{
		expect([lodashTruncate("short", 15), lodashTruncate("Orig M and a very long name", 15)]).toStrictEqual([
			"short",
			"Orig M and a...",
		]);
	});
});

describe("deletionOrder", () =>
{
	it("deletes the mirrors before the original", () =>
	{
		expect(deletionOrder(data)).toStrictEqual(["M1", "O"]);
	});
});

describe("MirrorsDialogView", () =>
{
	it("renders upstream's title, tinted original row, linked copy row and delete button", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				MirrorsDialogView,
				{
					data,
					renderCrumbs: (location) => createElement("i", null, `crumbs:${location.id}`),
					onDeleteAll: () =>
					{
					},
				},
			),
		);
		expect(html.replace(/<svg.*?<\/svg>/u, "<svg/>")).toBe(
			'<div class="flex flex-col gap-xl">' +
				'<div class="text-xl font-bold">Mirrors for &quot;Orig M&quot;</div>' +
				'<div class="flex flex-col gap-m">' +
				'<div class="flex rounded-s flex-col gap-s px-l py-m bg-tint text-on-color"><div class="text-base"><p>Original</p></div><div class="flex flex-row items-center gap-m text-s"><p><strong>1.</strong></p><i>crumbs:O</i></div></div>' +
				'<div class="flex rounded-s flex-col gap-s px-l py-m text-primary"><div class="text-base"><p>Linked copy</p></div><div class="flex flex-row items-center gap-m text-s"><p><strong>2.</strong></p><i>crumbs:M1</i></div></div>' +
				"</div>" +
				'<div><button type="button" class="hover:no-underline button"><svg/><span class="ml-m">Delete Original and Linked copies</span></button></div>' +
				"</div>",
		);
	});
});
