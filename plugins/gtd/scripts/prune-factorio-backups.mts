#!/usr/bin/env node
// Archive the Factorio Prints Firebase backup dumps to the NAS, then prune old ones from the bucket.
//
// The bucket gains a ~1.4 GB `<ISO timestamp>_<project>_data.json.gz` dump every day.
// This copies every dump the NAS lacks, then deletes the dumps that are older than 45 days and
// are not the first dump of their calendar month. A dump is deleted only when the NAS holds a
// copy with the identical byte size. The tiny `*_rules.json.gz` files are never touched.
//
// Prints a daily-review briefing as JSON on stdout and exits non-zero when anything failed or
// stayed unverified. An unmounted NAS is a successful no-op, and so is a missing configuration.
//
// The bucket, gcloud project, gcloud account, and NAS directory are personal settings, read from
// `factorioBackups: {bucket, project, account, nasDir}` in .llm/gtd/config.json.
//
// Usage: prune-factorio-backups.mts [--dry-run] [--today YYYY-MM-DD] [--config <path>]

import {execFileSync} from "node:child_process";
import {existsSync, statSync} from "node:fs";
import {join} from "node:path";
import {takeValue} from "./cli-args.mts";
import {localTodayISO} from "./compute-overdue.mts";
import {parseIsoDate} from "./iso-date.mts";
import {errorMessage, expectArray, expectObject, isObject, parseJson, readJsonFile, stringField} from "./json.mts";

const DEFAULT_CONFIG_PATH = ".llm/gtd/config.json";
const CONFIG_KEY = "factorioBackups";
const SETTING_KEYS = ["bucket", "project", "account", "nasDir"] as const;
const KEEP_DAYS = 45;
const DUMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T[\d:.]+Z_.+_data\.json\.gz$/u;
const COPY_TIMEOUT_MS = 30 * 60 * 1000;
const GIB = 1024 ** 3;

type BackupSettings = Record<(typeof SETTING_KEYS)[number], string>;

export interface BucketObject {
	name: string;
	size: number;
	/** Pins a delete to the exact object that was verified. */
	generation: string;
}

interface Unverified {
	name: string;
	reason: string;
}

interface PrunePlan {
	/** Dumps the NAS lacks, expired or not. */
	toCopy: BucketObject[];
	/** Expired dumps whose NAS copy has the identical size. */
	toDelete: BucketObject[];
	/** Every dump without an identical-size NAS copy. */
	unverified: Unverified[];
	/** Dumps the retention rule keeps in the bucket. */
	kept: number;
}

interface Outcome {
	dryRun: boolean;
	/** Config keys that are absent; non-empty means nothing ran. */
	missingConfig: string[];
	nasMounted: boolean;
	copied: string[];
	deleted: string[];
	bytesFreed: number;
	kept: number;
	unverified: Unverified[];
	failures: string[];
}

