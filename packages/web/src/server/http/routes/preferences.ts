import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /` -> preferences; `PATCH /` with any subset -> the full preferences. */
export function preferencesRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "preferences.get", {}));
	routes.patch("/", async (c) =>
	{
		const patch: unknown = await c.req.json().catch(() => {});
		return callOp(
			resolveStore,
			c.req.raw,
			"preferences.patch",
			{
				patch,
			},
			{
				error: "Invalid preferences patch",
			},
		);
	});
	return routes;
}
