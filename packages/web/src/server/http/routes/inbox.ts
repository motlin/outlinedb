import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /share?title=&text=&url=` -> 302 to the Inbox after adding the shared item (the manifest's share target). */
export function inboxRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/share", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"inbox.share",
			{
				title: c.req.query("title"),
				text: c.req.query("text"),
				url: c.req.query("url"),
			},
		),
	);
	return routes;
}
