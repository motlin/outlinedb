#!/usr/bin/env node
// Select (reveal) one photo in the Photos app so the user can delete or find it by hand.
// Read-only: it only calls spotlight and activate, never touches the library contents.
//
// Usage: node plugins/gtd/scripts/select-photo.mts --uuid F21E6284-ADA6-4053-AC27-1779E618CA38
//        node plugins/gtd/scripts/select-photo.mts --filename IMG_3513.HEIC --date 2026-10-25
// Prefer --uuid (ZASSET.ZUUID from a copy of the Photos library database): it references the
// item directly and returns in about a minute. --filename runs a `whose` scan over the whole
// library, which can take many minutes on a large one.
// Prints "selected <filename>" for --uuid. For --filename it prints "selected", or "matches=<n>"
// when the filename plus date is not exactly one item; several items can share a filename, so
// the date is required.

import {spawnSync} from "node:child_process";
import {takeValue} from "./cli-args.mts";
import {isMain} from "./is-main.mts";

export function buildSelectAppleScript(filename: string, date: string): string[]
{
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
	{
		throw new Error(`date must be YYYY-MM-DD, got ${date}`);
	}
	const escaped = filename.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
	return [
		"on run argv",
		'tell application "Photos"',
		"with timeout of 900 seconds",
		`set matches to (get every media item whose filename is "${escaped}")`,
		"set hits to {}",
		"repeat with m in matches",
		"set d to date of m",
		'set stamp to (year of d as string) & "-" & text -2 thru -1 of ("0" & ((month of d) as integer)) & "-" & text -2 thru -1 of ("0" & (day of d))',
		`if stamp is "${date}" then set end of hits to contents of m`,
		"end repeat",
		"if (count of hits) is 1 then",
		"spotlight (item 1 of hits)",
		"activate",
		'return "selected"',
		"else",
		'return "matches=" & (count of hits)',
		"end if",
		"end timeout",
		"end tell",
		"end run",
	];
}

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu;

export function buildSelectByIdAppleScript(uuid: string): string[]
{
	if (!UUID_RE.test(uuid))
	{
		throw new Error(`Expected a Photos asset uuid, got ${uuid}`);
	}
	return [
		"on run argv",
		'tell application "Photos"',
		"with timeout of 900 seconds",
		`set m to media item id "${uuid}/L0/001"`,
		"spotlight m",
		"activate",
		'return "selected " & (filename of m)',
		"end timeout",
		"end tell",
		"end run",
	];
}

if (isMain(import.meta.url))
{
	let uuid = "";
	let filename = "";
	let date = "";
	const args = process.argv.slice(2)[Symbol.iterator]();
	for (const arg of args)
	{
		if (arg === "--uuid")
		{
			uuid = takeValue(args, arg);
		}
		else if (arg === "--filename")
		{
			filename = takeValue(args, arg);
		}
		else if (arg === "--date")
		{
			date = takeValue(args, arg);
		}
		else
		{
			throw new Error(`Unknown argument ${arg}`);
		}
	}
	if (uuid === "" && (filename === "" || date === ""))
	{
		throw new Error("Usage: select-photo.mts --uuid <uuid> | --filename <name.ext> --date YYYY-MM-DD");
	}
	const lines = uuid === "" ? buildSelectAppleScript(filename, date) : buildSelectByIdAppleScript(uuid);
	const script = lines.flatMap((line) => ["-e", line]);
	const result = spawnSync(
		"osascript",
		script,
		{
			encoding: "utf8",
		},
	);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exit(result.status ?? 1);
}
