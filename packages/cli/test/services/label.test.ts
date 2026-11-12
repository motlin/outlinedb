import {describe, expect, it, afterEach, beforeEach} from "vite-plus/test";
import {
	precisionRecallAt,
	sampleStratified,
	shortlistRecall,
	stripLabels,
	thresholdForPrecision,
} from "../../src/services/label-eval.js";
import type {EvalCase} from "../../src/services/label-eval.js";
import {buildLabelPool, WORKFLOW_TAGS} from "../../src/services/label-pool.js";
import type {RegistryNode} from "../../src/services/label-pool.js";
import {nodeContent, nodeLabelSuggestions} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {asc} from "drizzle-orm";
import {entriesToScore, saveLabelSuggestions} from "../../src/services/label-suggestions.js";
import {cleanupTestDatabase, createInMemoryTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";

describe("label eval", () => {
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
});

describe("label pool", () => {
	const people: RegistryNode = {
		name: "👥 People",
		children: [
			{
				name: "🤝 Friends",
				children: [
					{
						name: "Book club",
						children: [
							{
								name: "@AliceBrown",
								children: [
									{
										name: '👥 Relationship: book club friend <a href="https://workflowy.com/#/aaaaaaaaaaaa">↗</a>',
									},
									{name: "📞 Phone: (555) 555-0100"},
								],
							},
						],
					},
					{name: "@Bob", children: [{name: "👥 Relationship: neighbor"}]},
				],
			},
			{
				name: "💼 Work",
				children: [
					{
						name: "@AliceChen",
						children: [
							{
								name: "👥 Relationship: coworker on the platform team who sits next to me and runs the weekly standup",
							},
						],
					},
					// A mirror of @AliceBrown without children must not erase the original's description.
					{name: "@AliceBrown"},
				],
			},
		],
	};

	const hobbies: RegistryNode = {
		name: "🎮 Hobbies Registry",
		children: [
			{
				name: "🟢 Current",
				children: [
					{
						name: "#pickleball",
						children: [{name: "Emoji: 🏓"}, {name: "Paddle sport"}, {name: "Full name: Pickleball"}],
					},
					{
						name: "📺 #watched",
						children: [{name: "Logged TV / movie / screen viewing"}, {name: "Emoji: 📺"}],
					},
				],
			},
		],
	};

	const tagFrequency: Record<string, number> = {
		"#next-action": 1114,
		"#Avalon": 152,
		"#avalon": 62,
		"#home-repair": 9,
		"#pickleball": 5,
		"#rare": 2,
	};

	describe("buildLabelPool", () => {
		it("builds people and tag labels from the registries, excluding workflow tags, rare tags, and labels already on the entry", () => {
			expect(buildLabelPool({people, hobbies, tagFrequency, entryLabels: ["@bob"]})).toStrictEqual([
				{
					optionId: "p.AliceBrown",
					label: "@AliceBrown",
					kind: "person",
					description: "Alice Brown, book club friend",
				},
				{
					optionId: "p.AliceChen",
					label: "@AliceChen",
					kind: "person",
					description: "Alice Chen, coworker on the platform team who sits next to me",
				},
				{optionId: "t.pickleball", label: "#pickleball", kind: "tag", description: "Pickleball"},
				{
					optionId: "t.watched",
					label: "#watched",
					kind: "tag",
					description: "Logged TV / movie / screen viewing",
				},
				{optionId: "t.Avalon", label: "#Avalon", kind: "tag", description: "Avalon"},
				{optionId: "t.home-repair", label: "#home-repair", kind: "tag", description: "home repair"},
			]);
		});

		it("drops entry labels case-insensitively and honours a custom minimum tag count", () => {
			expect(
				buildLabelPool({
					people: {name: "👥 People"},
					hobbies: {name: "🎮 Hobbies Registry"},
					tagFrequency,
					entryLabels: ["#AVALON"],
					minTagCount: 1,
				}),
			).toStrictEqual([
				{optionId: "t.home-repair", label: "#home-repair", kind: "tag", description: "home repair"},
				{optionId: "t.pickleball", label: "#pickleball", kind: "tag", description: "pickleball"},
				{optionId: "t.rare", label: "#rare", kind: "tag", description: "rare"},
			]);
		});

		it("folds person hints into descriptions under a raised word cap, leaving people without hints and tags unchanged", () => {
			expect(
				buildLabelPool({
					people,
					hobbies: {name: "🎮 Hobbies Registry"},
					tagFrequency: {"#home-repair": 9},
					entryLabels: [],
					personHints: new Map([
						["@alicebrown", ["Alise", "Alice (book club)"]],
						["@carol", ["Caro"]],
					]),
					personDescriptionWords: 14,
				}),
			).toStrictEqual([
				{
					optionId: "p.AliceBrown",
					label: "@AliceBrown",
					kind: "person",
					description: "Alice Brown, book club friend; text may say Alise, Alice (book club)",
				},
				{optionId: "p.Bob", label: "@Bob", kind: "person", description: "Bob, neighbor"},
				{
					optionId: "p.AliceChen",
					label: "@AliceChen",
					kind: "person",
					description: "Alice Chen, coworker on the platform team who sits next to me and runs",
				},
				{optionId: "t.home-repair", label: "#home-repair", kind: "tag", description: "home repair"},
			]);
		});

		it("excludes workflow and GTD context tags even when they appear in the hobby registry", () => {
			expect(
				buildLabelPool({
					people: {name: "👥 People"},
					hobbies: {name: "🎮 Hobbies Registry", children: [{name: "#next-action"}, {name: "#Meeting"}]},
					tagFrequency: {"#llm-task": 40, "#home": 42, "#deep-work": 26},
					entryLabels: [],
				}),
			).toStrictEqual([]);
		});

		it("lists the workflow tags that are never content labels", () => {
			expect([...WORKFLOW_TAGS].toSorted()).toStrictEqual([
				"#agenda",
				"#anywhere",
				"#buy",
				"#call",
				"#deep-work",
				"#discuss",
				"#document",
				"#drafts",
				"#email",
				"#errands",
				"#high",
				"#home",
				"#llm-task",
				"#low",
				"#low-energy",
				"#medium",
				"#meeting",
				"#next",
				"#next-action",
				"#plan",
				"#read",
				"#someday",
				"#soon",
			]);
		});
	});
});

describe("label suggestions", () => {
	const ENTRY = "entry-1";
	const OTHER = "entry-2";
	const EDITED_AT = "2026-11-03 21:14:02.000";
	const FIRST_RUN = "2026-11-04 06:00:11.000";
	const SECOND_RUN = "2026-11-05 06:00:11.000";

	describe("label suggestions persistence", () => {
		let testDatabase: TestDatabase;

		beforeEach(() => {
			testDatabase = createInMemoryTestDatabase();
			testDatabase.db
				.insert(nodeContent)
				.values([
					{
						id: ENTRY,
						name: "Played pickleball with Alice",
						note: null,
						parentId: "day",
						systemFrom: EDITED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
					{
						id: OTHER,
						name: "Dentist",
						note: null,
						parentId: "day",
						systemFrom: EDITED_AT,
						systemTo: FAR_FUTURE_DATE,
					},
				])
				.run();
		});

		afterEach(() => {
			cleanupTestDatabase(testDatabase);
		});

		function allRows() {
			return testDatabase.db
				.select()
				.from(nodeLabelSuggestions)
				.orderBy(
					asc(nodeLabelSuggestions.systemFrom),
					asc(nodeLabelSuggestions.source),
					asc(nodeLabelSuggestions.label),
				)
				.all();
		}

		it("writes one live row per label and source, stamped with the content version it scored", () => {
			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: ENTRY, contentFrom: EDITED_AT},
				[
					{label: "#pickleball", kind: "tag", source: "clef-flash-shortlist", score: 0.62},
					{label: "#pickleball", kind: "tag", source: "clef-flash", score: 0.98},
				],
				FIRST_RUN,
			);

			expect(allRows()).toStrictEqual([
				{
					nodeId: ENTRY,
					label: "#pickleball",
					labelKind: "tag",
					source: "clef-flash",
					score: 0.98,
					contentFrom: EDITED_AT,
					systemFrom: FIRST_RUN,
					systemTo: FAR_FUTURE_DATE,
				},
				{
					nodeId: ENTRY,
					label: "#pickleball",
					labelKind: "tag",
					source: "clef-flash-shortlist",
					score: 0.62,
					contentFrom: EDITED_AT,
					systemFrom: FIRST_RUN,
					systemTo: FAR_FUTURE_DATE,
				},
			]);
		});

		it("re-scoring closes every live row of that entry and inserts the new scores, leaving other entries alone", () => {
			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: ENTRY, contentFrom: EDITED_AT},
				[
					{label: "#pickleball", kind: "tag", source: "clef-flash", score: 0.98},
					{label: "@AliceChen", kind: "person", source: "clef-flash", score: 0.07},
				],
				FIRST_RUN,
			);
			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: OTHER, contentFrom: EDITED_AT},
				[{label: "#health", kind: "tag", source: "clef-flash", score: 0.9}],
				FIRST_RUN,
			);

			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: ENTRY, contentFrom: EDITED_AT},
				[{label: "#pickleball", kind: "tag", source: "clef", score: 0.95}],
				SECOND_RUN,
			);

			expect(allRows()).toStrictEqual([
				{
					nodeId: OTHER,
					label: "#health",
					labelKind: "tag",
					source: "clef-flash",
					score: 0.9,
					contentFrom: EDITED_AT,
					systemFrom: FIRST_RUN,
					systemTo: FAR_FUTURE_DATE,
				},
				{
					nodeId: ENTRY,
					label: "#pickleball",
					labelKind: "tag",
					source: "clef-flash",
					score: 0.98,
					contentFrom: EDITED_AT,
					systemFrom: FIRST_RUN,
					systemTo: SECOND_RUN,
				},
				{
					nodeId: ENTRY,
					label: "@AliceChen",
					labelKind: "person",
					source: "clef-flash",
					score: 0.07,
					contentFrom: EDITED_AT,
					systemFrom: FIRST_RUN,
					systemTo: SECOND_RUN,
				},
				{
					nodeId: ENTRY,
					label: "#pickleball",
					labelKind: "tag",
					source: "clef",
					score: 0.95,
					contentFrom: EDITED_AT,
					systemFrom: SECOND_RUN,
					systemTo: FAR_FUTURE_DATE,
				},
			]);
		});

		it("needs scoring for entries never scored and entries edited since their live scores, skipping fresh ones", () => {
			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: ENTRY, contentFrom: EDITED_AT},
				[{label: "#pickleball", kind: "tag", source: "clef-flash", score: 0.98}],
				FIRST_RUN,
			);

			expect(entriesToScore(testDatabase.db, [ENTRY, OTHER, "missing"], {force: false})).toStrictEqual([
				{nodeId: OTHER, contentFrom: EDITED_AT},
			]);
		});

		it("treats live rows as stale once node_content.system_from moves past their content_from", () => {
			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: ENTRY, contentFrom: EDITED_AT},
				[{label: "#pickleball", kind: "tag", source: "clef-flash", score: 0.98}],
				FIRST_RUN,
			);
			const reEditedAt = "2026-11-04 20:00:00.000";
			testDatabase.sqlite
				.prepare("UPDATE node_content SET system_to = ? WHERE id = ? AND system_to = ?")
				.run(reEditedAt, ENTRY, FAR_FUTURE_DATE);
			testDatabase.db
				.insert(nodeContent)
				.values({
					id: ENTRY,
					name: "Played pickleball with Alice and Bob",
					note: null,
					parentId: "day",
					systemFrom: reEditedAt,
					systemTo: FAR_FUTURE_DATE,
				})
				.run();

			expect(entriesToScore(testDatabase.db, [ENTRY], {force: false})).toStrictEqual([
				{nodeId: ENTRY, contentFrom: reEditedAt},
			]);
		});

		it("an entry whose only scores are closed needs scoring again", () => {
			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: ENTRY, contentFrom: EDITED_AT},
				[{label: "#pickleball", kind: "tag", source: "clef-flash", score: 0.98}],
				FIRST_RUN,
			);
			saveLabelSuggestions(testDatabase.db, {nodeId: ENTRY, contentFrom: EDITED_AT}, [], SECOND_RUN);

			expect(entriesToScore(testDatabase.db, [ENTRY], {force: false})).toStrictEqual([
				{nodeId: ENTRY, contentFrom: EDITED_AT},
			]);
		});

		it("--force rescoring returns fresh entries too, in the order asked", () => {
			saveLabelSuggestions(
				testDatabase.db,
				{nodeId: ENTRY, contentFrom: EDITED_AT},
				[{label: "#pickleball", kind: "tag", source: "clef-flash", score: 0.98}],
				FIRST_RUN,
			);

			expect(entriesToScore(testDatabase.db, [OTHER, ENTRY, "missing"], {force: true})).toStrictEqual([
				{nodeId: OTHER, contentFrom: EDITED_AT},
				{nodeId: ENTRY, contentFrom: EDITED_AT},
			]);
		});
	});
});
