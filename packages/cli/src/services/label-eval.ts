import {findTags} from "@workflowy/shared/tags";
import type {ClefModel, ShortlistEntry} from "./clef-requests.js";
import type {LabelKind} from "./label-pool.js";
import type {PassResult} from "./suggest-labels.js";

export interface KindedLabel {
	/** Canonical `@Name` or `#tag`; compared case-insensitively. */
	readonly label: string;
	readonly kind: LabelKind;
}

export interface ScoredLabel extends KindedLabel {
	/** Pass 2 verify probability. */
	readonly score: number;
}

/** One held-out entry: its true labels and what the two Clef passes returned for its stripped text. */
export interface EvalCase {
	readonly truth: readonly KindedLabel[];
	readonly shortlist: readonly KindedLabel[];
	readonly verify: readonly ScoredLabel[];
}

export interface PrecisionRecall {
	readonly threshold: number;
	readonly truePositives: number;
	readonly predicted: number;
	readonly actual: number;
	/** 1 when nothing is predicted: no prediction is a false positive. */
	readonly precision: number;
	readonly recall: number;
}

/**
 * Hides an entry's ground truth from Clef: each `@mention` becomes the person's first name (`@AliceBrown` → `Alice`)
 * and each `#tag` is removed. Returns the stripped text and the removed labels.
 */
export function stripLabels(entry: string): {text: string; labels: KindedLabel[]} {
	const labels: KindedLabel[] = [];
	let text = "";
	let cursor = 0;
	for (const {index, tag} of findTags(entry)) {
		const kind: LabelKind = tag.startsWith("@") ? "person" : "tag";
		labels.push({label: tag, kind});
		text += entry.slice(cursor, index) + (kind === "person" ? firstName(tag) : "");
		cursor = index + tag.length;
	}
	text += entry.slice(cursor);
	return {
		text: text
			.replaceAll(/\s+/gu, " ")
			.replaceAll(/ (?=[),.!?;:])/gu, "")
			.trim(),
		labels,
	};
}

function firstName(mention: string): string {
	return (
		mention
			.slice(1)
			.replaceAll(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
			.split(/[\s_-]/u)[0] ?? ""
	);
}

/**
 * Draws a seeded, deterministic sample of up to `size` items, split evenly between the person and tag strata; a
 * stratum that runs short is topped up from the other. People come first, then tags.
 */
export function sampleStratified<T>(
	items: readonly T[],
	{size, seed, stratum}: {size: number; seed: number; stratum: (item: T) => LabelKind},
): T[] {
	const random = mulberry32(seed);
	const people = shuffle(
		items.filter((item) => stratum(item) === "person"),
		random,
	);
	const tags = shuffle(
		items.filter((item) => stratum(item) === "tag"),
		random,
	);
	const personQuota = Math.min(people.length, Math.max(Math.ceil(size / 2), size - tags.length));
	const tagQuota = Math.min(tags.length, size - personQuota);
	return [...people.slice(0, personQuota), ...tags.slice(0, tagQuota)];
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d_2b_79_f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
	return items
		.map((item) => ({item, key: random()}))
		.toSorted((a, b) => a.key - b.key)
		.map(({item}) => item);
}

/** Share of `kind` true labels that reach the pass 1 shortlist, and the mean number of `kind` shortlist labels. */
export function shortlistRecall(cases: readonly EvalCase[], kind: LabelKind): {recall: number; meanSize: number} {
	let actual = 0;
	let found = 0;
	let shortlisted = 0;
	for (const {truth, shortlist} of cases) {
		const keys = labelKeys(shortlist, kind);
		shortlisted += keys.size;
		for (const key of labelKeys(truth, kind)) {
			actual++;
			if (keys.has(key)) {
				found++;
			}
		}
	}
	return {recall: ratio(found, actual, 1), meanSize: ratio(shortlisted, cases.length, 0)};
}

/** Pass 2 precision and recall for `kind`: verify scores at or above `threshold` are predictions. */
export function precisionRecallAt(cases: readonly EvalCase[], kind: LabelKind, threshold: number): PrecisionRecall {
	let truePositives = 0;
	let predicted = 0;
	let actual = 0;
	for (const {truth, verify} of cases) {
		const truthKeys = labelKeys(truth, kind);
		actual += truthKeys.size;
		const predictedKeys = labelKeys(
			verify.filter(({score}) => score >= threshold),
			kind,
		);
		predicted += predictedKeys.size;
		truePositives += [...predictedKeys].filter((key) => truthKeys.has(key)).length;
	}
	return {
		threshold,
		truePositives,
		predicted,
		actual,
		precision: ratio(truePositives, predicted, 1),
		recall: ratio(truePositives, actual, 0),
	};
}

/** The lowest observed `kind` verify score whose precision meets `target`, or undefined if none does. */
export function thresholdForPrecision(
	cases: readonly EvalCase[],
	kind: LabelKind,
	target: number,
): PrecisionRecall | undefined {
	const scores = new Set(
		cases.flatMap(({verify}) => verify.filter((label) => label.kind === kind).map(({score}) => score)),
	);
	for (const threshold of [...scores].toSorted((a, b) => a - b)) {
		const result = precisionRecallAt(cases, kind, threshold);
		if (result.precision >= target) {
			return result;
		}
	}
	return undefined;
}

function labelKeys(labels: readonly KindedLabel[], kind: LabelKind): Set<string> {
	return new Set(labels.filter((label) => label.kind === kind).map(({label}) => label.toLowerCase()));
}

function ratio(numerator: number, denominator: number, empty: number): number {
	return denominator === 0 ? empty : numerator / denominator;
}

/** A verify-pass arm of the eval and the Clef model it runs. */
export const EVAL_ARMS = ["flash", "clef"] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];
export const ARM_MODELS: Readonly<Record<EvalArm, ClefModel>> = {flash: "clef-flash", clef: "clef"};

