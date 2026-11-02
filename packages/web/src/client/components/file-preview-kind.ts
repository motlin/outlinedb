import {isFeatureOn} from "../features.js";
import type {NodeAttachment} from "../../node-types.js";

export type PreviewKind = "none" | "image" | "audio" | "pdf" | "video" | "download";

/**
 * Which `GuiFilePreviews` entry upstream's `.file-preview` dispatcher picks, in its live order: image, audio, pdf, video,
 * then the Download fallback. A missing or deleted attachment renders nothing.
 */
export function previewKind(attachment: NodeAttachment | null | undefined): PreviewKind
{
	if (attachment === null || attachment === undefined || attachment.isDeleted)
	{
		return "none";
	}
	const type = attachment.fileType;
	if (type.startsWith("image/"))
	{
		return "image";
	}
	if (type.startsWith("audio/"))
	{
		return "audio";
	}
	if (type === "application/pdf")
	{
		return "pdf";
	}
	if (type.startsWith("video/") && isFeatureOn("beta_redirect"))
	{
		return "video";
	}
	return "download";
}

/** Upstream's `previewable`: only images and videos give the row `item--with-image`. */
export function isPreviewable(attachment: NodeAttachment | null | undefined): boolean
{
	const kind = previewKind(attachment);
	return kind === "image" || kind === "video";
}

/** Upstream's `vf2`: `mm:ss` with minutes that never wrap into hours; NaN is `00:00`. */
export function formatMediaTime(seconds: number): string
{
	if (Number.isNaN(seconds))
	{
		return "00:00";
	}
	const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
	const rest = String(Math.floor(seconds % 60)).padStart(2, "0");
	return `${minutes}:${rest}`;
}

/** The URL a file's signed original redirects from, which `<audio src>`/`<video src>`/`<a download>` can use directly. */
export function originalUrl(nodeId: string): string
{
	return `/api/v1/files/${nodeId}/original`;
}
