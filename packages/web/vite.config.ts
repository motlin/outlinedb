import react from "@vitejs/plugin-react";
import {readFileSync} from "node:fs";
import {z} from "zod";
import {defineConfig} from "vite-plus";
import {resolvePort} from "./src/server/port.js";

process.title = "outlinedb-web-dev";

const PackageSchema = z.object(
	{
		version: z.string(),
	},
);
const {version} = PackageSchema.parse(JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")));

export default defineConfig(
	{
		root: "src/client",
		define:
		{
			"import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
		},
		server:
		{
			port: 5175,
			strictPort: true,
			host: "127.0.0.1",
			allowedHosts: [
				"workflowy.m4.notlin.com",
				...(process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? []),
			],
			proxy:
			{
				// ws so the ladder's write stream survives the dev proxy. The port
				// follows the API server's own PORT, so both can move together.
				"/api":
				{
					target: `http://127.0.0.1:${resolvePort(process.env)}`,
					ws: true,
				},
			},
		},
		build:
		{
			outDir: "../../dist/client",
			// outDir sits outside root (src/client), so Vite will not clear it unless told to.
			emptyOutDir: true,
			rolldownOptions:
			{
				output:
				{
					// Keep third-party code out of the app chunk so neither crosses the 500 kB warning limit.
					codeSplitting:
					{
						groups: [
							{
								name: "react",
								test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/u,
							},
							{
								name: "vendor",
								test: /node_modules/u,
							},
						],
					},
				},
			},
		},
		plugins: [
			react(),
			{
				// Dev only, ahead of main.tsx: a page whose module graph failed to link mid-checkout reloads itself.
				name: "stale-module-reload",
				apply: "serve",
				transformIndexHtml: () => [
					{
						tag: "script",
						attrs:
						{
							type: "module",
							src: "/dev-reload.ts",
						},
						injectTo: "head-prepend",
					},
				],
			},
		],
	},
);
