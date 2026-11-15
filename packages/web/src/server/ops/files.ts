/**
 * Attachment bytes. `files.upload` stores a standalone account's new attachment in the host's blob store (R2 or disk)
 * and creates its node. `files.signedUrl` serves the bytes the blob store holds for a node (an upload, or a copy
 * `files mirror` made), else answers a redirect (the HTTP layer's 302) to the short-lived signed S3 URL that
 * workflowy.com's session-cookie `/file-proxy/` endpoints hand out. The public API never returns attachment URLs, and
 * the browser has no session cookie, so the local server asks on its behalf and caches the answer for ten minutes, per server context (a Durable Object or the Node host).
 */

import {LocalTreeWriter} from "@outlinedb/shared/cache";
import {fileBlobs} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq} from "drizzle-orm";
import {z} from "zod";
import type {NodeAttachment} from "../../node-types.js";
import type {ServerContext} from "../context.js";
import {blobKey, sha256Hex} from "../blob-store.js";
import {loadAttachments, parseParent, resolveNodeId} from "./nodes-shared.js";
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

/** The bytes the blob store holds for a node's live "ok" `file_blobs` version, or undefined. */
async function storedFile(
	ctx: ServerContext,
	nodeId: string,
	fileType: string,
): Promise<
	|
	  {
			bytes: Uint8Array<ArrayBuffer>;
			contentType: string;
	  }
	| undefined
>
{
	if (ctx.blobs === undefined)
	{
		return undefined;
	}
	const row = ctx.db
		.select(
			{
				localPath: fileBlobs.localPath,
				contentType: fileBlobs.contentType,
			},
		)
		.from(fileBlobs)
		.where(and(eq(fileBlobs.nodeId, nodeId), eq(fileBlobs.status, "ok"), eq(fileBlobs.systemTo, FAR_FUTURE_DATE)))
		.get();
	if (row?.localPath === undefined || row.localPath === null)
	{
		return undefined;
	}
	const bytes = await ctx.blobs.get(row.localPath);
	return bytes === null
		? undefined
		:
			{
				bytes,
				contentType: row.contentType ?? fileType,
			};
}

const FILES_UNAVAILABLE =
{
	error: "files-unavailable",
};

const UPLOAD_UNAVAILABLE =
{
	error: "upload-unavailable",
};

/**
 * Store an uploaded file's bytes under their hash and create its attachment node, recording `s3_files` and
 * `file_blobs`. Standalone only: a mirror's attachments live on workflowy.com's S3, which this cannot write.
 */
export const filesUpload = defineOp(
	{
		input: z.object(
			{
				/** The parent node id, short id or `home`. */
				parentId: z.string().default("home"),
				index: z.coerce.number().int().nonnegative().optional(),
				fileName: z.string().min(1),
				fileType: z.string().min(1),
				width: z.coerce.number().int().positive().optional(),
				height: z.coerce.number().int().positive().optional(),
				bytes: z.instanceof(Uint8Array),
			},
		),
		output: z.object(
			{
				id: z.string(),
			},
		),
		async run(ctx, input)
		{
			const {blobs} = ctx;
			if (ctx.mode !== "standalone" || blobs === undefined)
			{
				return fail(503, UPLOAD_UNAVAILABLE);
			}
			const parent = parseParent(ctx, input.parentId);
			if (!parent.ok || (parent.parentId !== null && !ctx.cacheService.getNode(parent.parentId)))
			{
				return fail(
					404,
					{
						error: "Parent node not found",
					},
				);
			}
			// A copy owns a plain ArrayBuffer, which Web Crypto and the stores take.
			const bytes = new Uint8Array(input.bytes);
			const sha256 = await sha256Hex(bytes);
			const key = blobKey(sha256);
			await blobs.put(key, bytes);
			const {id} = new LocalTreeWriter(ctx.db).createAttachmentAt(
				{
					parentId: parent.parentId,
					index: input.index,
					s3File:
					{
						isFile: true,
						fileName: input.fileName,
						fileType: input.fileType,
						isAnimatedGIF: false,
						isDeleted: false,
						...(input.width === undefined || input.height === undefined
							? {}
							:
								{
									imageOriginalWidth: input.width,
									imageOriginalHeight: input.height,
									imageOriginalPixels: input.width * input.height,
								}),
					},
					blob:
					{
						sha256,
						size: bytes.byteLength,
						contentType: input.fileType,
						localPath: key,
					},
				},
			);
			return ok(
				{
					id,
				},
				{
					created: true,
				},
			);
		},
	},
);

/** `w` is the raw `?w=` query string, absent for `original`. The blob store's copy wins; it is served at full size. */
export const filesSignedUrl = defineOp(
	{
		input: z.object(
			{
				nodeId: z.string(),
				variant: z.enum(["preview", "original"]),
				w: z.string().optional(),
			},
		),
		/** The value is always null: the bytes travel in `meta.file`, the signed URL in `meta.redirect`. */
		output: NoContentSchema,
		async run(ctx, {nodeId, variant, w})
		{
			const adapter = ctx.internalAdapter?.();
			if (!adapter && ctx.blobs === undefined)
			{
				return fail(503, FILES_UNAVAILABLE);
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
			const file = await storedFile(ctx, id, attachment.fileType);
			if (file !== undefined)
			{
				return ok(
					null,
					{
						file,
					},
				);
			}
			if (!adapter)
			{
				return fail(503, FILES_UNAVAILABLE);
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
				return fail(503, FILES_UNAVAILABLE);
			}
		},
	},
);
