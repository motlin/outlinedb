import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const ID = "11111111-2222-3333-4444-555555555555";

interface Seed {
	fileType?: string;
	gif?: boolean;
	deleted?: boolean;
	width?: number;
	height?: number;
}

function setup(options: {configured?: boolean; seed?: Seed | null} = {}) {
	const {configured = true, seed = {}} = options;
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	const node: WorkflowyNode = {
		id: ID,
		name: "",
		note: null,
		parent_id: null,
		priority: 0,
		createdAt: 1,
		modifiedAt: 2,
	};
	cacheService.insertNode(node, null);
	if (seed !== null) {
		sqlite
			.prepare(
				"INSERT INTO s3_files (node_id, file_name, file_type, object_folder, is_animated_gif, image_original_width, image_original_height, image_original_pixels, is_deleted, system_from, system_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				ID,
				"IMG.png",
				seed.fileType ?? "image/png",
				"folder-1",
				seed.gif ? 1 : 0,
				seed.width ?? 1440,
				seed.height ?? 1020,
				1,
				seed.deleted ? 1 : 0,
				"2026-01-01T00:00:00.000Z",
				FAR_FUTURE_DATE,
			);
	}
	const requested: string[] = [];
	const adapter = {
		fileOwnerId: async () => Promise.resolve(7),
		signedFileUrl: async (path: string) => {
			requested.push(path);
			return Promise.resolve(`https://s3.example/signed?n=${requested.length}`);
		},
	};
	const ctx = {
		db,
		cacheService,
		internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = httpAppFor(ctx);
	const get = async (path: string) => {
		const res = await app.fetch(new Request(`http://x/api/v1/files${path}`, {redirect: "manual"}));
		return {
			status: res.status,
			location: res.headers.get("location"),
			body: res.status === 302 ? null : await res.json(),
		};
	};
	return {get, requested};
}

describe("GET /api/v1/files/:nodeId", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("answers 503 files-unavailable without internal credentials", async () => {
		const {get} = setup({configured: false});

		await expect(get(`/${ID}/original`)).resolves.toStrictEqual({
			status: 503,
			location: null,
			body: {error: "files-unavailable"},
		});
	});

	it("answers 404 for an unknown node, a node without an attachment and a deleted attachment", async () => {
		const results = [
			await setup().get("/99999999-2222-3333-4444-555555555555/original"),
			await setup({seed: null}).get(`/${ID}/original`),
			await setup({seed: {deleted: true}}).get(`/${ID}/original`),
		].map(({status}) => status);

		expect(results).toStrictEqual([404, 404, 404]);
	});

	it("redirects a 600px preview of a 1440x1020 image to the 800x567 signed preview", async () => {
		const {get, requested} = setup();

		const res = await get(`/${ID}/preview?w=600`);

		expect({res, requested}).toStrictEqual({
			res: {status: 302, location: "https://s3.example/signed?n=1", body: null},
			requested: [`/file-proxy/signed-preview/7/${ID}/800x567/?attempt=1&folder=folder-1`],
		});
	});

	it("uses the original when the stepped size is at least as wide as the image", async () => {
		const {get, requested} = setup();

		await get(`/${ID}/preview?w=1500`);

		expect(requested).toStrictEqual([`/file-proxy/signed-original/7/${ID}/?attempt=1`]);
	});

	it("uses the original for an animated GIF", async () => {
		const {get, requested} = setup({seed: {fileType: "image/gif", gif: true}});

		await get(`/${ID}/preview?w=200`);

		expect(requested).toStrictEqual([`/file-proxy/signed-original/7/${ID}/?attempt=1`]);
	});

	it("redirects /original to the signed original", async () => {
		const {get, requested} = setup({seed: {fileType: "video/mp4"}});

		const res = await get(`/${ID}/original`);

		expect({status: res.status, requested}).toStrictEqual({
			status: 302,
			requested: [`/file-proxy/signed-original/7/${ID}/?attempt=1`],
		});
	});

	it("reuses a signed URL within ten minutes and fetches a fresh one after", async () => {
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(1000);
		const {get, requested} = setup();

		await get(`/${ID}/original`);
		vi.advanceTimersByTime(9 * 60_000);
		await get(`/${ID}/original`);
		vi.advanceTimersByTime(2 * 60_000);
		await get(`/${ID}/original`);

		expect(requested).toHaveLength(2);
	});
});
