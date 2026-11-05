import {describe, expect, it} from "vite-plus/test";
import {
	precisionRecallAt,
	sampleStratified,
	shortlistRecall,
	stripLabels,
	thresholdForPrecision,
} from "../../src/services/label-eval.js";
import type {EvalCase} from "../../src/services/label-eval.js";

describe("stripLabels", () => {
	it("replaces mentions with the first name, drops tags, and returns the labels as ground truth", () => {
		expect(stripLabels("@AliceBrown went to #pickleball with @Bob.")).toStrictEqual({
			text: "Alice went to with Bob.",
			labels: [
				{label: "@AliceBrown", kind: "person"},
				{label: "#pickleball", kind: "tag"},
				{label: "@Bob", kind: "person"},
			],
		});
	});

	it("tidies the whitespace a removed trailing tag leaves behind", () => {
		expect(stripLabels("Dinner with @AliceChen #restaurant, then home #family")).toStrictEqual({
			text: "Dinner with Alice, then home",
			labels: [
				{label: "@AliceChen", kind: "person"},
				{label: "#restaurant", kind: "tag"},
				{label: "#family", kind: "tag"},
			],
		});
	});

	it("leaves untagged text alone", () => {
		expect(stripLabels("Dentist at 3pm")).toStrictEqual({text: "Dentist at 3pm", labels: []});
	});

	it("keeps each tag's word as plain text in word mode, still hiding the tag itself", () => {
		expect(stripLabels("#fasting day 1 with @AliceBrown, then #bike-ride", {tags: "word"})).toStrictEqual({
			text: "fasting day 1 with Alice, then bike ride",
			labels: [
				{label: "#fasting", kind: "tag"},
				{label: "@AliceBrown", kind: "person"},
				{label: "#bike-ride", kind: "tag"},
			],
		});
	});
});

describe("sampleStratified", () => {
	const items = [
		{id: "p1", kind: "person"},
		{id: "p2", kind: "person"},
		{id: "p3", kind: "person"},
		{id: "p4", kind: "person"},
		{id: "t1", kind: "tag"},
		{id: "t2", kind: "tag"},
		{id: "t3", kind: "tag"},
	] as const;
	const stratum = (item: (typeof items)[number]) => item.kind;

	it("is deterministic for a seed and splits the sample evenly between people and tags", () => {
		const first = sampleStratified(items, {size: 4, seed: 42, stratum}).map(({id}) => id);
		const second = sampleStratified(items, {size: 4, seed: 42, stratum}).map(({id}) => id);

		expect(second).toStrictEqual(first);
		expect(first.filter((id) => id.startsWith("p"))).toHaveLength(2);
		expect(first.filter((id) => id.startsWith("t"))).toHaveLength(2);
	});

	it("draws a different sample for a different seed", () => {
		const samples = new Set(
			[1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
				sampleStratified(items, {size: 4, seed, stratum})
					.map(({id}) => id)
					.join(","),
			),
		);

		expect(samples.size).toBeGreaterThan(1);
	});

	it("fills from the other stratum when one runs short, and caps at the population", () => {
		const fewTags = items.filter(({id}) => id !== "t2" && id !== "t3");

		const sample = sampleStratified(fewTags, {size: 4, seed: 7, stratum}).map(({id}) => id);
		expect(sample.filter((id) => id.startsWith("p"))).toHaveLength(3);
		expect(sample.filter((id) => id.startsWith("t"))).toStrictEqual(["t1"]);

		expect(
			sampleStratified(items, {size: 99, seed: 7, stratum})
				.map(({id}) => id)
				.toSorted(),
		).toStrictEqual(["p1", "p2", "p3", "p4", "t1", "t2", "t3"]);
	});
});

// Two entries with known answers:
// - entry 1 truth: @AliceBrown, #pickleball. Shortlist: @AliceBrown, @AliceChen, #pickleball, #tennis.
//   Verify: @AliceBrown 0.9, @AliceChen 0.6, #pickleball 0.95, #tennis 0.3.
// - entry 2 truth: @Bob, #cooking. Shortlist: @AliceChen, #cooking (@Bob missed by pass 1).
//   Verify: @AliceChen 0.85, #cooking 0.7.
const cases: EvalCase[] = [
	{
		truth: [
			{label: "@AliceBrown", kind: "person"},
			{label: "#pickleball", kind: "tag"},
		],
		shortlist: [
			{label: "@AliceBrown", kind: "person"},
			{label: "@AliceChen", kind: "person"},
			{label: "#Pickleball", kind: "tag"},
			{label: "#tennis", kind: "tag"},
		],
		verify: [
			{label: "@AliceBrown", kind: "person", score: 0.9},
			{label: "@AliceChen", kind: "person", score: 0.6},
			{label: "#Pickleball", kind: "tag", score: 0.95},
			{label: "#tennis", kind: "tag", score: 0.3},
		],
	},
	{
		truth: [
			{label: "@Bob", kind: "person"},
			{label: "#cooking", kind: "tag"},
		],
		shortlist: [
			{label: "@AliceChen", kind: "person"},
			{label: "#cooking", kind: "tag"},
		],
		verify: [
			{label: "@AliceChen", kind: "person", score: 0.85},
			{label: "#cooking", kind: "tag", score: 0.7},
		],
	},
];

describe("shortlistRecall", () => {
	it("is the share of true labels that reach the shortlist, with the mean shortlist size, per kind", () => {
		expect(shortlistRecall(cases, "person")).toStrictEqual({recall: 0.5, meanSize: 1.5});
		expect(shortlistRecall(cases, "tag")).toStrictEqual({recall: 1, meanSize: 1.5});
	});
});

describe("precisionRecallAt", () => {
	it("counts verify scores at or above the threshold as predictions, against all true labels", () => {
		expect(precisionRecallAt(cases, "person", 0.8)).toStrictEqual({
			threshold: 0.8,
			truePositives: 1,
			predicted: 2,
			actual: 2,
			precision: 0.5,
			recall: 0.5,
		});
		expect(precisionRecallAt(cases, "tag", 0.7)).toStrictEqual({
			threshold: 0.7,
			truePositives: 2,
			predicted: 2,
			actual: 2,
			precision: 1,
			recall: 1,
		});
	});

	it("reports precision 1 when nothing clears the threshold", () => {
		expect(precisionRecallAt(cases, "tag", 0.99)).toStrictEqual({
			threshold: 0.99,
			truePositives: 0,
			predicted: 0,
			actual: 2,
			precision: 1,
			recall: 0,
		});
	});
});

describe("thresholdForPrecision", () => {
	it("picks the lowest observed score whose precision meets the target", () => {
		expect(thresholdForPrecision(cases, "person", 0.9)).toStrictEqual({
			threshold: 0.9,
			truePositives: 1,
			predicted: 1,
			actual: 2,
			precision: 1,
			recall: 0.5,
		});
		expect(thresholdForPrecision(cases, "tag", 0.9)).toStrictEqual({
			threshold: 0.7,
			truePositives: 2,
			predicted: 2,
			actual: 2,
			precision: 1,
			recall: 1,
		});
	});

	it("returns undefined when no threshold reaches the target", () => {
		const noisy: EvalCase[] = [
			{
				truth: [{label: "@Bob", kind: "person"}],
				shortlist: [{label: "@AliceChen", kind: "person"}],
				verify: [{label: "@AliceChen", kind: "person", score: 0.9}],
			},
		];

		expect(thresholdForPrecision(noisy, "person", 0.9)).toBeUndefined();
	});
});
