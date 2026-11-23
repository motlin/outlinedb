import {globSync, readFileSync} from "node:fs";
import {defineConfig} from "vite-plus";
import {BaseSequencer} from "vite-plus/test/node";
import type {TestSpecification} from "vite-plus/test/node";

// Tests load @outlinedb/shared from its "source" export condition, as the dev server's --conditions=source does, so they never run against a stale gitignored dist build. Production builds keep the default conditions.
const sourceFirst = (conditions: string[]): string[] => ["source", ...conditions];

/**
 * Isolated projects first, longest files first as usual, then the shared-process projects, the one with fewer files
 * first: the DOM project's files are few but long, so they start while the Node project's many short files are still
 * queued to fill the tail. A shared worker is only reused while the queue's next file belongs to its project, so each
 * project's files stay together.
 */
class IsolatedFirstSequencer extends BaseSequencer
{
	override async sort(files: TestSpecification[]): Promise<TestSpecification[]>
	{
		// oxlint-disable-next-line unicorn/no-array-sort -- BaseSequencer#sort returns a new array
		const sorted = await super.sort(files);
		const shared = new Map<string, TestSpecification[]>();
		for (const file of sorted.filter((spec) => !spec.project.config.isolate))
		{
			const project = shared.get(file.project.name) ?? [];
			project.push(file);
			shared.set(file.project.name, project);
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts the fresh array from the spread
		const projects = [...shared.values()].sort((a, b) => a.length - b.length);
		return [...sorted.filter((file) => file.project.config.isolate), ...projects.flat()];
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
			// Off unless --coverage (`just coverage`) turns it on; lcov feeds coverage tooling such as burn's coverage track.
			coverage:
			{
				provider: "v8",
				include: ["packages/*/src/**"],
				reporter: ["text-summary", "lcov"],
				reportsDirectory: "coverage",
			},
			sequence:
			{
				sequencer: IsolatedFirstSequencer,
			},
			disableConsoleIntercept: true,
			// strictly-increasing-clock: a fake API answers in microseconds, so back-to-back units of work would share a millisecond and fail as a same-millisecond overwrite.
			// Every Node-environment file shares one project, so a worker keeps its loaded dependencies across the CLI, shared and web files instead of restarting at each project boundary.
			projects: [
				{
					extends: true,
					test:
					{
						name: "node",
						include: [
							"packages/cli/test/**/*.test.ts",
							"packages/mcp/test/**/*.test.ts",
							"packages/shared/test/**/*.test.ts",
							"scripts/**/*.test.mjs",
							"packages/web/test/**/*.test.{ts,tsx}",
						],
						exclude: domTests,
						isolate: sharedProcess.isolate,
						// check-op-outputs parses every op's value against its output schema; production never does.
						// Listed in full rather than spread from sharedProcess, so Fallow sees the shared setup files as used.
						setupFiles: [
							"packages/shared/test/setup/fresh-modules.ts",
							"packages/shared/test/setup/strictly-increasing-clock.ts",
							"packages/cli/test/setup/oclif-root.ts",
							"packages/web/test/setup/check-op-outputs.ts",
						],
						globalSetup: ["packages/cli/test/setup/migrated-template.ts"],
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
						globalSetup: [
							"packages/cloudflare/test/setup/build-client.ts",
							"packages/cloudflare/test/setup/bundle-workers.ts",
						],
					},
				},
			],
		},
	},
);
