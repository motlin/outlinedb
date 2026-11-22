import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {probeStore, readJson, startHarness} from "./harness";
import type {Harness, SchemaRow} from "./harness";

const migrationsFolder = new URL("../../shared/src/db/migrations", import.meta.url).pathname;

describe("user store Durable Object behind the Worker", () =>
{
	let harness: Harness;

	beforeAll(async () =>
	{
		harness = await startHarness("./probe-entry.ts", "ProbeStore");
	}, 60_000);

	afterAll(async () =>
	{
		await harness.dispose();
	});

	it("applies every migration in a fresh Durable Object", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/health");
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toStrictEqual(
			{
				status: "ok",
			},
		);

		// The probe path is not routed by the Worker, so reach the DO directly.
		const {names, migrations} = await probeStore(harness.mf);
		expect(migrations).toBe(13);
		const wanted = [
			"account",
			"calendar_layout_applies",
			"expanded_nodes",
			"node_content",
			"node_display_metadata",
			"node_fts",
			"tree_transactions",
		];
		expect(names.filter((name) => wanted.includes(name))).toStrictEqual(wanted);
	});

	it("matches the sqlite_master of the Node migration chain", async () =>
	{
		const {schema} = await probeStore(harness.mf);
		const normalize = (rows: SchemaRow[]) =>
			rows
				.filter((row) => !row.name.startsWith("_cf_") && !row.name.startsWith("sqlite_"))
				.filter((row) => row.name !== "__drizzle_migrations")
				// DO-only tables (the sync job's bookkeeping, the Workflowy connection), created outside the shared schema.
				.filter((row) => !isDurableObjectOnly(row.name))
				.map((row) => (
				{
					type: row.type,
					name: row.name,
					sql: row.sql.replaceAll(/\s+/gu, " "),
				}));

		const node = new Database(":memory:");
		migrate(
			drizzle(node),
			{
				migrationsFolder,
			},
		);
		const nodeSchema = node
			.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
			.all() as SchemaRow[];
		node.close();

		expect(normalize(schema)).toStrictEqual(normalize(nodeSchema));
	});

	it("creates the DO-only tables temporal, each with a live unique index and a closed-at index", async () =>
	{
		const {schema} = await probeStore(harness.mf);
		const syncRows = schema.filter((row) => isDurableObjectOnly(row.name));
		const tables = syncRows.filter((row) => row.type === "table");
		const shape = Object.fromEntries(
			tables.map((table) => [
				table.name,
				{
					temporal: /system_from INTEGER NOT NULL.*system_to INTEGER NOT NULL/su.test(table.sql),
					indexes: syncRows
						.filter((row) => row.type === "index" && row.sql.includes(`ON ${table.name} `))
						.map((row) => row.name),
				},
			]),
		);
		expect(shape).toStrictEqual(
			{
				sync_export_requests:
				{
					temporal: true,
					indexes: ["sync_export_requests_closed_at_idx", "sync_export_requests_system_to_idx"],
				},
				sync_runs:
				{
					temporal: true,
					indexes: ["sync_runs_closed_at_idx", "sync_runs_system_to_idx"],
				},
				sync_seed_requests:
				{
					temporal: true,
					indexes: ["sync_seed_requests_closed_at_idx", "sync_seed_requests_system_to_idx"],
				},
				workflowy_connection:
				{
					temporal: true,
					indexes: ["workflowy_connection_closed_at_idx", "workflowy_connection_system_to_idx"],
				},
			},
		);
	});

	it("serves an empty outline root on a fresh database", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes");
		expect(response.status).toBe(200);
		await expect(readJson(response)).resolves.toStrictEqual(
			{
				nodes: [],
			},
		);
	});

	it("stores an uploaded attachment in R2 under the object's prefix and serves the bytes back", async () =>
	{
		const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 9, 8, 7]);
		const created = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/files?parentId=home&name=clip.gif",
			{
				method: "POST",
				headers:
				{
					"content-type": "image/gif",
				},
				body: bytes,
			},
		);
		const {id} = (await readJson(created)) as
		{
			id: string;
		};
		const read = await harness.mf.dispatchFetch(`http://localhost/api/v1/files/${id}/original`);
		const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its bucket with undici classes
		const bucket = (await harness.mf.getR2Bucket("FILES")) as unknown as R2Bucket;
		const keys = (await bucket.list()).objects.map(({key}) => key.split("/").slice(1).join("/"));

		expect(
			{
				created: created.status,
				read:
				{
					status: read.status,
					type: read.headers.get("content-type"),
					bytes: [...new Uint8Array(await read.arrayBuffer())],
				},
				keys,
			},
		).toStrictEqual(
			{
				created: 201,
				read:
				{
					status: 200,
					type: "image/gif",
					bytes: [...bytes],
				},
				keys: [`blobs/${digest.slice(0, 2)}/${digest}`],
			},
		);
	});

	it("keeps node_tags in step with a write, so tag autocomplete drops a removed tag", async () =>
	{
		const tags = async () =>
		{
			const response = await harness.mf.dispatchFetch(
				"http://localhost/api/v1/tags/autocomplete?prefix=%23doTag",
			);
			return readJson(response);
		};
		await probeStore(harness.mf, `/__seed?name=${encodeURIComponent("seeded #doTag")}`);
		const tagged = await tags();
		await probeStore(harness.mf, "/__seed?name=seeded");

		expect(
			{
				tagged,
				untagged: await tags(),
			},
		).toStrictEqual(
			{
				tagged:
				{
					tags: [
						{
							tag: "#doTag",
							count: 1,
						},
					],
				},
				untagged:
				{
					tags: [],
				},
			},
		);
	});

	it("serves an expanded row's whole expanded subtree in one view request", async () =>
	{
		// a-subtree > {b-subtree > c-subtree > d-subtree, e-subtree > f-subtree}, with b and c expanded but not e. Upstream
		// keys expansion by an id's first 8 characters, so each id starts with its own letter.
		const tree = [
			["a-subtree", null, 200],
			["b-subtree", "a-subtree", 0],
			["e-subtree", "a-subtree", 1],
			["c-subtree", "b-subtree", 0],
			["d-subtree", "c-subtree", 0],
			["f-subtree", "e-subtree", 0],
		] as const;
		for (const [id, parent, priority] of tree)
		{
			const params = new URLSearchParams(
				{
					id,
					name: id,
					priority: String(priority),
					...(parent
						?
							{
								parent,
							}
						: {}),
				},
			);
			await probeStore(harness.mf, `/__seed?${params}`);
		}

		const saved = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/expansion",
			{
				method: "PATCH",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						changes:
						{
							"b-subtree": true,
							"c-subtree": true,
						},
					},
				),
			},
		);
		expect(saved.status).toBe(204);

		const response = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/nodes/view",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						rootId: "a-subtree",
						limit: 100,
						showCompleted: false,
					},
				),
			},
		);
		const body = (await readJson(response)) as
		{
			lists:
			{
				parentId: string;
				nodes:
				{
					id: string;
				}[];
				backlinks: unknown;
			}[];
		};

		expect(
			{
				status: response.status,
				lists: body.lists.map(({parentId, nodes, backlinks}) => [
					parentId,
					nodes.map((node) => node.id),
					backlinks,
				]),
			},
		).toStrictEqual(
			{
				status: 200,
				lists: [
					[
						"a-subtree",
						["b-subtree", "e-subtree"],
						{
							rootId: null,
							items: [],
						},
					],
					[
						"b-subtree",
						["c-subtree"],
						{
							rootId: null,
							items: [],
						},
					],
					[
						"c-subtree",
						["d-subtree"],
						{
							rootId: null,
							items: [],
						},
					],
				],
			},
		);
	});

	it("serves the SPA index.html for a client route", async () =>
	{
		const response = await harness.mf.dispatchFetch(
			"http://localhost/some/client/route",
			{
				headers:
				{
					"sec-fetch-mode": "navigate",
					accept: "text/html",
				},
			},
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toContain('<div id="root"');
	});
});