/** US dollars per 1M input tokens; output tokens are free. */
const PRICE_PER_MILLION: Readonly<Record<ClefModel, number>> = {"clef-flash": 0.038, clef: 0.24};

/** A pass's Clef results for one entry, and how long its requests took. */
export interface TimedPass<T> {
	readonly result: PassResult<T>;
	readonly ms: number;
}

/** One sampled entry: its true labels and the shortlist and per-arm verify passes run on its stripped text. */
export interface EvalRun {
	readonly truth: readonly KindedLabel[];
	readonly shortlist: TimedPass<readonly ShortlistEntry[]>;
	verify: Partial<Record<EvalArm, TimedPass<readonly ScoredLabel[]>>>;
}

export interface UsageReport {
	readonly requests: number;
	readonly inputTokens: number;
	readonly inputTokensPerEntry: number;
	readonly costPer100Entries: number;
}

export interface LatencyReport {
	readonly p50: number;
	readonly p95: number;
}

export interface KindReport {
	readonly thresholds: PrecisionRecall[];
	readonly atTargetPrecision: PrecisionRecall | null;
}

export interface EvalReport {
	readonly entries: number;
	readonly since: string;
	readonly seed: number;
	readonly targetPrecision: number;
	readonly shortlist: {
		readonly model: ClefModel;
		readonly person: {recall: number; meanSize: number};
		readonly tag: {recall: number; meanSize: number};
		readonly usage: UsageReport;
		readonly latencyMs: LatencyReport;
	};
	readonly arms: {
		readonly arm: EvalArm;
		readonly model: ClefModel;
		readonly person: KindReport;
		readonly tag: KindReport;
		readonly usage: UsageReport;
		readonly latencyMs: LatencyReport;
		/** Shortlist plus this arm's verify pass, in US dollars. */
		readonly costPer100Entries: number;
	}[];
}

/** Aggregates eval runs into the per-arm, per-label-kind report; cost comes from `usage.input_tokens`. Pure. */
export function buildEvalReport(
	runs: readonly EvalRun[],
	options: {
		since: string;
		seed: number;
		targetPrecision: number;
		thresholds: readonly number[];
		arms: readonly {arm: EvalArm; model: ClefModel}[];
	},
): EvalReport {
	const shortlistPasses = runs.map(({shortlist}) => shortlist);
	const shortlistUsage = usageReport(shortlistPasses, runs.length, "clef-flash");
	const cases = (arm: EvalArm): EvalCase[] =>
		runs.map(({truth, shortlist, verify}) => ({
			truth,
			shortlist: shortlist.result.value.map(({label}) => label),
			verify: verify[arm]?.result.value ?? [],
		}));
	const kindReport = (armCases: readonly EvalCase[], kind: LabelKind): KindReport => ({
		thresholds: options.thresholds.map((threshold) => precisionRecallAt(armCases, kind, threshold)),
		atTargetPrecision: thresholdForPrecision(armCases, kind, options.targetPrecision) ?? null,
	});
	const shortlistCases = cases(options.arms[0]?.arm ?? "flash");

	return {
		entries: runs.length,
		since: options.since,
		seed: options.seed,
		targetPrecision: options.targetPrecision,
		shortlist: {
			model: "clef-flash",
			person: shortlistRecall(shortlistCases, "person"),
			tag: shortlistRecall(shortlistCases, "tag"),
			usage: shortlistUsage,
			latencyMs: latencyReport(shortlistPasses),
		},
		arms: options.arms.map(({arm, model}) => {
			const armCases = cases(arm);
			const passes = runs.flatMap(({verify}) => verify[arm] ?? []);
			const usage = usageReport(passes, runs.length, model);
			return {
				arm,
				model,
				person: kindReport(armCases, "person"),
				tag: kindReport(armCases, "tag"),
				usage,
				latencyMs: latencyReport(passes),
				costPer100Entries: dollars(shortlistUsage.costPer100Entries + usage.costPer100Entries),
			};
		}),
	};
}

function usageReport(passes: readonly TimedPass<unknown>[], entries: number, model: ClefModel): UsageReport {
	const requests = passes.reduce((sum, {result}) => sum + result.requests, 0);
	const inputTokens = passes.reduce((sum, {result}) => sum + result.inputTokens, 0);
	const inputTokensPerEntry = ratio(inputTokens, entries, 0);
	return {
		requests,
		inputTokens,
		inputTokensPerEntry,
		costPer100Entries: dollars((inputTokensPerEntry * 100 * PRICE_PER_MILLION[model]) / 1_000_000),
	};
}

/** Nearest-rank percentiles of the per-entry pass durations. */
function latencyReport(passes: readonly TimedPass<unknown>[]): LatencyReport {
	const sorted = passes.map(({ms}) => ms).toSorted((a, b) => a - b);
	const percentile = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
	return {p50: percentile(0.5), p95: percentile(0.95)};
}

/** Rounds to a millionth of a dollar, hiding floating-point noise. */
function dollars(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