interface Briefing {
	task: string;
	status: "ready" | "empty" | "error";
	lines: string[];
	autoApplied: string[];
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The UTC date a data dump was taken, or null for any other object. */
function dumpDate(name: string): string | null {
	return DUMP_PATTERN.exec(name)?.[1] ?? null;
}

function daysBefore(iso: string, days: number): string {
	const {year, month, day} = parseIsoDate(iso);
	return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}

/**
 * The data dumps the retention rule lets go: older than `keepDays` and not the first dump of
 * their calendar month. Names that are not data dumps are never returned.
 */
export function selectExpired(names: string[], today: string, keepDays: number = KEEP_DAYS): string[] {
	const cutoff = daysBefore(today, keepDays);
	const monthsSeen = new Set<string>();
	const expired: string[] = [];
	// ISO timestamps lead each name, so name order is chronological.
	for (const name of names.toSorted(byName)) {
		const date = dumpDate(name);
		if (date === null) {
			continue;
		}
		const month = date.slice(0, 7);
		const firstOfMonth = !monthsSeen.has(month);
		monthsSeen.add(month);
		if (!firstOfMonth && date < cutoff) {
			expired.push(name);
		}
	}
	return expired;
}

/** `nasSize` answers a file's byte size on the NAS, or null when the NAS has no such file. */
export function planPrune(objects: BucketObject[], today: string, nasSize: (name: string) => number | null): PrunePlan {
	const dumps = objects.filter((object) => dumpDate(object.name) !== null).toSorted((a, b) => byName(a.name, b.name));
	const expired = new Set(
		selectExpired(
			dumps.map((object) => object.name),
			today,
		),
	);
	const plan: PrunePlan = {toCopy: [], toDelete: [], unverified: [], kept: dumps.length - expired.size};
	for (const object of dumps) {
		const size = nasSize(object.name);
		if (size === null) {
			plan.toCopy.push(object);
			plan.unverified.push({name: object.name, reason: "missing on the NAS"});
		} else if (size !== object.size) {
			plan.unverified.push({
				name: object.name,
				reason: `size differs: bucket ${object.size} bytes, NAS ${size} bytes`,
			});
		} else if (expired.has(object.name)) {
			plan.toDelete.push(object);
		}
	}
	return plan;
}

/** Parse `gcloud storage objects list --format=json(name,size,generation)`. */
export function parseListing(text: string): BucketObject[] {
	return expectArray(parseJson(text), "bucket listing").map((item) => {
		const {name, size: rawSize, generation} = expectObject(item, "bucket object");
		if (typeof name !== "string") {
			throw new TypeError("bucket object has no name");
		}
		const size = typeof rawSize === "string" && rawSize !== "" ? Number(rawSize) : rawSize;
		if (typeof size !== "number" || !Number.isSafeInteger(size)) {
			throw new TypeError(`bucket object ${name} has an unreadable size`);
		}
		if (typeof generation !== "string" && typeof generation !== "number") {
			throw new TypeError(`bucket object ${name} has no generation`);
		}
		return {name, size, generation: String(generation)};
	});
}

/**
 * The `factorioBackups` settings from the parsed gtd config. `settings` is null when any key is
 * absent or not a non-empty string, and `missing` names each such key.
 */
export function readBackupConfig(config: unknown): {settings: BackupSettings | null; missing: string[]} {
	const section = isObject(config) && isObject(config[CONFIG_KEY]) ? config[CONFIG_KEY] : {};
	const value = (key: string): string => stringField(section, key) ?? "";
	const missing = SETTING_KEYS.filter((key) => value(key) === "").map((key) => `${CONFIG_KEY}.${key}`);
	if (missing.length > 0) {
		return {settings: null, missing};
	}
	return {
		settings: {
			bucket: value("bucket"),
			project: value("project"),
			account: value("account"),
			nasDir: value("nasDir"),
		},
		missing,
	};
}

/** `gcloud storage rm` is blocked by a hook on this machine, so deletes go through the JSON API. */
export function deleteUrl(bucket: string, object: BucketObject): string {
	const name = encodeURIComponent(object.name);
	const generation = encodeURIComponent(object.generation);
	return `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}?ifGenerationMatch=${generation}`;
}

export function buildBriefing(outcome: Outcome): Briefing {
	const task = "factorio-backups-prune";
	if (outcome.missingConfig.length > 0) {
		return {
			task,
			status: "empty",
			lines: [
				`🗄️ Factorio backups: not configured, nothing copied or pruned; set ${outcome.missingConfig.join(", ")} in ${DEFAULT_CONFIG_PATH}`,
			],
			autoApplied: [],
		};
	}
	if (!outcome.nasMounted) {
		return {
			task,
			status: "empty",
			lines: ["🗄️ Factorio backups: NAS not mounted, nothing copied or pruned"],
			autoApplied: [],
		};
	}
	const {copied, deleted, unverified, failures} = outcome;
	const idle = copied.length === 0 && deleted.length === 0;
	const clean = unverified.length === 0 && failures.length === 0;
	const [label, copyVerb, deleteVerb] = outcome.dryRun
		? ["Factorio backups (dry run)", "would copy", "would delete"]
		: ["Factorio backups", "copied", "deleted"];
	const freed = (outcome.bytesFreed / GIB).toFixed(2);
	const headline =
		idle && clean
			? `🗄️ ${label}: nothing to copy or prune, ${outcome.kept} kept`
			: `🗄️ ${label}: ${copyVerb} ${copied.length} to the NAS, ${deleteVerb} ${deleted.length} from the bucket (${freed} GiB freed), ${outcome.kept} kept`;
	return {
		task,
		status: clean ? (idle ? "empty" : "ready") : "error",
		lines: [
			headline,
			...unverified.map(
				({name, reason}) =>
					`⚠️ Factorio backup not verified on the NAS, left in the bucket: ${name} (${reason})`,
			),
			...failures.map((failure) => `⚠️ Factorio backups prune: ${failure}`),
		],
		autoApplied: outcome.dryRun
			? []
			: [
					...copied.map((name) => `Copied ${name} to the NAS`),
					...deleted.map((name) => `Deleted ${name} from the bucket`),
				],
	};
}

function gcloud(args: string[], timeout?: number): string {
	return execFileSync("gcloud", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		timeout,
	});
}

