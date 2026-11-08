import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readdirSync, rmSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {probeStore, readJson, startHarness} from "./harness";
import type {Harness} from "./harness";

async function seedNode(mf: Harness["mf"]): Promise<void> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	await ns.get(ns.idFromName("dev")).fetch("http://localhost/__seed");
}

describe("a Durable Object with no secrets", () => {
	let harness: Harness;
	beforeAll(async () => {
		harness = await startHarness("./probe-entry.ts", "ProbeStore");
	}, 60_000);
	afterAll(async () => {
		await harness.dispose();
	});

	it("answers 503 on internal-API routes", async () => {
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/account");
		expect(response.status).toBe(503);
		await expect(readJson(response)).resolves.toStrictEqual({
			error: "Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')",
		});
	});

	it("refuses a node update because no API key is configured", async () => {
		await seedNode(harness.mf);
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes/seed-node", {
			method: "PATCH",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({name: "changed"}),
		});
		expect(response.status).toBe(500);
		await expect(readJson(response)).resolves.toStrictEqual({
			error: "WORKFLOWY_API_KEY environment variable is required",
		});
	});
});

describe("write-through against a fake upstream", () => {
	let harness: Harness;
	const calls: {method: string; path: string; auth: string | null}[] = [];
	beforeAll(async () => {
		harness = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			undefined,
			{
				ACCESS_DEV_IDENTITY: "dev",
				WORKFLOWY_ENV_OWNERS: "dev",
				WORKFLOWY_API_KEY: "fake-key-value",
				WORKFLOWY_API_URL: "http://upstream.test",
			},
			{
				outboundService: (request: Request): Response => {
					const url = new URL(request.url);
					calls.push({
						method: request.method,
						path: url.pathname,
						auth: request.headers.get("authorization"),
					});
					if (request.method === "POST") {
						return Response.json({status: "ok"});
					}
					return Response.json({
						node: {
							id: "seed-node",
							name: "changed upstream",
							note: null,
							parent_id: null,
							priority: 100,
							createdAt: 1,
							modifiedAt: 2,
						},
					});
				},
			},
		);
	}, 60_000);
	afterAll(async () => {
		await harness.dispose();
	});

	it("updates upstream first and then the Durable Object row", async () => {
		await seedNode(harness.mf);
		const response = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes/seed-node", {
			method: "PATCH",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({name: "changed"}),
		});
		expect(response.status).toBe(200);
		expect(calls).toStrictEqual([
			{method: "POST", path: "/api/v1/nodes/seed-node", auth: "Bearer fake-key-value"},
			{method: "GET", path: "/api/v1/nodes/seed-node", auth: "Bearer fake-key-value"},
		]);
		const read = await harness.mf.dispatchFetch("http://localhost/api/v1/nodes/seed-node");
		await expect(readJson(read)).resolves.toMatchObject({node: {name: "changed upstream"}});
	});
});

describe("a rotated session cookie", () => {
	it("persists across Durable Object restarts", async () => {
		const first = await startHarness("./probe-entry.ts", "ProbeStore", undefined, {
			ACCESS_DEV_IDENTITY: "dev",
			WORKFLOWY_ENV_OWNERS: "dev",
			WORKFLOWY_SESSION_COOKIE: "sessionid=seed",
		});
		try {
			await expect(probeStore(first.mf, "/__session")).resolves.toStrictEqual({cookie: "sessionid=seed"});
			await expect(probeStore(first.mf, "/__session?write=sessionid=rotated")).resolves.toStrictEqual({
				cookie: "sessionid=rotated",
			});
			await first.dispose(true);
			const second = await startHarness("./probe-entry.ts", "ProbeStore", first.persistDir, {
				ACCESS_DEV_IDENTITY: "dev",
				WORKFLOWY_ENV_OWNERS: "dev",
				WORKFLOWY_SESSION_COOKIE: "sessionid=seed",
			});
			try {
				await expect(probeStore(second.mf, "/__session")).resolves.toStrictEqual({cookie: "sessionid=rotated"});
			} finally {
				await second.dispose();
			}
		} finally {
			rmSync(first.persistDir, {recursive: true, force: true});
		}
	}, 120_000);
});

describe("secret scan", () => {
	it("keeps real secret values out of packages/cloudflare", () => {
		const root = new URL("..", import.meta.url).pathname;
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				if (entry === "node_modules" || entry === ".wrangler" || entry === "secrets.test.ts") {
					continue;
				}
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					walk(full);
					continue;
				}
				if (entry === ".dev.vars.example") {
					continue;
				}
				const text = readFileSync(full, "utf8");
				if (/WORKFLOWY_(API_KEY|PASSWORD|SESSION_COOKIE)=["']?[A-Za-z0-9]/u.test(text)) {
					offenders.push(full);
				}
			}
		};
		walk(root);
		expect(offenders).toStrictEqual([]);
	});

	it("lists names without values in .dev.vars.example", () => {
		const text = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
		const values = text
			.split("\n")
			.filter((line) => line.includes("=") && !line.startsWith("#"))
			.map((line) => line.slice(line.indexOf("=") + 1).trim());
		expect(values.filter((value) => value !== "")).toStrictEqual([]);
	});
});
