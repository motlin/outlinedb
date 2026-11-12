import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

async function body(request: Request): Promise<unknown>
{
	return request.json().catch(() => {});
}

/**
 * `GET /?version=<version>` -> `{version, expandedIds}` (null ids while the keys still match the version);
 * `PATCH /` `{changes}` -> 204;
 * `GET /left-bar` -> `{keys}`; `PATCH /left-bar` `{changes}` -> 204.
 */
export function expansionRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"expansion.get",
			{
				version: c.req.query("version"),
			},
			{
				error: "version must be an earlier answer's version",
			},
		),
	);
	routes.patch("/", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"expansion.patch",
			await body(c.req.raw),
			{
				error: "body must be {changes: {[nodeId]: boolean}}",
			},
		),
	);
	routes.get("/left-bar", async (c) => callOp(resolveStore, c.req.raw, "expansion.leftBarGet", {}));
	routes.patch("/left-bar", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"expansion.leftBarPatch",
			await body(c.req.raw),
			{
				error: "body must be {changes: {[leftbar__home__|leftbar__starred__ key]: boolean}}",
			},
		),
	);
	return routes;
}
