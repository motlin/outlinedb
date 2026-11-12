/**
 * The signed-file proxy: `files.signedUrl` answers a redirect (the HTTP layer's 302) to the short-lived signed S3 URL
 * that workflowy.com's session-cookie `/file-proxy/` endpoints hand out. The public API never returns attachment URLs, and
 * the browser has no session cookie, so the local server asks on its behalf and caches the answer for ten minutes, per server context (a Durable Object or the Node host).
 */

import {z} from "zod";
import type {NodeAttachment} from "../../node-types.js";
import type {ServerContext} from "../context.js";
import {loadAttachments, resolveNodeId} from "./nodes-shared.js";
import {defineOp, fail, ok} from "./define.js";
import {NoContentSchema} from "./schemas.js";

const SIGNED_URL_TTL_MS = 10 * 60_000;
/** Upstream rounds every requested preview width up to a multiple of this. */
const WIDTH_STEP = 400;

type PreviewRequest =
	|
	  {
			kind: "original";
	  }
	|
	  {
			kind: "preview";
			width: number;
			height: number;
	  };

/**
 * Port of upstream's preview size rule: round the requested width up to a 400px step. When that is at least as wide as the
 * original (and the image is not HEIC, which browsers cannot show), or the image is an animated GIF, ask for the original.
 */
function previewRequest(attachment: NodeAttachment, requestedWidth: number): PreviewRequest
{
	const originalWidth = attachment.imageOriginalWidth;
	const originalHeight = attachment.imageOriginalHeight;
	if (attachment.isAnimatedGif || originalWidth === null || originalHeight === null)
	{
		return {
			kind: "original",
		};
	}
	const width = Math.max(1, Math.ceil(requestedWidth / WIDTH_STEP)) * WIDTH_STEP;
	const heic = /^image\/hei[cf]$/u.test(attachment.fileType);
	if (width >= originalWidth && !heic)
	{
		return {
			kind: "original",
		};
	}
	return {
		kind: "preview",
		width,
		height: Math.round((width * originalHeight) / originalWidth),
	};
}

const signedUrls = new WeakMap<
	ServerContext,
	Map<
		string,
		{
			url: string;
			at: number;
		}
	>
>();

function cacheOf(ctx: ServerContext): Map<
	string,
	{
		url: string;
		at: number;
	}
>
{
	let cache = signedUrls.get(ctx);
	if (cache === undefined)
	{
		cache = new Map();
		signedUrls.set(ctx, cache);
	}
	return cache;
}

/** `w` is the raw `?w=` query string, absent for `original`. */
export const filesSignedUrl = defineOp(
	{
		input: z.object(
			{
				nodeId: z.string(),
				variant: z.enum(["preview", "original"]),
				w: z.string().optional(),
			},
		),
		/** The value is always null: the signed URL travels in `meta.redirect`. */
		output: NoContentSchema,
		async run(ctx, {nodeId, variant, w})
		{
			const adapter = ctx.internalAdapter?.();
			if (!adapter)
			{
				return fail(
					503,
					{
						error: "files-unavailable",
					},
				);
			}
			const id = resolveNodeId(ctx, nodeId);
			const attachment = id === null ? undefined : loadAttachments(ctx, [id]).get(id);
			if (id === null || attachment === undefined || attachment.isDeleted)
			{
				return fail(
					404,
					{
						error: "Attachment not found",
					},
				);
			}
			const ownerId = await adapter.fileOwnerId();
			const original = `/file-proxy/signed-original/${ownerId}/${id}/?attempt=1`;
			let path = original;
			if (variant === "preview")
			{
				const requested = Number(w);
				const request = previewRequest(
					attachment,
					Number.isFinite(requested) && requested > 0 ? requested : 700,
				);
				if (request.kind === "preview")
				{
					const folder =
						attachment.objectFolder === null
							? ""
							: `&folder=${encodeURIComponent(attachment.objectFolder)}`;
					path = `/file-proxy/signed-preview/${ownerId}/${id}/${request.width}x${request.height}/?attempt=1${folder}`;
				}
			}
			const signed = cacheOf(ctx);
			const cached = signed.get(path);
			if (cached !== undefined && Date.now() - cached.at < SIGNED_URL_TTL_MS)
			{
				return ok(
					null,
					{
						redirect: cached.url,
					},
				);
			}
			try
			{
				const url = await adapter.signedFileUrl(path);
				signed.set(
					path,
					{
						url,
						at: Date.now(),
					},
				);
				return ok(
					null,
					{
						redirect: url,
					},
				);
			}
			catch
			{
				return fail(
					503,
					{
						error: "files-unavailable",
					},
				);
			}
		},
	},
);
