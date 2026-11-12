// Run: node --test plugins/gtd/scripts/select-photo.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {buildSelectAppleScript} from "./select-photo.mts";

test("buildSelectAppleScript selects by exact filename and date, read-only", () =>
{
	assert.deepStrictEqual(buildSelectAppleScript("IMG_3513.HEIC", "2026-10-25"), [
		"on run argv",
		'tell application "Photos"',
		'set matches to (get every media item whose filename is "IMG_3513.HEIC")',
		"set hits to {}",
		"repeat with m in matches",
		"set d to date of m",
		'set stamp to (year of d as string) & "-" & text -2 thru -1 of ("0" & ((month of d) as integer)) & "-" & text -2 thru -1 of ("0" & (day of d))',
		'if stamp is "2026-10-25" then set end of hits to contents of m',
		"end repeat",
		"if (count of hits) is 1 then",
		"spotlight (item 1 of hits)",
		"activate",
		'return "selected"',
		"else",
		'return "matches=" & (count of hits)',
		"end if",
		"end tell",
		"end run",
	]);
});

test("buildSelectAppleScript escapes quotes and backslashes in the filename", () =>
{
	const lines = buildSelectAppleScript(String.raw`a"b\c.jpg`, "2026-01-02");
	assert.ok(lines.includes(String.raw`set matches to (get every media item whose filename is "a\"b\\c.jpg")`));
});

test("buildSelectAppleScript rejects a malformed date", () =>
{
	assert.throws(() => buildSelectAppleScript("IMG_1.JPG", "10/25/2026"), /YYYY-MM-DD/u);
});

test("buildSelectAppleScript never contains a mutating Photos verb", () =>
{
	const script = buildSelectAppleScript("IMG_1.JPG", "2026-01-02").join("\n");
	assert.doesNotMatch(script, /\b(delete|remove|move|import|set (name|title|favorite))\b/u);
});