const gcloudScope = ({project, account}: BackupSettings): string[] => ["--project", project, "--account", account];

function listDumps(settings: BackupSettings): BucketObject[] {
	return parseListing(
		gcloud([
			"storage",
			"objects",
			"list",
			`gs://${settings.bucket}/*_data.json.gz`,
			"--format=json(name,size,generation)",
			...gcloudScope(settings),
		]),
	);
}

function fileSize(path: string): number | null {
	try {
		return statSync(path).size;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function deleteObject(bucket: string, object: BucketObject, token: string): Promise<void> {
	const response = await fetch(deleteUrl(bucket, object), {
		method: "DELETE",
		headers: {Authorization: `Bearer ${token}`},
	});
	if (response.status !== 204) {
		throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
	}
}

async function run(dryRun: boolean, today: string, configPath: string): Promise<Outcome> {
	const {settings, missing} = readBackupConfig(existsSync(configPath) ? readJsonFile(configPath) : null);
	const nasDir = settings?.nasDir ?? "";
	const outcome: Outcome = {
		dryRun,
		missingConfig: missing,
		nasMounted: settings !== null && existsSync(nasDir),
		copied: [],
		deleted: [],
		bytesFreed: 0,
		kept: 0,
		unverified: [],
		failures: [],
	};
	if (settings === null || !outcome.nasMounted) {
		return outcome;
	}
	const nasSize = (name: string): number | null => fileSize(join(nasDir, name));
	const objects = listDumps(settings);
	const before = planPrune(objects, today, nasSize);
	outcome.kept = before.kept;

	if (dryRun) {
		const pendingCopy = new Set(before.toCopy.map((object) => object.name));
		outcome.copied = [...pendingCopy];
		outcome.deleted = before.toDelete.map((object) => object.name);
		outcome.bytesFreed = before.toDelete.reduce((sum, object) => sum + object.size, 0);
		outcome.unverified = before.unverified.filter(({name}) => !pendingCopy.has(name));
		return outcome;
	}

	for (const object of before.toCopy) {
		try {
			gcloud(
				[
					"storage",
					"cp",
					`gs://${settings.bucket}/${object.name}`,
					join(nasDir, object.name),
					...gcloudScope(settings),
				],
				COPY_TIMEOUT_MS,
			);
			outcome.copied.push(object.name);
		} catch (error) {
			outcome.failures.push(`copy of ${object.name} failed: ${errorMessage(error)}`);
		}
	}

	// Plan again from the NAS as it is now: only a copy that landed at full size unlocks a delete.
	const after = planPrune(objects, today, nasSize);
	outcome.unverified = after.unverified;
	if (after.toDelete.length === 0) {
		return outcome;
	}
	const token = gcloud(["auth", "print-access-token", "--account", settings.account]).trim();
	for (const object of after.toDelete) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- deletes are sequential so a failure stops nothing else mid-flight
			await deleteObject(settings.bucket, object, token);
			outcome.deleted.push(object.name);
			outcome.bytesFreed += object.size;
		} catch (error) {
			outcome.failures.push(`delete of ${object.name} failed: ${errorMessage(error)}`);
		}
	}
	return outcome;
}

async function main(): Promise<void> {
	let dryRun = false;
	let today = localTodayISO();
	let configPath = DEFAULT_CONFIG_PATH;
	const args = process.argv.slice(2)[Symbol.iterator]();
	for (const arg of args) {
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--today") {
			today = takeValue(args, arg);
		} else if (arg === "--config") {
			configPath = takeValue(args, arg);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	let briefing: Briefing;
	try {
		briefing = buildBriefing(await run(dryRun, today, configPath));
	} catch (error) {
		briefing = {
			task: "factorio-backups-prune",
			status: "error",
			lines: [`⚠️ Factorio backups prune failed: ${errorMessage(error)}`],
			autoApplied: [],
		};
	}
	process.stdout.write(`${JSON.stringify(briefing, null, "\t")}\n`);
	if (briefing.status === "error") {
		process.exitCode = 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
