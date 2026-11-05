import {findCalendarRoot} from "@workflowy/shared/calendar-lookup";
import {resolveIdOrShortId} from "@workflowy/shared/utils";
import {Command, Flags} from "@oclif/core";
import path from "node:path";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {clefClientFromEnv, readLabelRegistries} from "../../services/clef-setup.js";
import {ARM_MODELS, EVAL_ARMS, buildEvalReport, sampleStratified, stripLabels} from "../../services/label-eval.js";
import type {EvalReport, EvalRun} from "../../services/label-eval.js";
import {buildLabelPool} from "../../services/label-pool.js";
import {
	calendarEntriesSince,
	entryState,
	parseYearMonth,
	runShortlist,
	runVerify,
} from "../../services/suggest-labels.js";

export default class EvalLabels extends Command {
	static override description =
		"Measure Clef label suggestions on held-out tagged journal entries: strip each sampled entry's @mentions (to first names) and #tags, run the Clef-flash shortlist once and each arm's verify pass, and report shortlist recall, precision/recall per threshold, the threshold reaching the target precision, latency and cost from usage.input_tokens, per arm and label kind";

	static override examples = [
		"op run -- <%= config.bin %> <%= command.id %> --sample 500 --since 2025-01 --arms flash,clef --json",
	];

	static override flags = {
		sample: Flags.integer({
			description: "Entries to evaluate, split between people and tags",
			default: 500,
			min: 1,
		}),
		since: Flags.string({
			description: "Earliest calendar month to sample from (YYYY-MM)",
			default: "2025-01",
			parse: async (input) => parseYearMonth(input, "--since").then(() => input),
		}),
		arms: Flags.option({
			description: "Verify-pass models to compare: flash is Clef-flash, clef is full Clef",
			options: EVAL_ARMS,
			multiple: true,
			delimiter: ",",
			default: ["flash"],
		})(),
		thresholds: Flags.string({
			description: "Comma-separated verify-score thresholds to report precision and recall at",
			default: "0.5,0.6,0.7,0.8,0.9,0.95",
		}),
		"target-precision": Flags.custom<number>({
			description: "Report the lowest threshold whose precision reaches this",
			default: 0.9,
			parse: async (input) => probability(input, "--target-precision"),
		})(),
		seed: Flags.integer({description: "Sampling seed", default: 1}),
		"calendar-id": Flags.string({description: "Calendar root (full or short id); defaults to 📆 Calendar"}),
		"metadata-dir": Flags.string({
			description: "Directory holding people.json, hobbies-registry.json and tag-frequency.json",
			default: path.join(".llm", "gtd", "metadata"),
		}),
		json: Flags.boolean({char: "j", description: "Output the report as JSON", default: false}),
	};

	public async run(): Promise<EvalReport> {
		const {flags} = await this.parse(EvalLabels);
		const client = clefClientFromEnv();
		if ("error" in client) {
			this.error(client.error, {exit: 1});
		}
		const thresholds = await Promise.all(
			flags.thresholds.split(",").map(async (value) => probability(value.trim(), "--thresholds")),
		);
		const since = await parseYearMonth(flags.since, "--since");

		const registries = readLabelRegistries(flags["metadata-dir"]);
		const pool = buildLabelPool({...registries, entryLabels: []});
		const poolLabels = new Map(pool.map((label) => [label.label.toLowerCase(), label]));

		const database = createDatabase();
		const cache = new CacheService(database);
		const rootId =
			flags["calendar-id"] === undefined
				? findCalendarRoot({db: database, cache})
				: resolveIdOrShortId(flags["calendar-id"], cache);
		if (rootId === undefined) {
			this.error("No 📆 Calendar root in the cache: pass --calendar-id", {exit: 1});
		}

		const candidates = calendarEntriesSince(cache, rootId, since).flatMap((nodeId) => {
			const {state} = entryState(cache, nodeId);
			const {text, labels} = stripLabels(state.entry);
			const truth = labels.filter(({label}) => poolLabels.has(label.toLowerCase()));
			return truth.length === 0 ? [] : [{state: {...state, entry: text}, truth}];
		});
		const sample = sampleStratified(candidates, {
			size: flags.sample,
			seed: flags.seed,
			stratum: ({truth}) => (truth.some(({kind}) => kind === "person") ? "person" : "tag"),
		});

		const arms = flags.arms.map((arm) => ({arm, model: ARM_MODELS[arm]}));
		const runs: EvalRun[] = [];
		for (const {state, truth} of sample) {
			const shortlist = await timed(async () => runShortlist(client, pool, state));
			const verify: EvalRun["verify"] = {};
			for (const {arm, model} of arms) {
				verify[arm] = await timed(async () => runVerify(client, shortlist.result.value, state, model));
			}
			runs.push({truth, shortlist, verify});
		}

		const report = buildEvalReport(runs, {
			since: flags.since,
			seed: flags.seed,
			targetPrecision: flags["target-precision"],
			thresholds,
			arms,
		});
		if (flags.json) {
			this.log(JSON.stringify(report, null, 2));
		} else {
			this.logSummary(report);
		}
		return report;
	}

	private logSummary(report: EvalReport): void {
		const {shortlist} = report;
		this.log(`${report.entries} entries since ${report.since} (seed ${report.seed})`);
		this.log(
			`shortlist (${shortlist.model}): people recall ${pct(shortlist.person.recall)} (mean ${shortlist.person.meanSize.toFixed(1)}), tags recall ${pct(shortlist.tag.recall)} (mean ${shortlist.tag.meanSize.toFixed(1)}), p50 ${shortlist.latencyMs.p50}ms`,
		);
		for (const arm of report.arms) {
			for (const kind of ["person", "tag"] as const) {
				const target = arm[kind].atTargetPrecision;
				const reached =
					target === null
						? `never reaches ${pct(report.targetPrecision)} precision`
						: `${pct(target.precision)} precision at ${target.threshold} with ${pct(target.recall)} recall`;
				this.log(`${arm.arm} ${kind}: ${reached}`);
			}
			this.log(`${arm.arm}: $${arm.costPer100Entries} per 100 entries, verify p50 ${arm.latencyMs.p50}ms`);
		}
	}
}

async function probability(input: string, flag: string): Promise<number> {
	const value = Number(input);
	return Number.isFinite(value) && value >= 0 && value <= 1
		? Promise.resolve(value)
		: Promise.reject(new Error(`${flag} must be a number from 0 to 1, got "${input}"`));
}

async function timed<T>(work: () => Promise<T>): Promise<{result: T; ms: number}> {
	const start = performance.now();
	const result = await work();
	return {result, ms: performance.now() - start};
}

function pct(value: number): string {
	return `${(value * 100).toFixed(0)}%`;
}
