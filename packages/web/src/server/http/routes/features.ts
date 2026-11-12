import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /` -> visible and enabled features; `POST /:codename` with `{on}` turns one on or off. */
export function featuresRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "features.get", {}));
	routes.post("/:codename", async (c) =>
	{
		const body: unknown = await c.req.json().catch(() => {});
		const raw =
			typeof body === "object" && body !== null
				?
					{
						...body,
						codename: c.req.param("codename"),
					}
				: body;
		return callOp(
			resolveStore,
			c.req.raw,
			"features.set",
			raw,
			{
				error: "expected a feature codename and {on: boolean}",
			},
		);
	});
	return routes;
}
