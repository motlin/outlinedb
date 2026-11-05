import {describe, expect, it} from "vite-plus/test";
import {buildLabelPool, WORKFLOW_TAGS} from "../../src/services/label-pool.js";
import type {RegistryNode} from "../../src/services/label-pool.js";

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
				{name: "📺 #watched", children: [{name: "Logged TV / movie / screen viewing"}, {name: "Emoji: 📺"}]},
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
