// Run: node --test plugins/gtd/scripts/prune-factorio-backups.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {
	buildBriefing,
	deleteUrl,
	parseListing,
	planPrune,
	readBackupConfig,
	selectExpired,
} from "./prune-factorio-backups.mts";
import type {BucketObject} from "./prune-factorio-backups.mts";

const dump = (timestamp: string, size = 100): BucketObject => ({
	name: `${timestamp}_example-project_data.json.gz`,
	size,
	generation: `g-${timestamp}`,
});

const TODAY = "2026-11-10";

test("selectExpired keeps the last 45 days and the first dump of each calendar month", () => {
	const names = [
		// August: only the first dump of the month survives.
		"2026-08-01T04:18:00Z_example-project_data.json.gz",
		"2026-08-01T16:00:00Z_example-project_data.json.gz",
		"2026-08-31T04:18:00Z_example-project_data.json.gz",
		// September's first dump is the 3rd; the day before the cutoff expires.
		"2026-09-03T04:18:00Z_example-project_data.json.gz",
		"2026-09-25T04:18:00Z_example-project_data.json.gz",
		// 45 days before 2026-11-10 is 2026-09-26: kept, as is everything after it.
		"2026-09-26T04:18:00Z_example-project_data.json.gz",
		"2026-11-09T15:31:24Z_example-project_data.json.gz",
		// Rules files and strangers are never candidates.
		"2026-08-15T04:18:00Z_example-project_rules.json.gz",
		"firebase-auth-export.json",
	];
	assert.deepStrictEqual(selectExpired(names.toReversed(), TODAY), [
		"2026-08-01T16:00:00Z_example-project_data.json.gz",
		"2026-08-31T04:18:00Z_example-project_data.json.gz",
		"2026-09-25T04:18:00Z_example-project_data.json.gz",
	]);
});

test("planPrune copies what the NAS lacks and deletes only expired dumps whose NAS copy has the same size", () => {
	const first = dump("2026-08-01T04:18:00Z");
	const verified = dump("2026-08-02T04:18:00Z", 200);
	const missing = dump("2026-08-03T04:18:00Z", 300);
	const mismatched = dump("2026-08-04T04:18:00Z", 400);
	const recentMissing = dump("2026-11-09T15:31:24Z", 500);
	const rules: BucketObject = {
		name: "2026-08-02T04:18:00Z_example-project_rules.json.gz",
		size: 7,
		generation: "r",
	};
	const nasSizes = new Map<string, number>([
		[first.name, 100],
		[verified.name, 200],
		[mismatched.name, 399],
	]);

	assert.deepStrictEqual(
		planPrune(
			[recentMissing, mismatched, rules, missing, verified, first],
			TODAY,
			(name) => nasSizes.get(name) ?? null,
		),
		{
			toCopy: [missing, recentMissing],
			toDelete: [verified],
			unverified: [
				{name: missing.name, reason: "missing on the NAS"},
				{name: mismatched.name, reason: "size differs: bucket 400 bytes, NAS 399 bytes"},
				{name: recentMissing.name, reason: "missing on the NAS"},
			],
			kept: 2,
		},
	);
});

test("parseListing reads gcloud's JSON, whose sizes and generations may be strings or numbers", () => {
	const listing = JSON.stringify([
		{name: "a_example-project_data.json.gz", size: "1370489367", generation: "1762155931000000"},
		{name: "b_example-project_data.json.gz", size: 12, generation: 34},
	]);
	assert.deepStrictEqual(parseListing(listing), [
		{name: "a_example-project_data.json.gz", size: 1_370_489_367, generation: "1762155931000000"},
		{name: "b_example-project_data.json.gz", size: 12, generation: "34"},
	]);
	assert.throws(() => parseListing('[{"name": "a", "size": "big", "generation": "1"}]'), /size/u);
});

test("deleteUrl targets one exact generation through the Storage JSON API", () => {
	assert.equal(
		deleteUrl("example-backups", dump("2026-08-02T04:18:00Z")),
		"https://storage.googleapis.com/storage/v1/b/example-backups/o/2026-08-02T04%3A18%3A00Z_example-project_data.json.gz?ifGenerationMatch=g-2026-08-02T04%3A18%3A00Z",
	);
});

