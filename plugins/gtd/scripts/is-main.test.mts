// Run: node --test plugins/gtd/scripts/is-main.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

import {isMain} from "./is-main.mts";

function fixture(): {real: string; linked: string; other: string} {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "is-main-")));
	const realDirectory = join(root, "real");
	mkdirSync(realDirectory);
	const real = join(realDirectory, "script.mts");
	writeFileSync(real, "");
	const other = join(realDirectory, "other.mts");
	writeFileSync(other, "");
	symlinkSync(realDirectory, join(root, "link"));
	return {real, linked: join(root, "link", "script.mts"), other};
}

test("isMain matches the module whether argv[1] is the real path or reached through a symlink", () => {
	const {real, linked, other} = fixture();
	const moduleUrl = pathToFileURL(real).href;
	assert.deepStrictEqual(
		{
			real: isMain(moduleUrl, real),
			linked: isMain(moduleUrl, linked),
			other: isMain(moduleUrl, other),
			missing: isMain(moduleUrl, undefined),
		},
		{real: true, linked: true, other: false, missing: false},
	);
});
