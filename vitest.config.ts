import {globSync, readFileSync} from "node:fs";
import {defineConfig} from "vite-plus";
import {BaseSequencer} from "vite-plus/test/node";
import type {TestSpecification} from "vite-plus/test/node";

// Tests load @outlinedb/shared from its "source" export condition, as the dev server's --conditions=source does, so they never run against a stale gitignored dist build. Production builds keep the default conditions.
const sourceFirst = (conditions: string[]): string[] => ["source", ...conditions];

/**
 * Isolated projects first, longest files first as usual, then the shared-process projects: Miniflare and DOM files are
 * the long ones, and the shared projects' many short files then fill the tail. A shared worker is only reused while the
 * queue's next file belongs to its project, so each project's files stay together.
 */
class IsolatedFirstSequencer extends BaseSequencer
{
	override async sort(files: TestSpecification[]): Promise<TestSpecification[]>
	{
		// oxlint-disable-next-line unicorn/no-array-sort -- BaseSequencer#sort returns a new array
		const sorted = await super.sort(files);
		return [
			...sorted.filter((file) => file.project.config.isolate),
			...sorted.filter((file) => !file.project.config.isolate),
		];
	}
}

const webTests = globSync("packages/web/test/**/*.test.{ts,tsx}").map((file) => (
{
	file,
	source: readFileSync(file, "utf8"),
}));
// Web test files that ask for happy-dom.
const domTests = webTests.filter(({source}) => source.includes("@vitest-environment happy-dom")).map(({file}) => file);
// Files that count renders through a fake React DevTools hook, which React DOM only picks up when it first loads: each needs a process of its own.
const renderCountTests = webTests
	.filter(({source}) => source.includes("./helpers/render-counter.js"))
	.map(({file}) => file);

// Most files share a worker process and its loaded dependencies. Before each file, fresh-modules re-evaluates our own modules and drops stubs and fake timers, so stores, registries, mocks and the shared DOM window start clean.
const sharedProcess =
{
	isolate: false,
	setupFiles: [
		"packages/shared/test/setup/fresh-modules.ts",
		"packages/shared/test/setup/strictly-increasing-clock.ts",
	],
};

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
			sequence:
			{
				sequencer: IsolatedFirstSequencer,
			},
			disableConsoleIntercept: true,
			// strictly-increasing-clock: a fake API answers in microseconds, so back-to-back units of work would share a millisecond and fail as a same-millisecond overwrite.
			// Setup files are re-imported per test file: only the packages that run oclif commands or copy the migrated database pay for @oclif/core and the template.
			projects: [
				{
					extends: true,
					test:
					{
						name: "cli",
						include: ["packages/cli/test/**/*.test.ts", "packages/mcp/test/**/*.test.ts"],
						isolate: sharedProcess.isolate,
						setupFiles: [...sharedProcess.setupFiles, "packages/cli/test/setup/oclif-root.ts"],
						globalSetup: ["packages/cli/test/setup/migrated-template.ts"],
					},
				},
				{
					extends: true,
					test:
					{
						name: "unit",
						include: ["packages/shared/test/**/*.test.ts", "scripts/**/*.test.mjs"],
						...sharedProcess,
					},
				},
				{
					extends: true,
					test:
					{
						name: "web",
						include: ["packages/web/test/**/*.test.{ts,tsx}"],
						exclude: domTests,
						isolate: sharedProcess.isolate,
						// Parses every op's value against its output schema; production never does.
						setupFiles: [...sharedProcess.setupFiles, "packages/web/test/setup/check-op-outputs.ts"],
					},
				},
				{
					extends: true,
					test:
					{
						name: "web-dom",
						include: domTests,
						exclude: renderCountTests,
						isolate: sharedProcess.isolate,
						setupFiles: [...sharedProcess.setupFiles, "packages/web/test/setup/check-op-outputs.ts"],
					},
				},
				{
					extends: true,
					test:
					{
						name: "web-render-count",
						include: renderCountTests,
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
