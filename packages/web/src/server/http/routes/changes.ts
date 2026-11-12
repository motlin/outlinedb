import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /?since=1d` -> the changes since a cutoff. */
export function changesRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"changes.list",
			{
				since: c.req.query("since"),
			},
		),
	);
	return routes;
}
