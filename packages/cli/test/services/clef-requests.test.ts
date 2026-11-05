import {describe, expect, it} from "vite-plus/test";
import {
	buildShortlistRequests,
	buildVerifyRequest,
	estimateTokens,
	selectShortlist,
} from "../../src/services/clef-requests.js";
import type {ClefState, ShortlistEntry} from "../../src/services/clef-requests.js";
import type {PoolLabel} from "../../src/services/label-pool.js";

const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/u;

const state: ClefState = {
	date: "2026-11-03",
	parent: "📅 Calendar > 2026 > November > Mon, Nov 3",
	entry: "Played pickleball with Alice and Bob after work",
};

const aliceBrown: PoolLabel = {
	optionId: "p.AliceBrown",
	label: "@AliceBrown",
	kind: "person",
	description: "Alice Brown, book club friend",
};
const aliceChen: PoolLabel = {
	optionId: "p.AliceChen",
	label: "@AliceChen",
	kind: "person",
	description: "Alice Chen, coworker",
};
const pickleball: PoolLabel = {optionId: "t.pickleball", label: "#pickleball", kind: "tag", description: "Pickleball"};
const watched: PoolLabel = {optionId: "t.watched", label: "#watched", kind: "tag", description: ""};

function people(count: number, descriptionLength = 10): PoolLabel[] {
	return Array.from({length: count}, (_, index) => ({
		optionId: `p.Person${index}`,
		label: `@Person${index}`,
		kind: "person" as const,
		description: "x".repeat(descriptionLength),
	}));
}

function tags(count: number): PoolLabel[] {
	return Array.from({length: count}, (_, index) => ({
		optionId: `t.tag${index}`,
		label: `#tag${index}`,
		kind: "tag" as const,
		description: `tag ${index}`,
	}));
}

describe("buildShortlistRequests", () => {
	it("builds one choice question per kind with a none option and the structured state", () => {
		expect(buildShortlistRequests(state, [aliceBrown, pickleball, aliceChen, watched])).toStrictEqual([
			{
				model: "clef-flash",
				state,
				questions: {
					"people.1": {
						type: "choice",
						instructions: "Which one of these people does this journal entry most likely involve?",
						criteria: {
							"p.AliceBrown": "Alice Brown, book club friend",
							"p.AliceChen": "Alice Chen, coworker",
							none: "None of these people",
						},
					},
					"tags.1": {
						type: "choice",
						instructions: "Which one of these tags best describes this journal entry?",
						criteria: {
							"t.pickleball": "Pickleball",
							"t.watched": null,
							none: "None of these tags",
						},
					},
				},
			},
		]);
	});

	it("returns no requests for an empty pool", () => {
		expect(buildShortlistRequests(state, [])).toStrictEqual([]);
	});

	it("shards each kind into at most 254 labels plus none", () => {
		const requests = buildShortlistRequests(state, [...people(600), ...tags(300)]);
		const shards = requests.flatMap((request) =>
			Object.entries(request.questions).map(([id, question]) => [id, Object.keys(question.criteria).length]),
		);
		expect(shards).toStrictEqual([
			["people.1", 255],
			["people.2", 255],
			["people.3", 93],
			["tags.1", 255],
			["tags.2", 47],
		]);
		expect(requests).toHaveLength(1);
	});

	it("splits shards over more requests when one request would pass the 20,000-token estimate", () => {
		const requests = buildShortlistRequests(state, [...people(1000, 60), ...tags(10)]);
		expect(requests.map((request) => Object.keys(request.questions))).toStrictEqual([
			["people.1", "people.2", "people.3"],
			["people.4", "tags.1"],
		]);
		expect(requests.map((request) => estimateTokens(request) <= 20_000)).toStrictEqual([true, true]);
		expect(requests.map((request) => request.state)).toStrictEqual([state, state]);
	});

	it("uses only valid question and option ids", () => {
		const ids = buildShortlistRequests(state, [aliceBrown, pickleball]).flatMap((request) =>
			Object.entries(request.questions).flatMap(([id, question]) => [id, ...Object.keys(question.criteria)]),
		);
		expect(ids.filter((id) => !QUESTION_ID.test(id))).toStrictEqual([]);
	});

	it("rejects a label whose option id is not a valid Clef id", () => {
		const bad: PoolLabel = {optionId: "p.@Bad Id", label: "@Bad", kind: "person", description: ""};
		expect(() => buildShortlistRequests(state, [bad])).toThrow("Invalid Clef id: p.@Bad Id");
	});
});

