import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {journal, migrations} from "../src/db/migrations-bundle.generated.js";

const migrationsDir = join(import.meta.dirname, "../src/db/migrations");

describe("migrations bundle", () =>
{
	it("journal equals meta/_journal.json", () =>
	{
		const onDisk = JSON.parse(readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8"));
		expect(journal).toStrictEqual(onDisk);
	});

	it("has one SQL string per journal entry, byte for byte equal to the .sql file", () =>
	{
		const expected: Record<string, string> = {};
		for (const entry of journal.entries)
		{
			expected[`m${String(entry.idx).padStart(4, "0")}`] = readFileSync(
				join(migrationsDir, `${entry.tag}.sql`),
				"utf8",
			);
		}
		expect(migrations).toStrictEqual(expected);
	});

	it("covers every .sql file on disk, so an unregenerated new file fails", () =>
	{
		const sqlTags = readdirSync(migrationsDir)
			.filter((f) => f.endsWith(".sql"))
			.map((f) => f.slice(0, -4))
			.toSorted();
		expect(journal.entries.map((e) => e.tag).toSorted()).toStrictEqual(sqlTags);
	});
});