describe("user store restart", () =>
{
	it("does not re-run migrations when the Durable Object restarts", async () =>
	{
		const probe = async (h: Harness) => probeStore(h.mf);
		const first = await startHarness("./probe-entry.ts", "ProbeStore");
		const persistDir = first.persistDir;
		try
		{
			await expect(probe(first)).resolves.toMatchObject(
				{
					migrations: 13,
					appliedOnBoot: 13,
				},
			);
			await first.dispose(true);
			const second = await startHarness("./probe-entry.ts", "ProbeStore", persistDir);
			try
			{
				await expect(probe(second)).resolves.toMatchObject(
					{
						migrations: 13,
						appliedOnBoot: 0,
					},
				);
			}
			finally
			{
				await second.dispose();
			}
		}
		finally
		{
			rmSync(
				persistDir,
				{
					recursive: true,
					force: true,
				},
			);
		}
	}, 60_000);

	it("migrates a Durable Object holding text system times from before migration 0010", async () =>
	{
		const first = await startHarness("./probe-entry.ts", "ProbeStore");
		const persistDir = first.persistDir;
		try
		{
			await probeStore(first.mf);
			await first.dispose(true);
			const file = readdirSync(
				join(persistDir, "do"),
				{
					recursive: true,
				},
			).find((name) => typeof name === "string" && name.endsWith(".sqlite"));
			if (file === undefined)
			{
				throw new Error("no Durable Object database was persisted");
			}
			seedBeforeMicroseconds(join(persistDir, "do", String(file)));
			const second = await startHarness("./probe-entry.ts", "ProbeStore", persistDir);
			try
			{
				await expect(probeStore(second.mf)).resolves.toMatchObject(
					{
						migrations: 13,
						appliedOnBoot: 3,
					},
				);
			}
			finally
			{
				await second.dispose(true);
			}
			const migrated = new Database(
				join(persistDir, "do", String(file)),
				{
					readonly: true,
				},
			);
			const rows = migrated.prepare("SELECT user_id, system_from, system_to FROM account").all();
			migrated.close();
			expect(rows).toStrictEqual([
				{
					user_id: "1",
					system_from: 1_794_705_300_123_000,
					system_to: 9_007_199_254_740_991,
				},
			]);
		}
		finally
		{
			rmSync(
				persistDir,
				{
					recursive: true,
					force: true,
				},
			);
		}
	}, 60_000);
});

