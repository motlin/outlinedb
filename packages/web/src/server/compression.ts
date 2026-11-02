/**
 * Compress API responses for clients that accept it. The page-load `GET /api/v1/expansion` alone is over a megabyte of
 * UUIDs uncompressed. The ladder WebSocket upgrade is left alone.
 */

import type {MiddlewareHandler} from "hono";
import {compress} from "hono/compress";

const UNCOMPRESSED_PATHS = new Set(["/api/v1/ladder/events"]);

export function apiCompression(): MiddlewareHandler
{
	const compressor = compress();
	return async (c, next) =>
	{
		if (UNCOMPRESSED_PATHS.has(c.req.path))
		{
			await next();
			return;
		}
		await compressor(c, next);
	};
}
