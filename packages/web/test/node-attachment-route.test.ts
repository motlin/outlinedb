import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(id: string): WorkflowyNode {
	return {id, name: "", note: null, parent_id: null, priority: 0, createdAt: 100, modifiedAt: 200};
}

function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("n1"), null);
	sqlite
		.prepare(
			"INSERT INTO s3_files (node_id, file_name, file_type, object_folder, is_animated_gif, image_original_width, image_original_height, image_original_pixels, is_deleted, system_from, system_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"n1",
			"IMG.png",
			"image/png",
			"folder-1",
			1,
			1440,
			1020,
			2.5,
			0,
			"2026-01-01T00:00:00.000Z",
			FAR_FUTURE_DATE,
		);
	const ctx = {db, cacheService} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	return app;
}

describe("GET /api/v1/nodes/:id attachment", () => {
	it("exposes the fractional pixel density and the animated GIF flag", async () => {
		const res = await setup().fetch(new Request("http://x/api/v1/nodes/n1"));
		const body = (await res.json()) as {node: {attachment: unknown}};

		expect(body.node.attachment).toStrictEqual({
			fileName: "IMG.png",
			fileType: "image/png",
			objectFolder: "folder-1",
			imageOriginalWidth: 1440,
			imageOriginalHeight: 1020,
			imageOriginalPixels: 2.5,
			isAnimatedGif: true,
			isDeleted: false,
		});
	});
});
