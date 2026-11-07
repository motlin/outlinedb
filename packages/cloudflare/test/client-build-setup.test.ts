import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import config from "../../../vitest.config.js";

// Test files run in parallel workers, so a per-file "build the client if missing" check started several
// `vp build`s at once on a fresh CI checkout, and they raced emptying packages/web/dist/client (ENOTEMPTY).
describe("web client build for the Worker tests", () => {
	it("runs once in the cloudflare project's global setup", () => {
		const globalSetups = (config.test?.projects ?? []).flatMap((entry) =>
			typeof entry === "object" && "test" in entry && entry.test?.name === "cloudflare"
				? [entry.test.globalSetup]
				: [],
		);
		expect(globalSetups).toStrictEqual([["packages/cloudflare/test/setup/build-client.ts"]]);
	});

	it("never runs from the per-file harness", () => {
		const harness = readFileSync(new URL("harness.ts", import.meta.url), "utf8");
		expect(harness.includes("child_process")).toBe(false);
	});
});
