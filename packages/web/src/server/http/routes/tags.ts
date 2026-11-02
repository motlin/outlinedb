import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /` -> `{colors}`; `PUT /:name` `{color}` sets one; `DELETE /:name` clears one. */
export function tagsRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "tags.list", {}));
	routes.put("/:name", async (c) =>
	{
		const body: unknown = await c.req.json().catch(() => {});
		const color = typeof body === "object" && body !== null && "color" in body ? body.color : undefined;
		// A color outside the palette fails the op's schema; the 400 names what was sent.
		return callOp(
			resolveStore,
			c.req.raw,
			"tags.set",
			{
				name: c.req.param("name"),
				color,
			},
			{
				error: `Invalid color: ${typeof color === "string" ? color : "(missing)"}`,
			},
		);
	});
	routes.delete("/:name", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"tags.clear",
			{
				name: c.req.param("name"),
			},
		),
	);
	return routes;
}
