import {defineConfig} from "vite-plus";

// Tests load @outlinedb/shared from its "source" export condition, as the dev server's --conditions=source does, so they never run against a stale gitignored dist build. Production builds keep the default conditions.
const sourceFirst = (conditions: string[]): string[] => ["source", ...conditions];

export default defineConfig(
	{
		resolve:
		{
			conditions: sourceFirst(["module", "browser", "development|production"]),
		},
		ssr:
		{
			resolve:
			{
				conditions: sourceFirst(["node", "module", "development|production"]),
			},
		},
		test:
		{
			globals: true,
			testTimeout: 60_000,
			// Trivial sync beforeEach hooks (mkdtemp + template DB copy) hit the 10s default when the machine is oversubscribed
			hookTimeout: 60_000,
			restoreMocks: true,
			// The JSON report keeps every run's per-file and per-test durations for the next test-speed pass; the test:run task's cache inputs exclude its directory.
			reporters: [
				"verbose",
				[
					"json",
					{
						outputFile: "node_modules/.vitest-cache/test-timings.json",
					},
				],
			],
			allowOnly: !process.env.CI,
			disableConsoleIntercept: true,
			// strictly-increasing-clock: a fake API answers in microseconds, so back-to-back units of work would share a millisecond and fail as a same-millisecond overwrite.
			// Files stay module-isolated, so every setup file is re-imported per test file: only the packages that run oclif commands or copy the migrated database pay for @oclif/core and the template.
			projects: [
				{
					extends: true,
					test:
					{
						name: "cli",
						include: ["packages/cli/test/**/*.test.ts", "packages/mcp/test/**/*.test.ts"],
						setupFiles: [
							"packages/shared/test/setup/strictly-increasing-clock.ts",
							"packages/cli/test/setup/oclif-root.ts",
						],
						globalSetup: ["packages/cli/test/setup/migrated-template.ts"],
					},
				},
				{
					extends: true,
					test:
					{
						name: "unit",
						include: ["packages/shared/test/**/*.test.ts", "scripts/**/*.test.mjs"],
						setupFiles: ["packages/shared/test/setup/strictly-increasing-clock.ts"],
					},
				},
				{
					extends: true,
					test:
					{
						name: "web",
						include: ["packages/web/test/**/*.test.{ts,tsx}"],
						// Parses every op's value against its output schema; production never does.
						setupFiles: [
							"packages/shared/test/setup/strictly-increasing-clock.ts",
							"packages/web/test/setup/check-op-outputs.ts",
						],
					},
				},
				{
					// Worker tests run the bundled Worker in Miniflare from plain Node vitest: @cloudflare/vitest-pool-workers requires vitest ^4.1 and the catalog is on 5.0.5.
					extends: true,
					test:
					{
						name: "cloudflare",
						include: ["packages/cloudflare/test/**/*.test.ts"],
						globalSetup: ["packages/cloudflare/test/setup/build-client.ts"],
					},
				},
			],
		},
	},
);
