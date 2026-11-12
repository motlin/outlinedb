// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeAttachment} from "../src/node-types.js";
import {ImageViewerView} from "../src/client/components/image-viewer.js";
import type {ImageViewerViewProps} from "../src/client/components/image-viewer.js";

declare global
{
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const attachment: NodeAttachment =
{
	fileName: "IMG.png",
	fileType: "image/png",
	objectFolder: "folder-1",
	imageOriginalWidth: 1440,
	imageOriginalHeight: 1020,
	imageOriginalPixels: 2,
	isAnimatedGif: false,
	isDeleted: false,
};

const cleanups: (() => void)[] = [];
afterEach(() =>
{
	for (const cleanup of cleanups.splice(0))
	{
		cleanup();
	}
});

function mount(overrides: Partial<ImageViewerViewProps> = {})
{
	const calls: string[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const props: ImageViewerViewProps =
	{
		nodeId: "n1",
		attachment,
		prevId: null,
		nextId: "n2",
		onHide: () =>
		{
			calls.push("hide");
			act(() =>
			{
				root.unmount();
			});
		},
		onShow: (id) =>
		{
			calls.push(`show ${id}`);
		},
		onZoom: (id) =>
		{
			calls.push(`zoom ${id}`);
		},
		openSettings: () =>
		{
			calls.push("settings");
		},
		...overrides,
	};
	act(() =>
	{
		root.render(<ImageViewerView {...props} />);
	});
	cleanups.push(() =>
	{
		try
		{
			act(() =>
			{
				root.unmount();
			});
		}
		catch
		{
			// already unmounted
		}
		host.remove();
	});
	return {
		calls,
	};
}

function press(key: string)
{
	act(() =>
	{
		document.body.dispatchEvent(
			new KeyboardEvent(
				"keydown",
				{
					key,
					bubbles: true,
					cancelable: true,
				},
			),
		);
	});
}

describe("ImageViewerView", () =>
{
	it("portals upstream's overlay into body with the original-size image and the two gallery buttons", () =>
	{
		mount();

		const overlay = document.body.querySelector(".overlay");
		expect(
			{
				overlayClass: overlay?.className,
				zIndex: overlay instanceof HTMLElement ? overlay.style.zIndex : null,
				imgSrc: overlay?.querySelector("img")?.getAttribute("src"),
				imgClass: overlay?.querySelector("img")?.className,
				sizerStyle: overlay?.querySelector("img")?.parentElement?.getAttribute("style"),
				buttons: [...(overlay?.querySelectorAll(".gallery-btn") ?? [])].map((b) => [
					b.className,
					b.getAttribute("title"),
				]),
			},
		).toStrictEqual(
			{
				overlayClass: "fixed overlay bg-black/80",
				zIndex: "400",
				imgSrc: "/api/v1/files/n1/original",
				imgClass: "max-w-full max-h-full pinch-element touch-none",
				sizerStyle: "position: relative; width: calc(min(100%, 720px));",
				buttons: [
					["gallery-btn prev inactive iconButton lg shape-circle", "Previous image"],
					["gallery-btn next iconButton lg shape-circle", "Next image"],
				],
			},
		);
	});

	it("hides on Escape and pops its history entry", () =>
	{
		const push = vi.spyOn(history, "pushState");
		const {calls} = mount();
		const pushed = push.mock.calls.map(([state]: unknown[]) => state);
		push.mockRestore();
		history.replaceState(
			{
				image: true,
			},
			"",
		);
		const back = vi.spyOn(history, "back");

		press("Escape");

		expect(
			{
				pushed,
				calls,
				backCalls: back.mock.calls.length,
				overlay: document.body.querySelector(".overlay"),
			},
		).toStrictEqual(
			{
				pushed: [
					{
						image: true,
					},
				],
				calls: ["hide"],
				backCalls: 1,
				overlay: null,
			},
		);
		back.mockRestore();
	});

	it("steps with the arrow keys only toward an existing neighbour", () =>
	{
		const {calls} = mount(
			{
				prevId: null,
				nextId: "n2",
			},
		);

		press("ArrowLeft");
		press("ArrowRight");

		expect(calls).toStrictEqual(["show n2"]);
	});

	it("hides and zooms into the image's item on Enter", () =>
	{
		const {calls} = mount();

		press("Enter");

		expect(calls).toStrictEqual(["hide", "zoom n1"]);
	});

	it("hides on a click outside .keep-overlay but not on the gallery button", () =>
	{
		const {calls} = mount();

		act(() =>
		{
			document.body.querySelector<HTMLElement>(".gallery-btn.next")?.click();
		});
		const afterGallery = [...calls];
		act(() =>
		{
			document.body.querySelector<HTMLElement>("img")?.click();
		});

		expect(
			{
				afterGallery,
				calls,
			},
		).toStrictEqual(
			{
				afterGallery: ["show n2"],
				calls: ["show n2", "hide"],
			},
		);
	});
});
