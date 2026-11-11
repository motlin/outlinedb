#!/usr/bin/env node
// Chain refine-exercise proposals off the refine-journal proposals staged for the same entries.
//
// Both preps read the same live text, but the journal walk runs first. When the user accepts a
// journal proposal the entry's name becomes the journal `after`, so an exercise op guarded with
// `--expect-name <live text>` would stale-skip. Prep therefore stages two ops for an overlapping
// entry: the proposal's own `applyOps` (fallback, keyed on the live text) and `chained.applyOps`
// (keyed on the journal `after`). Apply resolves which one to run from the entry's current name.
//
// Usage:
//   node chain-exercise-ops.mts validate <refine-exercise.json> <refine-journal.json>
//   node chain-exercise-ops.mts resolve <refine-exercise.json> > <resolved.json>

import {execFileSync} from "node:child_process";
import {arrayField, expectObject, isObject, readJsonFile, stringField} from "./json.mts";
import type {JsonObject} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface ChainedOp {
	before?: string;
	after?: string;
	applyOps?: string[];
}

export interface ProposalEntry {
	[key: string]: unknown;
	nodeId: string;
	before?: string;
	after?: string;
	ambiguity?: unknown;
	applyOps?: string[];
	chained?: ChainedOp;
}

export interface ProposalFile {
	[key: string]: unknown;
	status?: string;
	proposals: ProposalEntry[];
}

export interface ChainValidation {
	valid: boolean;
	errors: string[];
}

const stringList = (object: JsonObject, key: string): string[] | undefined =>
	Array.isArray(object[key])
		? arrayField(object, key).filter((op): op is string => typeof op === "string")
		: undefined;

const parseChained = (value: unknown): ChainedOp | undefined => {
	if (!isObject(value)) {
		return undefined;
	}
	return {
		...value,
		before: stringField(value, "before"),
		after: stringField(value, "after"),
		applyOps: stringList(value, "applyOps"),
	};
};

const parseEntry = (value: unknown, index: number): ProposalEntry => {
	const entry = expectObject(value, `proposals[${index}]`);
	const parsed: ProposalEntry = {...entry, nodeId: stringField(entry, "nodeId") ?? ""};
	for (const key of ["before", "after"]) {
		const text = stringField(entry, key);
		if (text !== undefined) {
			parsed[key] = text;
		}
	}
	const applyOps = stringList(entry, "applyOps");
	if (applyOps !== undefined) {
		parsed.applyOps = applyOps;
	}
	const chained = parseChained(entry.chained);
	if (chained !== undefined) {
		parsed.chained = chained;
	}
	return parsed;
};

/** Narrow a staged proposal file read from JSON. */
export const parseProposalFile = (value: unknown, what: string): ProposalFile => {
	const file = expectObject(value, what);
	const parsed: ProposalFile = {...file, proposals: arrayField(file, "proposals").map(parseEntry)};
	const status = stringField(file, "status");
	if (status !== undefined) {
		parsed.status = status;
	}
	return parsed;
};

const hasUnguardedNameOp = (op: string): boolean => op.includes("--name") && !op.includes("--expect-name");

export const validateExerciseChain = (exercise: ProposalFile, journal: ProposalFile): ChainValidation => {
	const journalAfter = new Map(journal.proposals.map((entry) => [entry.nodeId, entry.after]));
	const errors: string[] = [];

	for (const [index, entry] of exercise.proposals.entries()) {
		const {chained} = entry;
		if (journalAfter.has(entry.nodeId) && !chained) {
			errors.push(
				`proposals[${index}]: ${entry.nodeId} is also staged by refine-journal but carries no "chained" op — accepting the journal proposal would stale-skip it`,
			);
			continue;
		}
		if (!chained) {
			continue;
		}
		if (chained.before !== journalAfter.get(entry.nodeId)) {
			errors.push(
				`proposals[${index}]: chained.before does not equal the refine-journal after text for ${entry.nodeId}`,
			);
			continue;
		}
		const opIndex = (chained.applyOps ?? []).findIndex(hasUnguardedNameOp);
		if (opIndex !== -1) {
			errors.push(`proposals[${index}]: chained.applyOps[${opIndex}] updates --name without --expect-name`);
		}
	}

	return {valid: errors.length === 0, errors};
};

// `liveNames` maps nodeId to the entry's current name, read after the journal walk finished.
// A drifted entry keeps the fallback so its --expect-name guard stale-skips it at apply time.
const resolveEntry = (entry: ProposalEntry, liveNames: Record<string, string>): ProposalEntry => {
	const {chained, ...rest} = entry;
	if (!chained || liveNames[entry.nodeId] !== chained.before) {
		return rest;
	}
	return {...rest, before: chained.before, after: chained.after, applyOps: chained.applyOps};
};

export const resolveExerciseProposals = (exercise: ProposalFile, liveNames: Record<string, string>): ProposalFile => {
	const proposals = exercise.proposals
		.map((entry) => resolveEntry(entry, liveNames))
		.filter((entry) => Boolean(entry.ambiguity) || entry.before !== entry.after);
	const status = exercise.status === "ready" && proposals.length === 0 ? "empty" : exercise.status;
	return {...exercise, proposals, status};
};

const readJson = (path: string): ProposalFile => parseProposalFile(readJsonFile(path), path);

const readLiveName = (nodeId: string): string => {
	const node = expectObject(
		JSON.parse(
			execFileSync("./bin/run.js", ["node", "get", "--id", nodeId, "--json", "--fields", "name"], {
				encoding: "utf8",
			}),
		),
		`node ${nodeId}`,
	);
	return stringField(node, "name") ?? "";
};

if (isMain(import.meta.url)) {
	const [command, exercisePath, journalPath] = process.argv.slice(2);
	if (command === "validate" && exercisePath !== undefined && journalPath !== undefined) {
		const {valid, errors} = validateExerciseChain(readJson(exercisePath), readJson(journalPath));
		if (valid) {
			console.log(`✓ ${exercisePath} chains every entry refine-journal also staged`);
		} else {
			console.error(`✗ ${exercisePath} is not chained on ${journalPath}:`);
			for (const error of errors) {
				console.error(`  - ${error}`);
			}
			process.exit(1);
		}
	} else if (command === "resolve" && exercisePath !== undefined) {
		const exercise = readJson(exercisePath);
		const liveNames = Object.fromEntries(
			exercise.proposals
				.filter((entry) => entry.chained)
				.map((entry) => [entry.nodeId, readLiveName(entry.nodeId)]),
		);
		console.log(JSON.stringify(resolveExerciseProposals(exercise, liveNames), null, "\t"));
	} else {
		console.error("usage: chain-exercise-ops.mts validate <refine-exercise.json> <refine-journal.json>");
		console.error("       chain-exercise-ops.mts resolve <refine-exercise.json>");
		process.exit(2);
	}
}
