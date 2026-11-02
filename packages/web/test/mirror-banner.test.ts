import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import type {ReactNode, ReactPortal} from "react";
import {renderToStaticMarkup} from "react-dom/server";

vi.mock(import("react-dom"), async (importOriginal) => (
{
	...(await importOriginal()),
	createPortal: (node: ReactNode): ReactPortal => node as ReactPortal,
}));
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore:
	{
		getState: () => ({}),
	},
}));
vi.stubGlobal(
	"document",
	{
		body: {},
	},
);

const {MirrorBannerView, mirrorBannerOriginalId} = await import("../src/client/components/node-context-menu.js");

describe("mirror banner", () =>
{
	it("renders upstream's banner markup with the mirror count", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					MirrorBannerView,
					{
						count: 3,
						onSeeThem: () =>
						{
						},
					},
				),
			),
		).toBe(
			'<div class="flex flex-wrap justify-center py-m bg-tertiary !mt-0 mb-1.5 rounded-t-md border-b border-primary text-primary text-2xs"><span>Node has 3 mirrors.</span><a class="underline my-0 mx-xs">See them</a></div>',
		);
	});

	it("shows for a mirror, using its original, and for an original with mirrors, using itself", () =>
	{
		expect([
			mirrorBannerOriginalId(
				{
					id: "m1",
					isMirror: true,
					originalNodeId: "orig",
				},
			),
			mirrorBannerOriginalId(
				{
					id: "orig",
					hasMirrors: true,
				},
			),
			mirrorBannerOriginalId(
				{
					id: "plain",
				},
			),
		]).toStrictEqual(["orig", "orig", null]);
	});
});
