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
		expect(readWranglerConfig().vars).toStrictEqual({SYNC_INTERVAL_MINUTES: "30"});
	});

	it("binds Workers AI and the related-notes Vectorize index", () => {
		const {ai, vectorize} = readWranglerConfig();
		expect({ai, vectorize}).toStrictEqual({
			ai: {binding: "AI"},
			vectorize: [{binding: "RELATED_INDEX", index_name: "workflowy-related"}],
		});
	});
});
