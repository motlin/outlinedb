#!/usr/bin/env node
// Drop staged birthday backlog proposals that relationship-dates-handled.json already records, for
// plugins/gtd/commands/birthdays-prep.md. The prose rule alone was missed: a prep run re-staged an
// occurrence the user had already marked still-owed.
//
// Usage: filter-handled-relationship-dates.mts <staged birthdays.json> [handled.json]
// Rewrites the staged file in place without the recorded proposals and prints each dropped
// <person>:<field>:<occurrence> key. Any recorded decision counts, not only "handled". A missing
// handled file means nothing is recorded yet.

import {existsSync, writeFileSync} from "node:fs";
import {isMain} from "./is-main.mts";
import type {JsonObject} from "./json.mts";
import {arrayField, errorMessage, expectArray, expectObject, isObject, readJsonFile, stringField} from "./json.mts";

const DEFAULT_HANDLED_PATH = ".llm/gtd/review/relationship-dates-handled.json";

function occurrenceKey(entry: JsonObject): string
{
	return `${stringField(entry, "person")}:${stringField(entry, "field")}:${stringField(entry, "occurrence")}`;
}

/** The staged briefing without proposals already recorded in `handled`, plus the dropped keys. */
export function filterHandled(
	staged: JsonObject,
	handled: unknown[],
):
{
	staged: JsonObject;
	dropped: string[];
}
{
	const recorded = new Set(handled.map((entry) => occurrenceKey(expectObject(entry, "handled entry"))));
	const kept: unknown[] = [];
	const dropped: string[] = [];
	for (const proposal of arrayField(staged, "proposals"))
	{
		const key = occurrenceKey(expectObject(proposal, "proposal"));
		if (recorded.has(key))
		{
			dropped.push(key);
		}
		else
		{
			kept.push(proposal);
		}
	}
	const result: JsonObject =
	{
		...staged,
		proposals: kept,
	};
	if (isObject(staged.summary) && typeof staged.summary.backlogStaged === "number")
	{
		result.summary =
		{
			...staged.summary,
			backlogStaged: kept.length,
		};
	}
	return {
		staged: result,
		dropped,
	};
}

/** Filter the staged file in place against the handled file; returns the dropped keys. */
export function filterHandledFile(stagedPath: string, handledPath: string): string[]
{
	const staged = expectObject(readJsonFile(stagedPath), stagedPath);
	const handled = existsSync(handledPath) ? expectArray(readJsonFile(handledPath), handledPath) : [];
	const result = filterHandled(staged, handled);
	if (result.dropped.length > 0)
	{
		writeFileSync(stagedPath, `${JSON.stringify(result.staged, null, "\t")}\n`);
	}
	return result.dropped;
}

if (isMain(import.meta.url))
{
	try
	{
		const [stagedPath, handledPath = DEFAULT_HANDLED_PATH] = process.argv.slice(2);
		if (stagedPath === undefined)
		{
			throw new Error("usage: filter-handled-relationship-dates.mts <staged birthdays.json> [handled.json]");
		}
		for (const key of filterHandledFile(stagedPath, handledPath))
		{
			process.stdout.write(`dropped already-recorded ${key}\n`);
		}
	}
	catch (error)
	{
		process.stderr.write(`filter-handled-relationship-dates: ${errorMessage(error)}\n`);
		process.exitCode = 1;
	}
}
