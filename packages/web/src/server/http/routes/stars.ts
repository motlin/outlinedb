import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

async function body(request: Request): Promise<Record<string, unknown>>
{
	const parsed: unknown = await request.json().catch(() => {});
	return typeof parsed === "object" && parsed !== null
		?
			{
				...parsed,
			}
		: {};
}

/**
 * `GET /` -> `{stars, nodes}`; `PUT /order` `{keys}` -> 204; `PUT /:key` `{nodeId, query}` -> 201 star;
 * `PATCH /:key` `{name}` -> 204; `DELETE /:key` -> 204. `/order` registers before `/:key`.
 */
export function starsRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "stars.list", {}));
	routes.put("/order", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"stars.order",
			await body(c.req.raw),
			{
				error: "body must be {keys: string[]}",
			},
		),
	);
	routes.put("/:key", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"stars.set",
			{
				...(await body(c.req.raw)),
				key: c.req.param("key"),
			},
			{
				error: "body must be {nodeId: string | null, query: string | null}",
			},
		),
	);
	routes.delete("/:key", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"stars.remove",
			{
				key: c.req.param("key"),
			},
		),
	);
	routes.patch("/:key", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"stars.rename",
			{
				...(await body(c.req.raw)),
				key: c.req.param("key"),
			},
			{
				error: "body must be {name: string | null}",
			},
		),
	);
	return routes;
}
