import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** A request body that is not a JSON object reads as empty, so the op answers its own 400. */
async function body(request: Request): Promise<Record<string, unknown>>
{
	const parsed: unknown = await request.json().catch(() => {});
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		?
			{
				...parsed,
			}
		: {};
}

/** `POST /` finds nodes related to one by semantic similarity (see `ops/related.ts`). */
export function relatedRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.post("/", async (c) => callOp(resolveStore, c.req.raw, "related.find", await body(c.req.raw)));
	return routes;
}