describe("selectShortlist", () => {
	it("takes the top 8 per shard plus any option at or above 0.05, minus none, best first", () => {
		const pool = [...people(12), pickleball, watched];
		const peopleProbabilities: Record<string, number> = {none: 0.3};
		const scores = [0.2, 0.1, 0.08, 0.07, 0.06, 0.055, 0.05, 0.04, 0.03, 0.002, 0.002, 0.001];
		for (const [index, score] of scores.entries()) {
			peopleProbabilities[`p.Person${index}`] = score;
		}
		const shortlist = selectShortlist(pool, {
			"people.1": {type: "choice", choice: "none", probabilities: peopleProbabilities, confidence: 0.3},
			"tags.1": {
				type: "choice",
				choice: "t.pickleball",
				probabilities: {"t.pickleball": 0.9, none: 0.06, "t.watched": 0.04},
				confidence: 0.9,
			},
		});
		expect(shortlist.map(({label, score}) => [label.label, score])).toStrictEqual([
			["#pickleball", 0.9],
			["@Person0", 0.2],
			["@Person1", 0.1],
			["@Person2", 0.08],
			["@Person3", 0.07],
			["@Person4", 0.06],
			["@Person5", 0.055],
			["@Person6", 0.05],
			["@Person7", 0.04],
			["#watched", 0.04],
		]);
	});

	it("keeps options at or above 0.05 beyond the top 8 and ignores unknown option ids", () => {
		const pool = people(10);
		const probabilities: Record<string, number> = {"p.Ghost": 0.5};
		for (const [index] of pool.entries()) {
			probabilities[`p.Person${index}`] = 0.05;
		}
		const shortlist = selectShortlist(pool, {
			"people.1": {type: "choice", choice: "p.Ghost", probabilities, confidence: 0.5},
		});
		expect(shortlist.map(({label}) => label.label)).toStrictEqual(pool.map(({label}) => label));
	});
});

describe("buildVerifyRequest", () => {
	it("builds one noul question per shortlisted label", () => {
		const shortlist: ShortlistEntry[] = [
			{label: pickleball, score: 0.62},
			{label: aliceBrown, score: 0.4},
			{label: watched, score: 0.1},
		];
		expect(buildVerifyRequest(state, shortlist)).toStrictEqual({
			model: "clef-flash",
			state,
			questions: {
				"t.pickleball": {
					type: "noul",
					instructions: "Does this journal entry describe doing #pickleball (Pickleball)?",
				},
				"p.AliceBrown": {
					type: "noul",
					instructions: "Does this journal entry involve @AliceBrown (Alice Brown, book club friend)?",
				},
				"t.watched": {type: "noul", instructions: "Does this journal entry describe doing #watched?"},
			},
		});
	});

	it("switches the model for the full Clef verifier", () => {
		expect(buildVerifyRequest(state, [{label: aliceChen, score: 0.3}], "clef").model).toBe("clef");
	});

	it("caps the questions at 64, keeping the highest-scoring labels", () => {
		const shortlist = people(70).map((label, index) => ({label, score: index / 100}));
		const ids = Object.keys(buildVerifyRequest(state, shortlist).questions);
		expect(ids).toStrictEqual(Array.from({length: 64}, (_, index) => `p.Person${69 - index}`));
		expect(ids.filter((id) => !QUESTION_ID.test(id))).toStrictEqual([]);
	});
});

describe("estimateTokens", () => {
	it("approximates tokens as serialized characters over 3.5, rounded up", () => {
		expect(estimateTokens({model: "clef-flash"})).toStrictEqual(Math.ceil('{"model":"clef-flash"}'.length / 3.5));
	});
});
