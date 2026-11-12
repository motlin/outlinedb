import {describe, expect, it} from "vite-plus/test";
import {resolve} from "node:path";

import {Command} from "@oclif/core";

const cliRoot = resolve(import.meta.dirname, "../..");

class ProbeRoot extends Command
{
	async run(): Promise<string>
	{
		await this.parse(ProbeRoot);
		return this.config.root;
	}
}

describe("oclif test setup", () =>
{
	it("loads the CLI package config when a command runs without explicit load options", async () =>
	{
		await expect(ProbeRoot.run([])).resolves.toBe(cliRoot);
	});
});
