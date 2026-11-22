// Run: node --test plugins/gtd/scripts/run-review-script-tests.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runScriptTests} from "./run-review-script-tests.mts";

test("runScriptTests runs each test in a scratch directory against the scripts and reports pass or fail", () =>
{
	const scripts = mkdtempSync(join(tmpdir(), "review-scripts-"));
	mkdirSync(join(scripts, "tests"));
	const write = (name: string, content: string): void =>
	{
		writeFileSync(join(scripts, name), content);
		chmodSync(join(scripts, name), 0o755);
	};
	write("greet.sh", '#!/bin/sh\necho "hi $1"\n');
	write(
		"tests/greet-pass.test.sh",
		'#!/bin/sh\ntouch scratch-file\ntest "$("$REVIEW_SCRIPTS_DIR/greet.sh" bob)" = "hi bob"\n',
	);
	write("tests/greet-fail.test.sh", "#!/bin/sh\necho expected hello >&2\nexit 3\n");

	assert.deepStrictEqual(runScriptTests(scripts), [
		{
			name: "greet-fail.test.sh",
			passed: false,
			output: "expected hello\n",
		},
		{
			name: "greet-pass.test.sh",
			passed: true,
			output: "",
		},
	]);
	assert.deepStrictEqual(readdirSync(scripts).toSorted(), ["greet.sh", "tests"]);
	assert.deepStrictEqual(runScriptTests(join(scripts, "missing")), []);
});
