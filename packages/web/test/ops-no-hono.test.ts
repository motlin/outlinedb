import {existsSync, readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";

const opsDir = fileURLToPath(new URL("../src/server/ops/", import.meta.url));

function sourceFiles(dir: string): string[]
{
	return readdirSync(
		dir,
		{
			withFileTypes: true,
		},
	).flatMap((entry) =>
	{
		const full = `${dir}${entry.name}`;
		return entry.isDirectory() ? sourceFiles(`${full}/`) : [full];
	});
}

describe("host-neutral ops", () =>
{
	it("do not import hono", () =>
	{
		const offenders = existsSync(opsDir)
			? sourceFiles(opsDir).filter((file) =>
					/from\s+["']hono(\/[^"']*)?["']|from\s+["']@hono\//u.test(readFileSync(file, "utf8")),
				)
			: [];
		expect(offenders).toStrictEqual([]);
	});

	it("do not import cloudflare:* modules", () =>
	{
		const offenders = existsSync(opsDir)
			? sourceFiles(opsDir).filter((file) => /from\s+["']cloudflare:/u.test(readFileSync(file, "utf8")))
			: [];
		expect(offenders).toStrictEqual([]);
	});
});
