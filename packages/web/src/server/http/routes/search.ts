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

/** Read through a function so the abort check after an await is not narrowed to the one before it. */
function aborted(request: Request): boolean
{
	return request.signal.aborted;
}

/** The search routes (see `ops/search.ts`); the locations route drops a request the client already aborted (499). */
export function searchRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/helpers", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"search.helpers",
			{
				rootId: c.req.query("rootId") ?? "",
			},
		),
	);
	routes.post("/tree", async (c) => callOp(resolveStore, c.req.raw, "search.tree", await body(c.req.raw)));
	routes.post("/switcher", async (c) => callOp(resolveStore, c.req.raw, "search.switcher", await body(c.req.raw)));
	routes.post("/locations", async (c) =>
	{
		const input = await body(c.req.raw);
		// Typing supersedes earlier keystrokes; the client aborts them, so skip ranking for a request nobody waits on.
		if (aborted(c.req.raw))
		{
			return new Response(
				null,
				{
					status: 499,
				},
			);
		}
		const response = await callOp(resolveStore, c.req.raw, "search.locations", input);
		return aborted(c.req.raw)
			? new Response(
					null,
					{
						status: 499,
					},
				)
			: response;
	});
	routes.post("/", async (c) => callOp(resolveStore, c.req.raw, "search.text", await body(c.req.raw)));
	return routes;
}
