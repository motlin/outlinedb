import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /:nodeId/preview?w=` and `GET /:nodeId/original` -> 302 to the signed file URL. */
export function filesRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
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
