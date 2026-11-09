import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

function readWranglerConfig(): Record<string, unknown> {
	const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
	const json = text
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n")
		.replaceAll(/,(\s*[}\]])/gu, "$1");
	const parsed: Record<string, unknown> = JSON.parse(json);
	return parsed;
}

describe("wrangler.jsonc", () => {
	it("names the Worker outlinedb and its R2 snapshots bucket outlinedb-snapshots", () => {
		const {name, r2_buckets} = readWranglerConfig();
		expect({name, r2_buckets}).toStrictEqual({
			name: "outlinedb",
			r2_buckets: [{binding: "SNAPSHOTS", bucket_name: "outlinedb-snapshots"}],
		});
	});

	it("raises the CPU limit so the alarm-driven import is not cut off at 30 s", () => {
		expect(readWranglerConfig().limits).toStrictEqual({cpu_ms: 300_000});
	});

	it("serves only the Access-protected custom domain, with workers.dev and preview URLs off", () => {
		const {routes, workers_dev, preview_urls} = readWranglerConfig();
		expect({routes, workers_dev, preview_urls}).toStrictEqual({
			routes: [{pattern: "app.outlinedb.com", custom_domain: true}],
			workers_dev: false,
			preview_urls: false,
		});
	});

	it("keeps the Access config out of vars so dashboard secrets are not reset on deploy", () => {
		expect(readWranglerConfig().vars).toStrictEqual({
			SYNC_INTERVAL_MINUTES: "30",
			EMAIL_PROVIDER: "cloudflare",
			EMAIL_FROM: "no-reply@outlinedb.com",
			APP_ORIGIN: "https://app.outlinedb.com",
			SIGNUP_MODE: "closed",
		});
	});

	it("never ships the log email sender", () => {
		const vars = readWranglerConfig().vars as Record<string, unknown>;
		expect(vars.EMAIL_PROVIDER).not.toBe("log");
	});

	it("binds Cloudflare Email Service as EMAIL with no destination restriction", () => {
		expect(readWranglerConfig().send_email).toStrictEqual([{name: "EMAIL"}]);
	});

	it("binds Workers AI and the related-notes Vectorize index", () => {
		const {ai, vectorize} = readWranglerConfig();
		expect({ai, vectorize}).toStrictEqual({
			ai: {binding: "AI"},
			vectorize: [{binding: "RELATED_INDEX", index_name: "outlinedb-related"}],
		});
	});

	it("binds the outlinedb-auth D1 database as AUTH_DB with a real id and the migrations dir", () => {
		const databases = readWranglerConfig().d1_databases;
		expect(Array.isArray(databases)).toBe(true);
		const [database] = databases as Record<string, unknown>[];
		expect(database?.database_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
		expect(database?.database_id).not.toBe("00000000-0000-0000-0000-000000000000");
		expect(databases).toStrictEqual([
			{
				binding: "AUTH_DB",
				database_name: "outlinedb-auth",
				database_id: database?.database_id,
				migrations_dir: "migrations",
			},
		]);
	});
});

describe("push.yml deploy job", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/push.yml", import.meta.url), "utf8");
	const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));

	it("applies the remote AUTH_DB migrations from packages/cloudflare before deploying the Worker", () => {
		const migrate = deployJob.indexOf("wrangler d1 migrations apply AUTH_DB --remote");
		const deploy = deployJob.indexOf("wrangler deploy");
		expect({migrateFound: migrate !== -1, beforeDeploy: migrate < deploy}).toStrictEqual({
			migrateFound: true,
			beforeDeploy: true,
		});
		const step = deployJob.slice(deployJob.lastIndexOf("- name:", migrate), migrate);
		expect(step).toContain("working-directory: packages/cloudflare");
	});
});
