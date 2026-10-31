import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /` -> our read What's New entries; `POST /read` with `{entries}` marks them read. */
export function whatsNewRoutes(resolveStore: ResolveStore): Hono {
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "whatsNew.get", {}));
	routes.post("/read", async (c) => {
		const body: unknown = await c.req.json().catch(() => {});
		return callOp(resolveStore, c.req.raw, "whatsNew.markRead", body, {error: "expected {entries: string[]}"});
	});
	return routes;
}
