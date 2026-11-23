import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {ServerContext} from "../src/server/context.js";
import {diskBlobStore} from "../src/server/blob-store-disk.js";
import {httpAppFor} from "./http-app-for.js";
import {migratedMemoryDatabase} from "../../shared/test/helpers/migrated-memory-database.js";

const ID = "11111111-2222-3333-4444-555555555555";

interface Seed
{
	fileType?: string;
	gif?: boolean;
	deleted?: boolean;
	width?: number;
	height?: number;
}

function setup(
	options:
	{
		configured?: boolean;
		seed?: Seed | null;
	} = {},
)
{
	const {configured = true, seed = {}} = options;
	const sqlite = migratedMemoryDatabase();
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	const cacheService = new CacheService(db);
	const node: WorkflowyNode =
	{
		id: ID,
		name: "",
		note: null,
		parent_id: null,
		priority: 0,
		createdAt: 1,
		modifiedAt: 2,
	};
	cacheService.insertNode(node, null);
	if (seed !== null)
	{
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
	const adapter =
	{
		fileOwnerId: async () => Promise.resolve(7),
		signedFileUrl: async (path: string) =>
		{
			requested.push(path);
			return Promise.resolve(`https://s3.example/signed?n=${requested.length}`);
		},
	};
	const ctx =
	{
		db,
		cacheService,
		internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = httpAppFor(ctx);
	const get = async (path: string) =>
	{
		const res = await app.fetch(
			new Request(
				`http://x/api/v1/files${path}`,
				{
					redirect: "manual",
				},
			),
		);
		return {
			status: res.status,
			location: res.headers.get("location"),
			body: res.status === 302 ? null : await res.json(),
		};
	};
	return {
		get,
		requested,
	};
}

describe("GET /api/v1/files/:nodeId", () =>
{
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("answers 503 files-unavailable without internal credentials", async () =>
	{
		const {get} = setup(
			{
				configured: false,
			},
		);

		await expect(get(`/${ID}/original`)).resolves.toStrictEqual(
			{
				status: 503,
				location: null,
				body:
				{
					error: "files-unavailable",
				},
			},
		);
	});

	it("answers 404 for an unknown node, a node without an attachment and a deleted attachment", async () =>
	{
		const results = [
			await setup().get("/99999999-2222-3333-4444-555555555555/original"),
			await setup(
				{
					seed: null,
				},
			).get(`/${ID}/original`),
			await setup(
				{
					seed:
					{
						deleted: true,
					},
				},
			).get(`/${ID}/original`),
		].map(({status}) => status);

		expect(results).toStrictEqual([404, 404, 404]);
	});

	it("redirects a 600px preview of a 1440x1020 image to the 800x567 signed preview", async () =>
	{
		const {get, requested} = setup();

		const res = await get(`/${ID}/preview?w=600`);

		expect(
			{
				res,
				requested,
			},
		).toStrictEqual(
			{
				res:
				{
					status: 302,
					location: "https://s3.example/signed?n=1",
					body: null,
				},
				requested: [`/file-proxy/signed-preview/7/${ID}/800x567/?attempt=1&folder=folder-1`],
			},
		);
	});

	it("uses the original when the stepped size is at least as wide as the image", async () =>
	{
		const {get, requested} = setup();

		await get(`/${ID}/preview?w=1500`);

		expect(requested).toStrictEqual([`/file-proxy/signed-original/7/${ID}/?attempt=1`]);
	});

	it("uses the original for an animated GIF", async () =>
	{
		const {get, requested} = setup(
			{
				seed:
				{
					fileType: "image/gif",
					gif: true,
				},
			},
		);

		await get(`/${ID}/preview?w=200`);

		expect(requested).toStrictEqual([`/file-proxy/signed-original/7/${ID}/?attempt=1`]);
	});

	it("redirects /original to the signed original", async () =>
	{
		const {get, requested} = setup(
			{
				seed:
				{
					fileType: "video/mp4",
				},
			},
		);

		const res = await get(`/${ID}/original`);

		expect(
			{
				status: res.status,
				requested,
			},
		).toStrictEqual(
			{
				status: 302,
				requested: [`/file-proxy/signed-original/7/${ID}/?attempt=1`],
			},
		);
	});

	it("reuses a signed URL within ten minutes and fetches a fresh one after", async () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
			},
		);
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

describe("POST /api/v1/files then GET /api/v1/files/:nodeId", () =>
{
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	const SHA = "d9b2f0b8c7b4fa1e0b7d6a6b6bbd7b1b8d8b9d0c2c7b2c1df8a3cc1b9c6c8f1e";
	let storeDir: string | undefined;

	afterEach(() =>
	{
		if (storeDir !== undefined)
		{
			rmSync(
				storeDir,
				{
					recursive: true,
					force: true,
				},
			);
			storeDir = undefined;
		}
	});

	function standalone(mode: "standalone" | "mirror" = "standalone")
	{
		const sqlite = migratedMemoryDatabase();
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		storeDir = mkdtempSync(join(tmpdir(), "outlinedb-files-"));
		const ctx =
		{
			db,
			cacheService: new CacheService(db),
			mode,
			blobs: diskBlobStore(storeDir),
			internalAdapter: () =>
			{
			},
		} as unknown as ServerContext;
		return {
			sqlite,
			app: httpAppFor(ctx),
			dir: storeDir,
		};
	}

	it("stores the bytes on disk, records s3_files and file_blobs for a new attachment node, and serves the bytes back", async () =>
	{
		const {sqlite, app, dir} = standalone();

		const created = await app.fetch(
			new Request(
				"http://x/api/v1/files?parentId=home&name=photo.png&width=640&height=480",
				{
					method: "POST",
					headers:
					{
						"content-type": "image/png",
					},
					body: PNG,
				},
			),
		);
		const {id} = (await created.json()) as
		{
			id: string;
		};
		const read = await app.fetch(new Request(`http://x/api/v1/files/${id}/original`));
		const preview = await app.fetch(new Request(`http://x/api/v1/files/${id}/preview?w=200`));
		const sha = createHash("sha256").update(PNG).digest("hex");
		// An uploaded page is served on the app's origin, so it must not run as the app.
		const page = (await (
			await app.fetch(
				new Request(
					"http://x/api/v1/files?parentId=home&name=page.html",
					{
						method: "POST",
						headers:
						{
							"content-type": "text/html",
						},
						body: "<script>fetch('/api/v1/nodes')</script>",
					},
				),
			)
		).json()) as
		{
			id: string;
		};
		const pageRead = await app.fetch(new Request(`http://x/api/v1/files/${page.id}/original`));

		expect(
			{
				created: created.status,
				read:
				{
					status: read.status,
					type: read.headers.get("content-type"),
					nosniff: read.headers.get("x-content-type-options"),
					csp: read.headers.get("content-security-policy"),
					bytes: [...new Uint8Array(await read.arrayBuffer())],
				},
				page:
				{
					type: pageRead.headers.get("content-type"),
					nosniff: pageRead.headers.get("x-content-type-options"),
					csp: pageRead.headers.get("content-security-policy"),
				},
				preview:
				{
					status: preview.status,
					bytes: [...new Uint8Array(await preview.arrayBuffer())],
				},
				onDisk: [...readFileSync(join(dir, "blobs", sha.slice(0, 2), sha))],
				node: sqlite
					.prepare("SELECT name, parent_id AS parentId FROM node_content WHERE id = ? AND system_to = ?")
					.all(id, FAR_FUTURE_DATE),
				s3Files: sqlite
					.prepare(
						"SELECT file_name AS fileName, file_type AS fileType, image_original_width AS width, image_original_height AS height, is_deleted AS isDeleted FROM s3_files WHERE node_id = ? AND system_to = ?",
					)
					.all(id, FAR_FUTURE_DATE),
				fileBlobs: sqlite
					.prepare(
						"SELECT status, sha256, size, content_type AS contentType, local_path AS localPath, error FROM file_blobs WHERE node_id = ? AND system_to = ?",
					)
					.all(id, FAR_FUTURE_DATE),
			},
		).toStrictEqual(
			{
				created: 201,
				read:
				{
					status: 200,
					type: "image/png",
					nosniff: "nosniff",
					csp: null,
					bytes: [...PNG],
				},
				page:
				{
					type: "text/html",
					nosniff: "nosniff",
					csp: "sandbox",
				},
				preview:
				{
					status: 200,
					bytes: [...PNG],
				},
				onDisk: [...PNG],
				node: [
					{
						name: "",
						parentId: null,
					},
				],
				s3Files: [
					{
						fileName: "photo.png",
						fileType: "image/png",
						width: 640,
						height: 480,
						isDeleted: 0,
					},
				],
				fileBlobs: [
					{
						status: "ok",
						sha256: sha,
						size: PNG.length,
						contentType: "image/png",
						localPath: `blobs/${sha.slice(0, 2)}/${sha}`,
						error: null,
					},
				],
			},
		);
	});

	it("answers 503 for an upload in mirror mode, which would need workflowy.com's S3", async () =>
	{
		const {app} = standalone("mirror");

		const res = await app.fetch(
			new Request(
				"http://x/api/v1/files?parentId=home&name=a.txt",
				{
					method: "POST",
					headers:
					{
						"content-type": "text/plain",
					},
					body: "hi",
				},
			),
		);

		expect(
			{
				status: res.status,
				body: await res.json(),
			},
		).toStrictEqual(
			{
				status: 503,
				body:
				{
					error: "upload-unavailable",
				},
			},
		);
	});

	it("serves a mirrored blob from the store before asking workflowy.com", async () =>
	{
		const {sqlite, app, dir} = standalone("mirror");
		const sha = SHA;
		mkdirSync(
			join(dir, "blobs", sha.slice(0, 2)),
			{
				recursive: true,
			},
		);
		writeFileSync(join(dir, "blobs", sha.slice(0, 2), sha), PNG);
		const insert = (table: string, columns: string, values: unknown[]) =>
			sqlite
				.prepare(
					`INSERT INTO ${table} (${columns}, system_from, system_to) VALUES (${values.map(() => "?").join(", ")}, ?, ?)`,
				)
				.run(...values, "2026-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		insert("s3_files", "node_id, file_name, file_type, is_deleted", [ID, "IMG.png", "image/png", 0]);
		insert("file_blobs", "node_id, status, sha256, size, content_type, local_path", [
			ID,
			"ok",
			sha,
			PNG.length,
			"image/png",
			`blobs/${sha.slice(0, 2)}/${sha}`,
		]);
		new CacheService(
			drizzle(
				sqlite,
				{
					schema,
				},
			),
		).insertNode(
			{
				id: ID,
				name: "",
				note: null,
				parent_id: null,
				priority: 0,
				createdAt: 1,
				modifiedAt: 2,
			},
			null,
		);

		const res = await app.fetch(new Request(`http://x/api/v1/files/${ID}/original`));

		expect(
			{
				status: res.status,
				bytes: [...new Uint8Array(await res.arrayBuffer())],
			},
		).toStrictEqual(
			{
				status: 200,
				bytes: [...PNG],
			},
		);
	});
});
