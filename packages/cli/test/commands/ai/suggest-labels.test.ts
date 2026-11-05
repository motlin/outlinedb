import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {MockInstance} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SuggestLabels from "../../../src/commands/ai/suggest-labels.js";
import type {ChoiceQuestion, ClefRequest, ClefResult, NoulQuestion} from "../../../src/services/clef-requests.js";
import {WorkersAiClefClient} from "../../../src/services/workers-ai-client.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";

const PEOPLE = {
	name: "👥 People",
	children: [
		{name: "@AliceBrown", children: [{name: "👥 Relationship: book club friend"}]},
		{name: "@AliceChen", children: [{name: "👥 Relationship: coworker"}]},
		{name: "@Bob"},
	],
};
const HOBBIES = {name: "🎮 Hobbies Registry", children: [{name: "🏓 Pickleball #pickleball"}]};
const TAG_FREQUENCY = {tags: {"#next-action": 50, "#pickleball": 10}};

/** Pass 1 choice probabilities the stubbed Clef returns per option id. */
const SHORTLIST_P: Record<string, number> = {
	"p.AliceBrown": 0.5,
	"p.AliceChen": 0.3,
	"p.Bob": 0.1,
	"t.pickleball": 0.8,
	none: 0.1,
};
/** Pass 2 noul probabilities the stubbed Clef returns per question id. */
const VERIFY_P: Record<string, number> = {
	"p.AliceBrown": 0.91,
	"p.AliceChen": 0.07,
	"p.Bob": 0.2,
	"t.pickleball": 0.98,
};

type AnyRequest = ClefRequest<ChoiceQuestion | NoulQuestion>;

function stubAnswer(request: AnyRequest): ClefResult {
	const answers: ClefResult["answers"] = {};
	for (const [id, question] of Object.entries(request.questions)) {
		if (question.type === "choice") {
			const probabilities = Object.fromEntries(
				Object.keys(question.criteria).map((option) => [option, SHORTLIST_P[option] ?? 0]),
			);
			const [choice = "none"] = Object.entries(probabilities).toSorted(([, a], [, b]) => b - a)[0] ?? [];
			answers[id] = {type: "choice", choice, probabilities, confidence: 0.5};
		} else {
			answers[id] = {type: "noul", noul: VERIFY_P[id] ?? 0};
		}
	}
	return {model: request.model, answers, usage: {input_tokens: 100, output_tokens: 0}};
}

function dayTime(year: number, month: number, day: number): string {
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
}

