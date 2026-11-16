import {defineConfig} from "vite-plus";

// Vitest run from packages/shared finds this file, not the repo root's vitest.config.ts, so it repeats what the root's "unit" project needs: without the strictly-increasing clock, back-to-back units of work share a timestamp and fail as same-microsecond overwrites.
export default defineConfig(
	{
		resolve:
		{
			conditions: ["source", "module", "browser", "development|production"],
		},
		ssr:
		{
			resolve:
			{
				conditions: ["source", "node", "module", "development|production"],
			},
		},
		test:
		{
			globals: true,
			testTimeout: 60_000,
			hookTimeout: 60_000,
			restoreMocks: true,
			include: ["test/**/*.test.ts"],
			setupFiles: ["test/setup/strictly-increasing-clock.ts"],
		},
	},
);