/**
 * Rewind a persisted Durable Object database to how production was before migration 0010: drop every table the
 * migrations made, keeping workerd's own `_cf_` tables, migrate through 0009, and add one account row with text times.
 */
function seedBeforeMicroseconds(path: string): void
{
	const folder = mkdtempSync(join(tmpdir(), "wf-mig-"));
	const seeded = new Database(path);
	try
	{
		const tables = () =>
			seeded
				.prepare(
					String.raw`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\_cf\_%' ESCAPE '\' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'`,
				)
				.all() as
			{
				name: string;
				sql: string;
			}[];
		for (const table of tables().filter((row) => row.sql.startsWith("CREATE VIRTUAL")))
		{
			seeded.exec(`DROP TABLE "${table.name}"`);
		}
		for (const table of tables())
		{
			seeded.exec(`DROP TABLE "${table.name}"`);
		}
		const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as
		{
			entries:
			{
				idx: number;
				tag: string;
			}[];
		};
		const entries = journal.entries.filter((entry) => entry.idx < 10);
		mkdirSync(join(folder, "meta"));
		writeFileSync(
			join(folder, "meta/_journal.json"),
			JSON.stringify(
				{
					...journal,
					entries,
				},
			),
		);
		for (const entry of entries)
		{
			copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
		}
		migrate(
			drizzle(seeded),
			{
				migrationsFolder: folder,
			},
		);
		seeded
			.prepare("INSERT INTO account (user_id, date_joined_sec, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run("1", 1_794_705_300, "2026-11-15 01:15:00.123", "9999-12-31 23:59:59");
	}
	finally
	{
		seeded.close();
		rmSync(
			folder,
			{
				recursive: true,
				force: true,
			},
		);
	}
}

/** Tables the Durable Object creates itself, outside the shared migration chain. */
function isDurableObjectOnly(name: string): boolean
{
	return name.startsWith("sync_") || name.startsWith("workflowy_connection");
}
