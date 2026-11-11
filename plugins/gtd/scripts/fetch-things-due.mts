#!/usr/bin/env node
// Fetch the Things 3 tasks the daily review is responsible for, as JSON for collect-due-items.mts.
//
// Things is read two ways in this repo and they are not interchangeable. The capture scanner
// reads main.sqlite directly, where dates are a packed integer format. This script uses
// AppleScript instead, because the review also has to *write* (complete, reschedule, cancel) and
// AppleScript is the only bridge that does both. Reading and writing through one bridge keeps the
// ids consistent between what was shown and what gets acted on.
//
// Three working sets. collect-due-items.mts unions the first two:
//   due     -- anything with a deadline on or before today, whatever list it lives in
//   today   -- the Today list, which is what Things itself says to do now
//   anytime -- undated Anytime tasks, which nothing ever surfaces because nothing is due. These
//              are not due items; file-tasks sweeps them into the personal 📌 asap ladder.
//
// Usage: node fetch-things-due.mts [--today YYYY-MM-DD] > things.json

import {execFileSync} from "node:child_process";
import {isMain} from "./is-main.mts";

// ASCII unit/record separators: a task title or note can contain any punctuation -- including
// newlines and pipes -- but never these.
export const FIELD_SEP = "\x1F";
export const RECORD_SEP = "\x1E";

const pad = (n: number): string => String(n).padStart(2, "0");

function normalizeDate(due: string | undefined): string | null {
	if (!due) {
		return null;
	}
	const [y, m, d] = due.split("-").map(Number);
	if (y === undefined || m === undefined || d === undefined) {
		throw new Error(`Expected a Y-M-D Things due date, got: ${due}`);
	}
	return `${y}-${pad(m)}-${pad(d)}`;
}

export interface ThingsTask {
	id: string;
	title: string;
	due: string | null;
	list: string;
	notes: string | null;
	activationDate?: string | null;
}

export function parseThingsRows(raw: string): ThingsTask[] {
	return raw
		.split(RECORD_SEP)
		.filter((record) => record.length > 0)
		.map((record) => record.split(FIELD_SEP))
		.filter((fields) => fields.length === 6)
		.map(([id = "", title = "", due, list = "", notes, activation]) => ({
			id,
			title,
			due: normalizeDate(due),
			list,
			notes: notes || null,
			// When Things put the task in Today. A deadline-less repeating chore left unticked keeps
			// its original activation date, which is the day it actually belongs to.
			activationDate: normalizeDate(activation),
		}));
}

export function script(listName: string): string {
	// The separators are built with `ASCII character` so no control byte has to survive the trip
	// through the shell into an AppleScript string literal.
	//
	// Snapshot the ids BEFORE reading any properties. `repeat with t in (to dos of list "X")`
	// binds each `t` to a lazy reference -- `item N of every to do of list "X"` -- resolved only
	// when a property is read. Things' lists are dynamic (a repeating to-do rolls off, a filter
	// re-evaluates), so the list can shrink under the iteration and the next dereference dies with
	// `Can't get item 17 of every to do of list "Today". Invalid index. (-1719)`. An id is a
	// stable handle; `to do id X` never depends on position.
	return `set fs to (ASCII character 31)
set rs to (ASCII character 30)
tell application "Things3"
	set theIDs to id of every to do of list "${listName}"
	set out to ""
	set skipped to 0
	repeat with theID in theIDs
		set ok to false
		repeat with attempt from 1 to 2
			if not ok then
				try
					set t to to do id (theID as string)
					set dd to due date of t
					if dd is missing value then
						set ds to ""
					else
						set ds to ((year of dd) as string) & "-" & ((month of dd) as integer) & "-" & ((day of dd) as string)
					end if
					set ad to activation date of t
					if ad is missing value then
						set ads to ""
					else
						set ads to ((year of ad) as string) & "-" & ((month of ad) as integer) & "-" & ((day of ad) as string)
					end if
					set out to out & (id of t) & fs & (name of t) & fs & ds & fs & "${listName}" & fs & (notes of t) & fs & ads & rs
					set ok to true
				on error
					-- Retry once: a transient Apple Event failure under load looks identical to a
					-- to-do that was completed between the snapshot and the lookup, and treating the
					-- two the same silently changes the answer between runs.
				end try
			end if
		end repeat
		if not ok then set skipped to skipped + 1
	end repeat
	if skipped > 0 then set out to out & "SKIPPED" & fs & (skipped as string) & rs
	return out
end tell`;
}

// Anytime is the list nothing ever prunes, so the AppleScript round-trip grows with the backlog
// and a cold Things 3 has to launch before it answers at all. 30s was enough when the list was
// small and started timing out once it wasn't.
export const OSASCRIPT_TIMEOUT_MS = 180_000;

function run(listName: string): ThingsTask[] {
	return parseThingsRows(
		execFileSync("osascript", ["-e", script(listName)], {encoding: "utf8", timeout: OSASCRIPT_TIMEOUT_MS}),
	);
}

function localTodayISO(): string {
	const now = new Date();
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Split the two raw Things lists into the review's working sets. Things treats Anytime as a
 * superset that already contains Today, so the Today ids come off the Anytime list once, up front,
 * and both splits work from that remainder rather than trusting the list membership.
 */
export function partitionThings<T extends {id: string; due: string | null}>(
	{todayList, anytime, someday = []}: {todayList: T[]; anytime: T[]; someday?: T[]},
	todayISO: string,
): {due: T[]; today: T[]; anytime: T[]; someday: T[]} {
	const inToday = new Set(todayList.map((t) => t.id));
	const anytimeOnly = anytime.filter((t) => !inToday.has(t.id));

	const due = [...todayList, ...anytimeOnly].filter((t) => t.due !== null && t.due !== "" && t.due <= todayISO);
	// A dated Anytime task is already handled -- either it is due now and in `due`, or it will
	// surface on its own date. Only the undated ones are invisible and need the asap sweep.
	const undatedAnytime = anytimeOnly.filter((t) => !t.due);

	// Someday is a third unpruned backlog. A task can sit in Someday and still show up in the
	// other lists, so drop anything already accounted for rather than sweeping it twice.
	const seen = new Set([...inToday, ...anytimeOnly.map((t) => t.id)]);
	const somedayOnly = someday.filter((t) => !seen.has(t.id));

	return {due, today: todayList, anytime: undatedAnytime, someday: somedayOnly};
}

function main(argv: readonly string[]): void {
	const args = argv.slice(2);
	let today = localTodayISO();
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--today") {
			today = args[++i] ?? today;
		}
	}

	const sets = partitionThings({todayList: run("Today"), anytime: run("Anytime"), someday: run("Someday")}, today);
	process.stdout.write(`${JSON.stringify(sets, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
	main(process.argv);
}
