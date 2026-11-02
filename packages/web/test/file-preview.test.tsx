// @vitest-environment happy-dom
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vite-plus/test";
import type {NodeAttachment} from "../src/node-types.js";
import {FilePreviewView, previewImageSrc} from "../src/client/components/file-preview.js";
import type {FilePreviewViewProps} from "../src/client/components/file-preview.js";
import {fileMenuRows} from "../src/client/components/file-menu.js";

function attachment(overrides: Partial<NodeAttachment> = {}): NodeAttachment
{
	return {
		fileName: "IMG.png",
		fileType: "image/png",
		objectFolder: "folder-1",
		imageOriginalWidth: 1440,
		imageOriginalHeight: 1020,
		imageOriginalPixels: 1,
		isAnimatedGif: false,
		isDeleted: false,
		...overrides,
	};
}

function props(overrides: Partial<FilePreviewViewProps> = {}): FilePreviewViewProps
{
	return {
		nodeId: "n1",
		attachment: attachment(),
		name: "",
		zoomedIn: false,
		innerWidth: 1440,
		thumbs: false,
		devicePixelRatio: 1,
		onImageMouseDown: () =>
		{
		},
		showFullScreen: () =>
		{
		},
		openSettings: () =>
		{
		},
		...overrides,
	};
}

function parse(html: string): Document
{
	return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

describe("FilePreviewView image", () =>
{
	it("renders upstream's file-preview, image-viewer and image structure for a 1440x1020 PNG", () =>
	{
		const doc = parse(renderToStaticMarkup(<FilePreviewView {...props()} />));
		const preview = doc.querySelector(".file-preview");
		const sizer = preview?.firstElementChild;
		const viewer = sizer?.firstElementChild;
		const img = viewer?.querySelector("img");
		expect(
			{
				previewClass: preview?.className,
				sizerClass: sizer?.className,
				sizerStyle: sizer?.getAttribute("style"),
				viewerClass: viewer?.className,
				viewerStyle: viewer?.getAttribute("style"),
				imgStyle: img?.getAttribute("style"),
				imgSrc: img?.getAttribute("src"),
				draggable: img?.getAttribute("draggable"),
				menuClass: viewer?.querySelector(".imagePreviewMenu")?.className,
				menuIcon: viewer?.querySelector(".imagePreviewMenu svg")?.getAttribute("data-icon"),
			},
		).toStrictEqual(
			{
				previewClass:
					"w-full relative file-preview ml-[var(--space-for-bullet)] max-w-[calc(100%-var(--space-for-bullet))]",
				sizerClass: "mt-[7px] max-w-full",
				sizerStyle: "width:calc(min(100%, 702px));--image-viewer-h:0;--image-viewer-pb:calc(100% * 0.7)",
				viewerClass:
					"box-border border border-solid border-secondary rounded-[3px] cursor-pointer overflow-hidden image-viewer image-viewer--no-name",
				viewerStyle: "position:relative",
				imgStyle: "width:100%",
				imgSrc: "/api/v1/files/n1/preview?w=702",
				draggable: "false",
				menuClass: "absolute top-m right-m hidden imagePreviewMenu",
				menuIcon: "ellipsis-vertical",
			},
		);
	});

	it("drops the no-name modifier for a named row and the aspect vars for an unknown size", () =>
	{
		const doc = parse(
			renderToStaticMarkup(
				<FilePreviewView
					{...props(
						{
							name: "Holiday",
							attachment: attachment(
								{
									imageOriginalWidth: null,
									imageOriginalHeight: null,
								},
							),
						},
					)}
				/>,
			),
		);
		expect(
			{
				viewerClass: doc.querySelector(".image-viewer")?.className,
				sizerStyle: doc.querySelector(".file-preview > div")?.getAttribute("style"),
			},
		).toStrictEqual(
			{
				viewerClass:
					"box-border border border-solid border-secondary rounded-[3px] cursor-pointer overflow-hidden image-viewer",
				sizerStyle: "width:calc(min(100%, 602px))",
			},
		);
	});

	it("scales the requested width by the device pixel ratio", () =>
	{
		expect(previewImageSrc("n1", 702, 2)).toBe("/api/v1/files/n1/preview?w=1404");
	});
});

describe("FilePreviewView dispatch", () =>
{
	it("renders the audio player, the video player and a Download button by mime type, and nothing when deleted", () =>
	{
		const kinds = (fileType: string, isDeleted = false) =>
		{
			const doc = parse(
				renderToStaticMarkup(
					<FilePreviewView
						{...props(
							{
								attachment: attachment(
									{
										fileType,
										isDeleted,
									},
								),
							},
						)}
					/>,
				),
			);
			return {
				preview: doc.querySelector(".file-preview") !== null,
				audio: doc.querySelector(".audio--player") !== null,
				video: doc.querySelector("video") !== null,
				image: doc.querySelector(".image-viewer") !== null,
				download: doc.querySelector("a.button")?.textContent ?? null,
			};
		};
		expect([
			kinds("audio/wav"),
			kinds("video/mp4"),
			kinds("text/markdown"),
			kinds("application/pdf"),
			kinds("image/png", true),
		]).toStrictEqual([
			{
				preview: true,
				audio: true,
				video: false,
				image: false,
				download: null,
			},
			{
				preview: true,
				audio: false,
				video: true,
				image: false,
				download: null,
			},
			{
				preview: true,
				audio: false,
				video: false,
				image: false,
				download: "Download",
			},
			{
				preview: true,
				audio: false,
				video: false,
				image: false,
				download: "Download",
			},
			{
				preview: false,
				audio: false,
				video: false,
				image: false,
				download: null,
			},
		]);
	});

	it("links the Download fallback to the signed original with the file name", () =>
	{
		const doc = parse(
			renderToStaticMarkup(
				<FilePreviewView
					{...props(
						{
							attachment: attachment(
								{
									fileType: "text/markdown",
									fileName: "notes.md",
								},
							),
						},
					)}
				/>,
			),
		);
		const link = doc.querySelector("a.button");
		expect(
			{
				href: link?.getAttribute("href"),
				download: link?.getAttribute("download"),
				style: link?.getAttribute("style"),
			},
		).toStrictEqual(
			{
				href: "/api/v1/files/n1/original",
				download: "notes.md",
				style: "padding-top:2px;padding-bottom:2px",
			},
		);
	});
});

describe("fileMenuRows", () =>
{
	const noop = () =>
	{
	};

	it("lists Show full-screen, View original, Download and Settings in order", () =>
	{
		expect(
			fileMenuRows(
				{
					showFullScreen: noop,
					viewOriginal: noop,
					download: noop,
					openSettings: noop,
				},
			).map((row) => [row.label, row.icon]),
		).toStrictEqual([
			["Show full-screen", "fal:arrows-maximize"],
			["View original", "fal:arrow-up-right-from-square"],
			["Download", "fal:arrow-down-long"],
			["Settings", "fal:gear"],
		]);
	});

	it("omits Show full-screen in the viewer's own menu", () =>
	{
		expect(
			fileMenuRows(
				{
					viewOriginal: noop,
					download: noop,
					openSettings: noop,
				},
			).map((row) => row.label),
		).toStrictEqual(["View original", "Download", "Settings"]);
	});
});
