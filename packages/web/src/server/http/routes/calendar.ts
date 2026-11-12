import {Hono} from "hono";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

const INVALID_SETTINGS =
{
	error: "foundDates and dayPrefix must be booleans, and at least one is required",
};
const INVALID_LEVELS =
{
	error: "levels must be an object of year, month, week and day booleans",
};
const INVALID_UNDO =
{
	error: "rootId must be a non-empty string when given",
};

/** A request body that is not valid JSON reads as undefined, so the op's schema answers 400. */
async function body(request: Request): Promise<
{
	body: unknown;
}>
{
	return {
		body: await request.json().catch(() => {}),
	};
}

/** Like {@link body}, but an unreadable body reads as empty (the undo's body is optional). */
async function optionalBody(request: Request): Promise<
{
	body: unknown;
}>
{
	return {
		body: await request.json().catch(() => ({})),
	};
}

/** The calendar routes (see `ops/calendar.ts` for what each answers); layout writes report `Server-Timing`. */
export function calendarRoutes(resolveStore: ResolveStore): Hono
{
	const routes = new Hono();
	routes.get("/day/:dateId", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"calendar.day",
			{
				dateId: c.req.param("dateId"),
				level: c.req.query("level"),
			},
		),
	);
	routes.get("/days", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"calendar.days",
			{
				year: c.req.query("year"),
				month: c.req.query("month"),
				found: c.req.query("found"),
			},
		),
	);
	routes.get("/settings", async (c) => callOp(resolveStore, c.req.raw, "calendar.settingsGet", {}));
	routes.put("/settings", async (c) =>
		callOp(resolveStore, c.req.raw, "calendar.settingsPut", await body(c.req.raw), INVALID_SETTINGS),
	);
	routes.get("/layout", async (c) => callOp(resolveStore, c.req.raw, "calendar.layoutGet", {}));
	routes.put("/layout", async (c) =>
		callOp(resolveStore, c.req.raw, "calendar.layoutPut", await body(c.req.raw), INVALID_LEVELS),
	);
	routes.post("/layout/undo", async (c) =>
		callOp(resolveStore, c.req.raw, "calendar.layoutUndo", await optionalBody(c.req.raw), INVALID_UNDO),
	);
	routes.post("/layout/preview", async (c) =>
		callOp(resolveStore, c.req.raw, "calendar.layoutPreview", await body(c.req.raw), INVALID_LEVELS),
	);
	routes.get("/dots", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"calendar.dots",
			{
				from: c.req.query("from"),
				to: c.req.query("to"),
			},
		),
	);
	routes.post("/day/:dateId/ensure", async (c) =>
		callOp(
			resolveStore,
			c.req.raw,
			"calendar.ensure",
			{
				dateId: c.req.param("dateId"),
				level: c.req.query("level"),
				createChild: c.req.query("createChild"),
			},
		),
	);
	return routes;
}
