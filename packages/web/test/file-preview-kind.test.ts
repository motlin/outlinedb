import {describe, expect, it} from "vite-plus/test";
import type {NodeAttachment} from "../src/node-types.js";
import {formatMediaTime, isPreviewable, previewKind} from "../src/client/components/file-preview-kind.js";

function attachment(fileType: string, isDeleted = false): NodeAttachment
{
	return {
		fileName: "f",
		fileType,
		objectFolder: "folder",
		imageOriginalWidth: null,
		imageOriginalHeight: null,
		imageOriginalPixels: null,
		isAnimatedGif: false,
		isDeleted,
	};
}

describe("previewKind", () =>
{
	it("picks the upstream dispatcher entry by mime type", () =>
	{
		expect([
			previewKind(attachment("audio/wav")),
			previewKind(attachment("audio/mpeg")),
			previewKind(attachment("video/mp4")),
			previewKind(attachment("video/quicktime")),
			previewKind(attachment("image/png")),
			previewKind(attachment("application/pdf")),
			previewKind(attachment("text/markdown")),
			previewKind(attachment("image/png", true)),
			previewKind(null),
			previewKind(undefined),
		]).toStrictEqual(["audio", "audio", "video", "video", "image", "pdf", "download", "none", "none", "none"]);
	});
});

describe("isPreviewable", () =>
{
	it("is true for images and videos only, which drives the item--with-image class", () =>
	{
		expect([
			isPreviewable(attachment("audio/wav")),
			isPreviewable(attachment("video/mp4")),
			isPreviewable(attachment("image/jpeg")),
			isPreviewable(attachment("application/pdf")),
			isPreviewable(attachment("video/mp4", true)),
			isPreviewable(null),
		]).toStrictEqual([false, true, true, false, false, false]);
	});
});

describe("formatMediaTime", () =>
{
	it("formats mm:ss with unwrapped minutes and 00:00 for NaN", () =>
	{
		expect([NaN, 0, 12.542, 4503].map(formatMediaTime)).toStrictEqual(["00:00", "00:00", "00:12", "75:03"]);
	});
});
