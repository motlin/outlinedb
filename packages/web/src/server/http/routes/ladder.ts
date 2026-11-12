import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** A body that is not a JSON object reads as empty, so its schema answers 400. */
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

const MOVE_INPUT_ERROR =
{
	error: "root, node_id and to_tier are required strings, and before_id must be a string when given",
};
const COMPLETE_INPUT_ERROR =
{
	error: "root and node_id are required",
};

/** `GET /` -> `{ladders}`; `POST /move` -> `{event}`; `POST /complete` -> `{event}`. The socket stays on the Durable Object. */
export function ladderRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "ladder.read", {}));
	routes.post("/move", async (c) =>
		callOp(resolveStore, c.req.raw, "ladder.move", await body(c.req.raw), MOVE_INPUT_ERROR),
	);
	routes.post("/complete", async (c) =>
		callOp(resolveStore, c.req.raw, "ladder.complete", await body(c.req.raw), COMPLETE_INPUT_ERROR),
	);
	return routes;
}
