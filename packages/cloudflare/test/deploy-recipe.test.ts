import {describe, expect, it} from "vite-plus/test";
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";

const root = new URL("../../..", import.meta.url).pathname;

function runDeploy(confirm: string | undefined) {
	const env = {...process.env};
	delete env.CONFIRM_DEPLOY;
	if (confirm !== undefined) {
		env.CONFIRM_DEPLOY = confirm;
	}
	// Only the refusal path is ever exercised here: every value below must stop before wrangler runs.
	return spawnSync("just", ["--no-deps", "cf-deploy"], {cwd: root, env, encoding: "utf8"});
}

describe("just cf-deploy", () => {
	const refusal = "cf-deploy refused: set CONFIRM_DEPLOY=1 to deploy";

	it("refuses when CONFIRM_DEPLOY is unset", () => {
		const result = runDeploy(undefined);
		expect({status: result.status, stderr: result.stderr.split("\n")[0]}).toStrictEqual({
			status: 1,
			stderr: refusal,
		});
	});

	it("refuses when CONFIRM_DEPLOY is anything but 1", () => {
		const result = runDeploy("yes");
		expect({status: result.status, stderr: result.stderr.split("\n")[0]}).toStrictEqual({
			status: 1,
			stderr: refusal,
		});
	});

	it("is not reachable from verify, precommit or test", () => {
		const justfile = readFileSync(`${root}justfile`, "utf8");
		const verify = justfile.slice(justfile.indexOf("\nverify quick"), justfile.indexOf("# Deprecated alias"));
		expect(verify).not.toContain("cf-deploy");
		expect(verify).not.toContain("cf-smoke");
	});
});

describe("Worker dev through the Cloudflare Vite plugin", () => {
	const justfile = readFileSync(`${root}justfile`, "utf8");
	const recipe = (name: string) => {
		const start = justfile.indexOf(`\n${name}`);
		const end = justfile.indexOf("\n\n", start + 1);
		return justfile.slice(start, end);
	};

	it("runs dev as vp dev with the worker config, and keeps the Node host as dev-node", () => {
		expect(recipe("dev *args")).toContain("vp dev -c vite.worker.config.ts");
		expect(recipe("dev *args")).not.toContain("wrangler dev");
		expect(recipe("dev-node")).toContain("vp run --filter @outlinedb/web dev");
	});

	it("builds with cf-build and deploys the generated wrangler.json", () => {
		expect(recipe("cf-build")).toContain("vp build -c vite.worker.config.ts");
		expect(recipe("cf-deploy")).toContain("wrangler deploy -c");
		expect(recipe("cf-deploy")).toContain("dist/workflowy/worker/wrangler.json");
	});

	it("has a worker Vite config that uses the plugin against the Cloudflare wrangler.jsonc", () => {
		const path = `${root}packages/web/vite.worker.config.ts`;
		expect(existsSync(path)).toBe(true);
		const config = readFileSync(path, "utf8");
		expect(config).toContain("@cloudflare/vite-plugin");
		expect(config).toContain("wrangler.jsonc");
	});
});

describe("built wrangler.json", () => {
	it("declares none of the Access settings in vars, so secrets can hold them", () => {
		const build = spawnSync("just", ["--no-deps", "cf-build"], {cwd: root, encoding: "utf8"});
		expect(build.status, build.stderr).toBe(0);
		const built: {vars?: Record<string, string>} = JSON.parse(
			readFileSync(`${root}packages/web/dist/workflowy/worker/wrangler.json`, "utf8"),
		);
		const names = Object.keys(built.vars ?? {});
		expect(
			names.filter((name) =>
				[
					"ACCESS_TEAM_DOMAIN",
					"ACCESS_AUD",
					"ALLOWED_EMAILS",
					"ALLOWED_SERVICE_TOKENS",
					"WORKFLOWY_ENV_OWNERS",
				].includes(name),
			),
		).toStrictEqual([]);
	}, 240_000);
});

describe("deploy on push to main", () => {
	const workflow = readFileSync(`${root}.github/workflows/push.yml`, "utf8");
	const job = (name: string) => {
		const start = workflow.indexOf(`\n  ${name}:\n`);
		expect(start, `job ${name}`).toBeGreaterThan(-1);
		const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/u);
		return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
	};

	it("runs on push to main and never cancels a deploy in progress", () => {
		expect(workflow).toContain("on:\n  push:\n    branches:\n      - main\n");
		expect(workflow).toContain("cancel-in-progress: false");
	});

	it("tests before deploying", () => {
		expect(job("test")).toContain("- run: just test");
		expect(job("deploy")).toContain("needs: [test]");
	});

	it("deploys the generated wrangler.json the way cf-deploy does, with the Cloudflare secrets", () => {
		const deploy = job("deploy");
		expect(deploy).toContain("- run: just cf-build");
		expect(deploy).toContain("vp exec wrangler deploy -c dist/workflowy/worker/wrangler.json");
		expect(deploy).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
		expect(deploy).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
		expect(deploy).not.toContain("CONFIRM_DEPLOY");
	});
});
