import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** `GET /` -> the signed-in account; `GET /ai` -> its AI chat settings. */
export function accountRoutes(resolveStore: ResolveStore): Hono {
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "account.get", {}));
	routes.get("/ai", async (c) => callOp(resolveStore, c.req.raw, "account.ai", {}));
	return routes;
}
