import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /?root=&prefix=&limit=&item=&name=&note=&fallback=` -> `{tags}`; the op reads the raw query values. */
export function tagIndexRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "tagIndex.autocomplete", c.req.query()));
	return routes;
}
