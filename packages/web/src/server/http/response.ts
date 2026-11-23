import type {z} from "zod";
import type {Json, OpResult} from "../ops/define.js";
import {Ops} from "../ops/index.js";
import type {OpInput, OpName} from "../ops/index.js";
import type {StoreClient} from "../store.js";

/** Attachment types a browser only displays, never runs: raster images, audio, video and PDF (SVG can hold script). */
const PASSIVE_MEDIA_TYPE = /^(?:image\/(?!svg)|audio\/|video\/|application\/pdf\b)/iu;

export type ResolveStore = (request: Request) => StoreClient | Promise<StoreClient>;

/** Builds the Response for an op result: 204 for null, stored file bytes, 304, 302, ETag and Server-Timing, or the error body. */
export function toResponse(result: OpResult<unknown>): Response
{
	if (!result.ok)
	{
		return Response.json(
			result.body,
			{
				status: result.status,
			},
		);
	}
	const {meta} = result;
	const headers = new Headers();
	if (meta?.etag !== undefined)
	{
		headers.set("ETag", meta.etag);
	}
	if (meta?.timing !== undefined && meta.timing.length > 0)
	{
		headers.set("Server-Timing", meta.timing.join(", "));
	}
	if (meta?.file !== undefined)
	{
		headers.set("Content-Type", meta.file.contentType);
		// The uploader picked the type, and these bytes share the app's origin: never sniff, and run anything that is
		// not passive media (an HTML page, an SVG) in an opaque origin so it cannot call the API as the viewer.
		headers.set("X-Content-Type-Options", "nosniff");
		if (!PASSIVE_MEDIA_TYPE.test(meta.file.contentType))
		{
			headers.set("Content-Security-Policy", "sandbox");
		}
		// Content-addressed bytes never change under a node, but another account's must never come from a shared cache.
		headers.set("Cache-Control", "private, max-age=86400");
		return new Response(
			meta.file.bytes,
			{
				headers,
			},
		);
	}
	if (meta?.redirect !== undefined)
	{
		headers.set("Location", meta.redirect);
		return new Response(
			null,
			{
				status: 302,
				headers,
			},
		);
	}
	if (meta?.notModified === true)
	{
		return new Response(
			null,
			{
				status: 304,
				headers,
			},
		);
	}
	if (meta?.created === true)
	{
		return result.value === null
			? new Response(
					null,
					{
						status: 201,
						headers,
					},
				)
			: Response.json(
					result.value,
					{
						status: 201,
						headers,
					},
				);
	}
	if (result.value === null)
	{
		return new Response(
			null,
			{
				status: 204,
				headers,
			},
		);
	}
	return Response.json(
		result.value,
		{
			headers,
		},
	);
}

/** Validates raw request data with an op's schema; a miss is a 400 carrying `errorBody` verbatim. */
export function parseInput<S extends z.ZodType>(
	schema: S,
	raw: unknown,
	errorBody: Json,
):
	|
	  {
			ok: true;
			value: z.output<S>;
	  }
	|
	  {
			ok: false;
			status: 400;
			body: Json;
	  }
{
	const parsed = schema.safeParse(raw);
	return parsed.success
		?
			{
				ok: true,
				value: parsed.data,
			}
		:
			{
				ok: false,
				status: 400,
				body: errorBody,
			};
}

/**
 * Validates `raw` with the op's schema (applying its defaults, which the store never does), then makes the request's one `call`.
 * A schema miss answers 400 with `errorBody` verbatim.
 */
export async function callOp(
	resolveStore: ResolveStore,
	request: Request,
	op: OpName,
	raw: unknown,
	errorBody: Json =
	{
		error: "Invalid request",
	},
): Promise<Response>
{
	const input = parseInput(Ops[op].input, raw, errorBody);
	if (!input.ok)
	{
		return toResponse(input);
	}
	const store = await resolveStore(request);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema's output is the op's input once its defaults are applied
	return toResponse(await store.call(op, input.value));
}
