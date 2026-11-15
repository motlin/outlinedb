import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** A Content-Type's media type without its parameters (`text/plain;charset=UTF-8` -> `text/plain`). */
function mediaType(header: string | undefined): string
{
	const type = header?.split(";")[0]?.trim() ?? "";
	return type === "" ? "application/octet-stream" : type;
}

/**
 * `POST /?parentId=&name=` stores the raw body (typed by its Content-Type) as a new attachment node -> 201 `{id}`.
 * `GET /:nodeId/preview?w=` and `GET /:nodeId/original` -> the stored bytes, else 302 to the signed file URL.
 */
export function filesRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.post("/", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"files.upload",
			{
				parentId: c.req.query("parentId"),
				index: c.req.query("index"),
				fileName: c.req.query("name"),
				fileType: mediaType(c.req.header("content-type")),
				width: c.req.query("width"),
				height: c.req.query("height"),
				bytes: new Uint8Array(await c.req.arrayBuffer()),
			},
		),
	);
	routes.get("/:nodeId/:variant{preview|original}", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"files.signedUrl",
			{
				nodeId: c.req.param("nodeId"),
				variant: c.req.param("variant"),
				w: c.req.query("w"),
			},
		),
	);
	return routes;
}
