// Ledger of cross-project #llm-task agents the daily review launched into herdr tabs.
//
// A launched agent finishes and its pane closes, so the review loses track of it unless the launch
// is written down. The ledger (.llm/gtd/review/agent-launches.json) records each launch and where
// the agent will write its final report, so a later step can skip a task already launched this
// cycle and, before the run ends, read every report.
//
// Usage:
//   agent-launches.mts record <slug> <pane> <cwd> [--date YYYY-MM-DD]   prints the report path
//   agent-launches.mts check <slug> [--date YYYY-MM-DD]                 prints true|false
//   agent-launches.mts pending                                          prints {ready, missing}

import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {arrayField, isObject, readJsonFile} from "./json.mts";
import {takeValue} from "./cli-args.mts";
import {isMain} from "./is-main.mts";

export const LEDGER_PATH = ".llm/gtd/review/agent-launches.json";

export interface Launch {
	readonly slug: string;
	readonly pane: string;
	readonly cwd: string;
	readonly launchedAt: string;
	readonly reportPath: string;
}

export interface Ledger {
	readonly launches: readonly Launch[];
}

export function reportPath(slug: string, date: string): string {
	return `.llm/gtd/review/agent-reports/${slug}-${date}.md`;
}

export function recordLaunch(ledger: Ledger, launch: Launch): Ledger {
	return {launches: [...ledger.launches, launch]};
}

export function alreadyLaunched(ledger: Ledger, slug: string, date: string): boolean {
	return ledger.launches.some((l) => l.slug === slug && l.launchedAt.slice(0, 10) === date);
}

export function pendingReports(ledger: Ledger, root: string): {ready: readonly Launch[]; missing: readonly Launch[]} {
	const present = (l: Launch): boolean => existsSync(join(root, l.reportPath));
	return {ready: ledger.launches.filter(present), missing: ledger.launches.filter((l) => !present(l))};
}

function isLaunch(value: unknown): value is Launch {
	return (
		isObject(value) &&
		typeof value.slug === "string" &&
		typeof value.pane === "string" &&
		typeof value.cwd === "string" &&
		typeof value.launchedAt === "string" &&
		typeof value.reportPath === "string"
	);
}

function readLedger(path: string): Ledger {
	if (!existsSync(path)) {
		return {launches: []};
	}
	const parsed = readJsonFile(path);
	const launches = isObject(parsed) ? arrayField(parsed, "launches") : [];
	return {launches: launches.filter(isLaunch)};
}

function today(): string {
	return new Date().toLocaleDateString("en-CA");
}

function main(argv: readonly string[]): unknown {
	const positional: string[] = [];
	let date = today();
	const args = argv[Symbol.iterator]();
	for (const arg of args) {
		if (arg === "--date") {
			date = takeValue(args, arg);
		} else {
			positional.push(arg);
		}
	}
	const [command, slug = "", pane = "", cwd = ""] = positional;
	const ledger = readLedger(LEDGER_PATH);
	if (command === "check") {
		return alreadyLaunched(ledger, slug, date);
	}
	if (command === "pending") {
		return pendingReports(ledger, ".");
	}
	if (command === "record") {
		const report = reportPath(slug, date);
		const launch: Launch = {slug, pane, cwd, launchedAt: new Date().toISOString(), reportPath: report};
		mkdirSync(dirname(LEDGER_PATH), {recursive: true});
		writeFileSync(LEDGER_PATH, `${JSON.stringify(recordLaunch(ledger, launch), null, 2)}\n`);
		return report;
	}
	throw new Error("usage: agent-launches.mts record <slug> <pane> <cwd> | check <slug> | pending [--date D]");
}

if (isMain(import.meta.url)) {
	console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
}
