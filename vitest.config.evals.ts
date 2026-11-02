import {defineConfig} from "vite-plus";

export default defineConfig(
	{
		test:
		{
			globals: true,
			include: ["test/evals/**/*.{test,eval}.ts"],
			testTimeout: 120_000,
			// Eval setup copies the database and metadata cache, and LLM suites probe the claude CLI
			hookTimeout: 60_000,
			restoreMocks: true,
			reporters: ["verbose"],
			disableConsoleIntercept: true,
		},
	},
);
