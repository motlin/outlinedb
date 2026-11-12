import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /?rootId=<optional>` -> the Custom tree's grammar sections. */
export function customTreeRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"customTree.get",
			{
				rootId: c.req.query("rootId"),
			},
		),
	);
	return routes;
}
