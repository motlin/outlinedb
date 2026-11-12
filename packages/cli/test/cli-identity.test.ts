import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

import {DEFAULT_DB_FILE} from "../src/db/default-db-file.js";

const cliRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(cliRoot, "../..");

function packageIdentity(dir: string)
{
	const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as
	{
		bin: Record<string, string>;
		keywords: string[];
		oclif:
		{
			bin: string;
			dirname: string;
		};
	};
	return {
		bin: pkg.bin,
		keywords: pkg.keywords,
		oclifBin: pkg.oclif.bin,
		oclifDirname: pkg.oclif.dirname,
	};
}

function processTitle(file: string)
{
	return /process\.title = "([^"]+)";/u.exec(readFileSync(file, "utf8"))?.[1];
}

describe("CLI identity", () =>
{
	it.each([cliRoot, repoRoot])("names the binary outlinedb in %s/package.json", (dir) =>
	{
		expect(packageIdentity(dir)).toStrictEqual(
			{
				bin:
				{
					outlinedb: "./bin/run.js",
				},
				keywords: ["api", "cli", "oclif", "outlinedb"],
				oclifBin: "outlinedb",
				oclifDirname: "outlinedb",
			},
		);
	});

	it.each([resolve(cliRoot, "bin/run.js"), resolve(repoRoot, "bin/run.js"), resolve(repoRoot, "bin/dev.js")])(
		"titles the process outlinedb-cli in %s",
		(file) =>
		{
			expect(processTitle(file)).toBe("outlinedb-cli");
		},
	);

	it("defaults the local cache database to outlinedb.sqlite", () =>
	{
		expect(DEFAULT_DB_FILE).toBe("outlinedb.sqlite");
	});
});