test("buildBriefing reports counts, bytes freed, and anything unverified", () => {
	const outcome = {
		dryRun: false,
		missingConfig: [] as string[],
		nasMounted: true,
		copied: ["c1", "c2"],
		deleted: ["d1"],
		bytesFreed: 1_370_489_367,
		kept: 40,
		unverified: [] as {name: string; reason: string}[],
		failures: [] as string[],
	};
	assert.deepStrictEqual(buildBriefing(outcome), {
		task: "factorio-backups-prune",
		status: "ready",
		lines: ["🗄️ Factorio backups: copied 2 to the NAS, deleted 1 from the bucket (1.28 GiB freed), 40 kept"],
		autoApplied: ["Copied c1 to the NAS", "Copied c2 to the NAS", "Deleted d1 from the bucket"],
	});

	assert.deepStrictEqual(buildBriefing({...outcome, copied: [], deleted: [], bytesFreed: 0}), {
		task: "factorio-backups-prune",
		status: "empty",
		lines: ["🗄️ Factorio backups: nothing to copy or prune, 40 kept"],
		autoApplied: [],
	});

	assert.deepStrictEqual(
		buildBriefing({
			...outcome,
			copied: [],
			unverified: [{name: "u1", reason: "missing on the NAS"}],
			failures: ["copy of u1 failed: boom"],
		}),
		{
			task: "factorio-backups-prune",
			status: "error",
			lines: [
				"🗄️ Factorio backups: copied 0 to the NAS, deleted 1 from the bucket (1.28 GiB freed), 40 kept",
				"⚠️ Factorio backup not verified on the NAS, left in the bucket: u1 (missing on the NAS)",
				"⚠️ Factorio backups prune: copy of u1 failed: boom",
			],
			autoApplied: ["Deleted d1 from the bucket"],
		},
	);
});

test("buildBriefing treats an unmounted NAS as a successful no-op and a dry run as a preview", () => {
	const idle = {
		dryRun: false,
		missingConfig: [] as string[],
		nasMounted: false,
		copied: [],
		deleted: [],
		bytesFreed: 0,
		kept: 0,
		unverified: [],
		failures: [],
	};
	assert.deepStrictEqual(
		buildBriefing({...idle, missingConfig: ["factorioBackups.account", "factorioBackups.nasDir"]}),
		{
			task: "factorio-backups-prune",
			status: "empty",
			lines: [
				"🗄️ Factorio backups: not configured, nothing copied or pruned; set factorioBackups.account, factorioBackups.nasDir in .llm/gtd/config.json",
			],
			autoApplied: [],
		},
	);
	assert.deepStrictEqual(buildBriefing(idle), {
		task: "factorio-backups-prune",
		status: "empty",
		lines: ["🗄️ Factorio backups: NAS not mounted, nothing copied or pruned"],
		autoApplied: [],
	});

	assert.deepStrictEqual(
		buildBriefing({
			...idle,
			dryRun: true,
			nasMounted: true,
			copied: ["c1"],
			deleted: ["d1"],
			bytesFreed: 2048,
			kept: 3,
		}),
		{
			task: "factorio-backups-prune",
			status: "ready",
			lines: [
				"🗄️ Factorio backups (dry run): would copy 1 to the NAS, would delete 1 from the bucket (0.00 GiB freed), 3 kept",
			],
			autoApplied: [],
		},
	);
});

test("readBackupConfig reads factorioBackups from the gtd config and names every missing key", () => {
	const factorioBackups = {
		bucket: "example-backups",
		project: "example-project",
		account: "owner@example.com",
		nasDir: "/Volumes/Archive/backups",
	};
	assert.deepStrictEqual(readBackupConfig({projectsDirectory: "/p", factorioBackups}), {
		settings: factorioBackups,
		missing: [],
	});
	assert.deepStrictEqual(readBackupConfig({factorioBackups: {bucket: "example-backups", project: "", account: 7}}), {
		settings: null,
		missing: ["factorioBackups.project", "factorioBackups.account", "factorioBackups.nasDir"],
	});
	const everyKey = [
		"factorioBackups.bucket",
		"factorioBackups.project",
		"factorioBackups.account",
		"factorioBackups.nasDir",
	];
	assert.deepStrictEqual(readBackupConfig({projectsDirectory: "/p"}), {settings: null, missing: everyKey});
	assert.deepStrictEqual(readBackupConfig(null), {settings: null, missing: everyKey});
});
