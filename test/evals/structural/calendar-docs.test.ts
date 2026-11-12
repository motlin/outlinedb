import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {PROJECT_ROOT, trackedFiles} from "./helpers/scan-roots.js";

/**
 * A node created below the 📆 Calendar root by name has no `metadata.calendar`, so workflowy.com ignores it and
 * creates its own duplicate. Plugins must create calendar levels with `calendar day --ensure`.
 */
const NAME_ONLY_CREATE = /node create --parent-path "📆 Calendar,/u;

describe("plugin docs do not create 📆 Calendar levels by name", () =>
{
	const docs = trackedFiles("plugins").filter((file) => file.endsWith(".md"));

	it("scans the plugin markdown", () =>
	{
		expect(docs.length).toBeGreaterThan(0);
	});

	it('has no `node create --parent-path "📆 Calendar,..."` line', () =>
	{
		const offenders = docs.flatMap((file) =>
			readFileSync(join(PROJECT_ROOT, file), "utf8")
				.split("\n")
				.flatMap((line, index) => (NAME_ONLY_CREATE.test(line) ? [`${file}:${index + 1}`] : [])),
		);

		expect(offenders).toStrictEqual([]);
	});

	it("teaches `calendar day --ensure` in the journal executor", () =>
	{
		const executor = readFileSync(join(PROJECT_ROOT, "plugins/gtd/prompts/journal/journal-executor.md"), "utf8");

		expect(executor).toContain("./bin/run.js calendar day --date <eventDate> --ensure --no-child -j");
	});
});