describe("ai suggest-labels command", () => {
	let originalEnv: typeof process.env;
	let tempDir: string;
	let metadataDir: string;
	let testDatabase: TestDatabase;
	let run: MockInstance<WorkersAiClefClient["run"]>;

	beforeEach(() => {
		originalEnv = {...process.env};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-suggest-labels-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
		process.env.CLOUDFLARE_AI_TOKEN = "test-token";

		metadataDir = path.join(tempDir, "metadata");
		fs.mkdirSync(metadataDir);
		fs.writeFileSync(path.join(metadataDir, "people.json"), JSON.stringify(PEOPLE));
		fs.writeFileSync(path.join(metadataDir, "hobbies-registry.json"), JSON.stringify(HOBBIES));
		fs.writeFileSync(path.join(metadataDir, "tag-frequency.json"), JSON.stringify(TAG_FREQUENCY));

		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "cal", name: "📆 Calendar", parentId: null}),
				createTestNode({id: "y2026", name: "2026", parentId: "cal"}),
				createTestNode({id: "m11", name: "11", parentId: "y2026"}),
				createTestNode({id: "d1103", name: dayTime(2026, 11, 3), parentId: "m11", priority: 100}),
				createTestNode({
					id: "e1",
					name: "Played <b>pickleball</b> with Alice after work",
					parentId: "d1103",
					priority: 0,
				}),
				createTestNode({id: "e2", name: "Lunch with @Bob", parentId: "d1103", priority: 100}),
				createTestNode({id: "e1-photo", name: "photo", parentId: "e1", priority: 0}),
			]),
		});

		run = vi
			.spyOn(WorkersAiClefClient.prototype, "run")
			.mockImplementation(async (request) => Promise.resolve(stubAnswer(request)));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	function calls() {
		return run.mock.calls.map(([request]) => ({
			model: request.model,
			state: request.state,
			questions: Object.keys(request.questions),
		}));
	}

	async function suggest(...args: string[]) {
		return captureOutput(async () => SuggestLabels.run([...args, "--metadata-dir", metadataDir, "--json"]));
	}

	const STATE_E1 = {
		date: "2026-11-03",
		parent: "📆 Calendar > 2026 > 11 > 11/3/2026",
		entry: "Played pickleball with Alice after work",
	};

	it("runs the shortlist and verify passes and prints verify-pass suggestions at or above the threshold", async () => {
		const {stdout, error} = await suggest("--id", "e1");

		expect({error: error?.message, out: JSON.parse(stdout), calls: calls()}).toStrictEqual({
			error: undefined,
			out: [
				{
					nodeId: "e1",
					suggestions: [
						{label: "#pickleball", kind: "tag", score: 0.98, source: "clef-flash"},
						{label: "@AliceBrown", kind: "person", score: 0.91, source: "clef-flash"},
					],
				},
			],
			calls: [
				{model: "clef-flash", state: STATE_E1, questions: ["people.1", "tags.1"]},
				{
					model: "clef-flash",
					state: STATE_E1,
					questions: ["t.pickleball", "p.AliceBrown", "p.AliceChen", "p.Bob"],
				},
			],
		});
	});

	it("lowers the cut with --threshold", async () => {
		const {stdout} = await suggest("--id", "e1", "--threshold", "0.05");

		expect(JSON.parse(stdout)).toStrictEqual([
			{
				nodeId: "e1",
				suggestions: [
					{label: "#pickleball", kind: "tag", score: 0.98, source: "clef-flash"},
					{label: "@AliceBrown", kind: "person", score: 0.91, source: "clef-flash"},
					{label: "@Bob", kind: "person", score: 0.2, source: "clef-flash"},
					{label: "@AliceChen", kind: "person", score: 0.07, source: "clef-flash"},
				],
			},
		]);
	});

	it("switches only the verify pass to full Clef with --verifier clef", async () => {
		const {stdout} = await suggest("--id", "e1", "--verifier", "clef");

		expect({out: JSON.parse(stdout), models: calls().map(({model}) => model)}).toStrictEqual({
			out: [
				{
					nodeId: "e1",
					suggestions: [
						{label: "#pickleball", kind: "tag", score: 0.98, source: "clef"},
						{label: "@AliceBrown", kind: "person", score: 0.91, source: "clef"},
					],
				},
			],
			models: ["clef-flash", "clef"],
		});
	});

	it("scores each entry under a month's days, drops labels already on an entry, and skips fresh entries", async () => {
		const first = await suggest("--parent-id", "m11");
		const firstCalls = calls();
		run.mockClear();
		const second = await suggest("--parent-id", "m11");

		const e2State = {...STATE_E1, entry: "Lunch with @Bob"};
		const expected = [
			{
				nodeId: "e1",
				suggestions: [
					{label: "#pickleball", kind: "tag", score: 0.98, source: "clef-flash"},
					{label: "@AliceBrown", kind: "person", score: 0.91, source: "clef-flash"},
				],
			},
			{
				nodeId: "e2",
				suggestions: [
					{label: "#pickleball", kind: "tag", score: 0.98, source: "clef-flash"},
					{label: "@AliceBrown", kind: "person", score: 0.91, source: "clef-flash"},
				],
			},
		];
		expect({
			first: JSON.parse(first.stdout),
			firstCalls,
			second: JSON.parse(second.stdout),
			secondCalls: calls(),
		}).toStrictEqual({
			first: expected,
			firstCalls: [
				{model: "clef-flash", state: STATE_E1, questions: ["people.1", "tags.1"]},
				{
					model: "clef-flash",
					state: STATE_E1,
					questions: ["t.pickleball", "p.AliceBrown", "p.AliceChen", "p.Bob"],
				},
				{model: "clef-flash", state: e2State, questions: ["people.1", "tags.1"]},
				{model: "clef-flash", state: e2State, questions: ["t.pickleball", "p.AliceBrown", "p.AliceChen"]},
			],
			second: expected,
			secondCalls: [],
		});
	});

	it("rescores fresh entries with --force", async () => {
		await suggest("--id", "e1");
		run.mockClear();
		await suggest("--id", "e1", "--force");

		expect(calls().map(({model}) => model)).toStrictEqual(["clef-flash", "clef-flash"]);
	});

	it("exits 1 with a clear error and no Clef calls when the token is missing", async () => {
		delete process.env.CLOUDFLARE_AI_TOKEN;

		const {error} = await suggest("--id", "e1");

		expect({
			message: error?.message,
			code: (error as {oclif?: {exit?: number}} | undefined)?.oclif?.exit,
			calls: calls(),
		}).toStrictEqual({
			message:
				"CLOUDFLARE_AI_TOKEN is not set: add it to .envrc as an op:// reference and run through `op run --`",
			code: 1,
			calls: [],
		});
	});
});
