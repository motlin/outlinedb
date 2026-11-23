import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";

async function seedNode(mf: Harness["mf"]): Promise<void>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	await ns.get(ns.idFromName("dev")).fetch("http://localhost/__seed");
}

describe("a Durable Object with no secrets", () =>
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

	it("answers 503 on internal-API routes", async () =>
	{
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/account");
		expect(response.status).toBe(503);
		await expect(readJson(response)).resolves.toStrictEqual(
			{
				error: "Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')",
			},
		);
	});

	it("answers 503 on a Workflowy connect without OUTLINEDB_CREDENTIALS_KEY", async () =>
	{
		const response = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/workflowy-connection",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						email: "alice@example.com",
						password: "hunter2",
					},
				),
			},
		);
		expect(
			{
				status: response.status,
				body: await readJson(response),
			},
		).toStrictEqual(
			{
				status: 503,
				body:
				{
					ok: false,
					status: 503,
					error: "credentials-key-not-configured",
				},
			},
		);
	});

	it("updates a node locally because it is standalone", async () =>
	{
		await seedNode(harness.mf);
		const response = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/nodes/seed-node",
			{
				method: "PATCH",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						name: "changed",
					},
				),
			},
		);
		expect(response.status).toBe(200);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the edit time is the store's clock
		const body = (await readJson(response)) as
		{
			node:
			{
				modifiedAt: number;
			};
		};
		const node =
		{
			id: "seed-node",
			parent_id: null,
			name: "changed",
			note: null,
			priority: 0,
			data:
			{
				layoutMode: null,
			},
			numberedStart: null,
			createdAt: 1,
			modifiedAt: body.node.modifiedAt,
			completedAt: null,
			hasChildren: false,
			hasUncompletedChildren: false,
			isMirror: false,
			hasMirrors: false,
			originalNodeId: null,
			attachment: null,
			defaultToBottom: false,
			calendar: null,
			table: null,
		};
		expect(body).toStrictEqual(
			{
				node,
				effects:
				{
					backlinkTargets: [],
					dates: false,
				},
			},
		);
		const readBack = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes/seed-node");
		await expect(readJson(readBack)).resolves.toStrictEqual(
			{
				node,
			},
		);
	});
});

describe("secret scan", () =>
{
	it("keeps real secret values out of packages/cloudflare", () =>
	{
		const root = new URL("..", import.meta.url).pathname;
		const offenders: string[] = [];
		const walk = (dir: string): void =>
		{
			for (const entry of readdirSync(dir))
			{
				if (entry === "node_modules" || entry === ".wrangler" || entry === "secrets.test.ts")
				{
					continue;
				}
				const full = join(dir, entry);
				if (statSync(full).isDirectory())
				{
					walk(full);
					continue;
				}
				if (entry === ".dev.vars.example")
				{
					continue;
				}
				const text = readFileSync(full, "utf8");
				if (/WORKFLOWY_(API_KEY|PASSWORD|SESSION_COOKIE)=["']?[A-Za-z0-9]/u.test(text))
				{
					offenders.push(full);
				}
			}
		};
		walk(root);
		expect(offenders).toStrictEqual([]);
	});

	it("lists names without values in .dev.vars.example", () =>
	{
		const text = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
		const values = text
			.split("\n")
			.filter((line) => line.includes("=") && !line.startsWith("#"))
			.map((line) => line.slice(line.indexOf("=") + 1).trim());
		expect(values.filter((value) => value !== "")).toStrictEqual([]);
	});
});
