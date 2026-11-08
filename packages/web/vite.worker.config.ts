import {cloudflare} from "@cloudflare/vite-plugin";
import {fileURLToPath} from "node:url";
import {defineConfig, mergeConfig} from "vite-plus";
import baseConfig from "./vite.config.js";

// Worker dev and build: the SPA, the Worker, the Durable Object and R2 run in local workerd on one port.
// Local-only vars come from the environment (ACCESS_DEV_IDENTITY, WORKFLOWY_API_URL, WORKFLOWY_API_KEY,
// WORKFLOWY_ENV_OWNERS), or from packages/cloudflare/.dev.vars, which the plugin also reads. Nothing here deploys.
// WORKFLOWY_ENV_OWNERS defaults to "dev", the Durable Object the dev identity reaches, so it gets the Workflowy secrets.
const devVars = {
	WORKFLOWY_ENV_OWNERS: "dev",
	...Object.fromEntries(
		["ACCESS_DEV_IDENTITY", "WORKFLOWY_API_URL", "WORKFLOWY_API_KEY", "WORKFLOWY_ENV_OWNERS"].flatMap((name) => {
			const value = process.env[name];
			return value ? [[name, value]] : [];
		}),
	),
};

// The base config sets root to src/client, so the plugin would resolve relative paths there.
const cloudflareDir = fileURLToPath(new URL("../cloudflare/", import.meta.url));

export default defineConfig(({command}) =>
	mergeConfig(baseConfig, {
		// The Worker owns /api, so the Node API proxy of the base config does not apply.
		server: {proxy: {}},
		// Kept apart from dist/client, which the Node host and the plain build own: the plugin nests worker/ and client/ under this.
		build: {outDir: "../../dist/workflowy"},
		// Workspace packages (@workflowy/mcp, web, shared) resolve from source, so the Worker never builds against a missing or stale dist.
		environments: {worker: {resolve: {conditions: ["source"]}}},
		plugins: [
			cloudflare({
				configPath: `${cloudflareDir}wrangler.jsonc`,
				viteEnvironment: {name: "worker"},
				persistState: {path: process.env.WORKER_PERSIST_DIR ?? `${cloudflareDir}.wrangler/state`},
				// Dev only: vars set here are written into the built wrangler.json, so a build must never carry the local secrets.
				config: command === "serve" ? {vars: devVars} : {},
			}),
		],
	}),
);
