import {expect, describe, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {findPersonalHomePaths} from "./helpers/personal-paths.js";
import {PROJECT_ROOT, trackedFiles} from "./helpers/scan-roots.js";

/**
 * `plugins/` and `.claude/` are version-controlled and meant to be reusable, so
 * they must not carry one machine's home directory. A hardcoded `/Users/<name>`
 * or `/home/<name>` both leaks the author's username and breaks the file for
 * anyone else. Placeholder users like `alice` or `bob` are fine.
 *
 * Only tracked files are scanned. Gitignored personal config (`.claude/
 * settings.local.json`, `.llm/`) is exempt by design -- that is where
 * machine-specific paths are supposed to live.
 */

const SCAN_ROOTS = ["plugins", ".claude"];

describe("Structural Eval: No Personal Paths", () => {
	it("no tracked file under plugins/ or .claude/ hardcodes a home directory", () => {
		const violations: string[] = [];

		for (const root of SCAN_ROOTS) {
			for (const relativePath of trackedFiles(root)) {
				const content = readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
				content.split("\n").forEach((line, index) => {
					for (const homePath of findPersonalHomePaths(line)) {
						violations.push(`${relativePath}:${index + 1}: ${homePath}`);
					}
				});
			}
		}

		expect(violations).toStrictEqual([]);
	});
});
