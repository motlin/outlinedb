import {Hono} from "hono";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {callOp} from "../response.js";
import type {ResolveStore} from "../response.js";

/** A request body that is not valid JSON reads as undefined, so the op answers its own 400. */
async function body(request: Request): Promise<unknown> {
	return request.json().catch(() => {});
}

/**
 * The node routes (see `ops/nodes.ts`, `ops/nodes-tree.ts` and `ops/nodes-mirror.ts` for what each answers). Registration order matters: the fixed paths
 * (`/changes`, `/children`, `/verify`, `/view`, `/export-tree`) come before `/:id`.
 */
export function nodesRoutes(resolveStore: ResolveStore): Hono {
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "nodes.list", {parentId: c.req.query("parent_id")}));
	routes.post("/children", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.children", await body(c.req.raw), {
			error: "parentIds must be an array of strings",
		}),
	);
	routes.post("/verify", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.verify", await body(c.req.raw), {
			error: "body must be {ids, parentIds}",
		}),
	);
	routes.get("/changes", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.changes", {since: c.req.query("since")}),
	);
	routes.post("/view", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.view", await body(c.req.raw), {
			error: "body must be {rootId, expandedIds, limit, showCompleted}",
		}),
	);
	routes.post("/export-tree", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.exportTree", await body(c.req.raw), {
			error: "ids must be an array of strings",
		}),
	);
	routes.post("/trees", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.trees", await body(c.req.raw), {error: "Invalid request body"}),
	);
	routes.post("/duplicate", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.duplicate", await body(c.req.raw), {error: "Invalid request body"}),
	);
	routes.post("/move", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.move", await body(c.req.raw), {error: "Invalid request body"}),
	);
	routes.post("/:id/move", async (c) => {
		const raw = await body(c.req.raw);
		return callOp(
			resolveStore,
			c.req.raw,
			"nodes.moveOne",
			typeof raw === "object" && raw !== null ? {...raw, id: c.req.param("id")} : raw,
			{error: "Invalid request body"},
		);
	});
	routes.post("/mirror", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.mirror", await body(c.req.raw), {error: "Invalid request body"}),
	);
	routes.post("/:id/detach-mirror", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.detachMirror", {id: c.req.param("id")}),
	);
	routes.post("/:id/swap-mirror-origin", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.swapMirrorOrigin", {id: c.req.param("id")}),
	);
	routes.post("/", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.create", await body(c.req.raw), {error: "Invalid request body"}),
	);
	routes.on(["PATCH", "POST"], `/${HOME_TARGET}`, async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.setHome", await body(c.req.raw), {
			error: "Home accepts only layoutMode",
		}),
	);
	routes.on(["PATCH", "POST"], "/:id", async (c) => {
		const raw = await body(c.req.raw);
		return callOp(
			resolveStore,
			c.req.raw,
			"nodes.update",
			typeof raw === "object" && raw !== null ? {...raw, id: c.req.param("id")} : raw,
			{error: "Invalid request body"},
		);
	});
	routes.delete("/:id", async (c) => callOp(resolveStore, c.req.raw, "nodes.delete", {id: c.req.param("id")}));
	routes.post("/:id/complete", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.complete", {id: c.req.param("id")}),
	);
	routes.post("/:id/uncomplete", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.uncomplete", {id: c.req.param("id")}),
	);
	routes.post("/:id/restore", async (c) => {
		const raw = await body(c.req.raw);
		return callOp(
			resolveStore,
			c.req.raw,
			"nodes.restore",
			{...(typeof raw === "object" && raw !== null ? raw : {}), id: c.req.param("id")},
			{error: "Invalid request body"},
		);
	});
	routes.get("/:id", async (c) => callOp(resolveStore, c.req.raw, "nodes.get", {id: c.req.param("id")}));
	routes.get("/:id/subtree-ids", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.subtreeIds", {id: c.req.param("id")}),
	);
	routes.get("/:id/ancestors", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.ancestors", {id: c.req.param("id")}),
	);
	routes.get("/:id/backlinks", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.backlinks", {id: c.req.param("id")}),
	);
	routes.get("/:id/found-dates", async (c) =>
		callOp(resolveStore, c.req.raw, "nodes.foundDates", {id: c.req.param("id")}),
	);
	routes.get("/:id/mirrors", async (c) => callOp(resolveStore, c.req.raw, "nodes.mirrors", {id: c.req.param("id")}));
	return routes;
}

/** `GET /` answers Home's layout mode. */
export function homeRoutes(resolveStore: ResolveStore): Hono {
	const routes = new Hono();
	routes.get("/", async (c) => callOp(resolveStore, c.req.raw, "home.get", {}));
	return routes;
}
