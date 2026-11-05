import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {MockInstance} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import EvalLabels from "../../../src/commands/ai/eval-labels.js";
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

/** Pass 2 noul probabilities per verify model, per stripped entry text, per question id. */
const VERIFY_P: Record<string, Record<string, Record<string, number>>> = {
	"clef-flash": {
		"Played with Alice": {"p.AliceBrown": 0.9, "p.AliceChen": 0.85, "p.Bob": 0.1, "t.pickleball": 0.85},
		"Lunch with Bob": {"p.AliceBrown": 0.1, "p.AliceChen": 0.1, "p.Bob": 0.95, "t.pickleball": 0.2},
		"Paddles at the park": {"p.AliceBrown": 0.1, "p.AliceChen": 0.1, "p.Bob": 0.1, "t.pickleball": 0.7},
	},
	clef: {
		"Played with Alice": {"p.AliceBrown": 0.95, "p.AliceChen": 0.2, "p.Bob": 0.05, "t.pickleball": 0.9},
		"Lunch with Bob": {"p.AliceBrown": 0.05, "p.AliceChen": 0.05, "p.Bob": 0.97, "t.pickleball": 0.1},
		"Paddles at the park": {"p.AliceBrown": 0.05, "p.AliceChen": 0.05, "p.Bob": 0.05, "t.pickleball": 0.92},
	},
};
/** Simulated milliseconds each request takes, per pass and stripped entry text. */
const LATENCY_MS: Record<string, Record<string, number>> = {
	choice: {"Played with Alice": 200, "Lunch with Bob": 300, "Paddles at the park": 400},
	"clef-flash": {"Played with Alice": 40, "Lunch with Bob": 50, "Paddles at the park": 60},
	clef: {"Played with Alice": 90, "Lunch with Bob": 100, "Paddles at the park": 110},
};

type AnyRequest = ClefRequest<ChoiceQuestion | NoulQuestion>;

function dayTime(year: number, month: number, day: number): string {
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
}

describe("ai eval-labels command", () => {
	let originalEnv: typeof process.env;
	let tempDir: string;
	let metadataDir: string;
	let testDatabase: TestDatabase;
	let run: MockInstance<WorkersAiClefClient["run"]>;
	let clock: number;

	beforeEach(() => {
		originalEnv = {...process.env};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-eval-labels-test-"));
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
				createTestNode({id: "y2024", name: "2024", parentId: "cal", priority: 0}),
				createTestNode({id: "m2412", name: "12", parentId: "y2024"}),
				createTestNode({id: "d241201", name: dayTime(2024, 12, 1), parentId: "m2412"}),
				createTestNode({id: "old", name: "Old game #pickleball with @Bob", parentId: "d241201"}),
				createTestNode({id: "y2026", name: "2026", parentId: "cal", priority: 100}),
				createTestNode({id: "m2611", name: "11", parentId: "y2026"}),
				createTestNode({id: "d261103", name: dayTime(2026, 11, 3), parentId: "m2611"}),
				createTestNode({
					id: "e1",
					name: "Played #pickleball with @AliceBrown",
					parentId: "d261103",
					priority: 0,
				}),
				createTestNode({id: "e2", name: "Lunch with @Bob", parentId: "d261103", priority: 100}),
				createTestNode({id: "e3", name: "Paddles at the park #pickleball", parentId: "d261103", priority: 200}),
				createTestNode({id: "e4", name: "Read a book", parentId: "d261103", priority: 300}),
				createTestNode({id: "e5", name: "Played #chess", parentId: "d261103", priority: 400}),
			]),
		});

		clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		run = vi.spyOn(WorkersAiClefClient.prototype, "run").mockImplementation(async (request: AnyRequest) => {
			const {entry} = request.state;
			const answers: ClefResult["answers"] = {};
			let isChoice = false;
			for (const [id, question] of Object.entries(request.questions)) {
				if (question.type === "choice") {
					isChoice = true;
					const options = Object.keys(question.criteria);
					const probabilities = Object.fromEntries(options.map((option) => [option, 1 / options.length]));
					answers[id] = {type: "choice", choice: options[0] ?? "none", probabilities, confidence: 0.5};
				} else {
					answers[id] = {type: "noul", noul: VERIFY_P[request.model]?.[entry]?.[id] ?? 0};
				}
			}
			clock += LATENCY_MS[isChoice ? "choice" : request.model]?.[entry] ?? 0;
			return Promise.resolve({
				model: request.model,
				answers,
				usage: {input_tokens: isChoice ? 1000 : 50, output_tokens: 0},
			});
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	async function evaluate(...args: string[]) {
		return captureOutput(async () => EvalLabels.run([...args, "--metadata-dir", metadataDir, "--json"]));
	}

	it("reports shortlist recall, per-arm per-kind precision/recall and cost from usage.input_tokens", async () => {
		const {stdout, error} = await evaluate(
			"--sample",
			"10",
			"--since",
			"2025-01",
			"--arms",
			"flash,clef",
			"--thresholds",
			"0.8,0.9",
		);

		const perfect = {truePositives: 2, predicted: 2, actual: 2, precision: 1, recall: 1};
		expect({
			error: error?.message,
			out: JSON.parse(stdout),
			states: run.mock.calls.map(([request]) => `${request.model} ${request.state.entry}`),
		}).toStrictEqual({
			error: undefined,
			out: {
				entries: 3,
				since: "2025-01",
				seed: 1,
				tagStrip: "drop",
				targetPrecision: 0.9,
				shortlist: {
					model: "clef-flash",
					person: {recall: 1, meanSize: 3},
					tag: {recall: 1, meanSize: 1},
					usage: {requests: 3, inputTokens: 3000, inputTokensPerEntry: 1000, costPer100Entries: 0.0038},
					latencyMs: {p50: 300, p95: 400},
				},
				arms: [
					{
						arm: "flash",
						model: "clef-flash",
						person: {
							thresholds: [
								{
									threshold: 0.8,
									truePositives: 2,
									predicted: 3,
									actual: 2,
									precision: 2 / 3,
									recall: 1,
								},
								{threshold: 0.9, ...perfect},
							],
							atTargetPrecision: {threshold: 0.9, ...perfect},
						},
						tag: {
							thresholds: [
								{threshold: 0.8, truePositives: 1, predicted: 1, actual: 2, precision: 1, recall: 0.5},
								{threshold: 0.9, truePositives: 0, predicted: 0, actual: 2, precision: 1, recall: 0},
							],
							atTargetPrecision: {threshold: 0.7, ...perfect},
						},
						usage: {requests: 3, inputTokens: 150, inputTokensPerEntry: 50, costPer100Entries: 0.00019},
						latencyMs: {p50: 50, p95: 60},
						costPer100Entries: 0.00399,
					},
					{
						arm: "clef",
						model: "clef",
						person: {
							thresholds: [
								{threshold: 0.8, ...perfect},
								{threshold: 0.9, ...perfect},
							],
							atTargetPrecision: {threshold: 0.95, ...perfect},
						},
						tag: {
							thresholds: [
								{threshold: 0.8, ...perfect},
								{threshold: 0.9, ...perfect},
							],
							atTargetPrecision: {threshold: 0.9, ...perfect},
						},
						usage: {requests: 3, inputTokens: 150, inputTokensPerEntry: 50, costPer100Entries: 0.0012},
						latencyMs: {p50: 100, p95: 110},
						costPer100Entries: 0.005,
					},
				],
			},
			states: [
				"clef-flash Lunch with Bob",
				"clef-flash Lunch with Bob",
				"clef Lunch with Bob",
				"clef-flash Played with Alice",
				"clef-flash Played with Alice",
				"clef Played with Alice",
				"clef-flash Paddles at the park",
				"clef-flash Paddles at the park",
				"clef Paddles at the park",
			],
		});
	});

	it("samples at most --sample entries, people first, deterministically for a seed", async () => {
		const first = await evaluate("--sample", "2", "--since", "2025-01", "--seed", "7");
		const firstStates = run.mock.calls.map(([request]) => request.state.entry);
		run.mockClear();
		await evaluate("--sample", "2", "--since", "2025-01", "--seed", "7");

		expect({
			entries: JSON.parse(first.stdout).entries,
			arms: JSON.parse(first.stdout).arms.map(({arm}: {arm: string}) => arm),
			firstStates,
			secondStates: run.mock.calls.map(([request]) => request.state.entry),
		}).toStrictEqual({
			entries: 2,
			arms: ["flash"],
			firstStates: ["Played with Alice", "Played with Alice", "Paddles at the park", "Paddles at the park"],
			secondStates: firstStates,
		});
	});

	it("keeps each tag's plain word in the stripped text with --tag-strip word and records the mode", async () => {
		const {stdout} = await evaluate("--sample", "10", "--since", "2025-01", "--tag-strip", "word");

		expect({
			tagStrip: JSON.parse(stdout).tagStrip,
			states: run.mock.calls.map(([request]) => `${request.model} ${request.state.entry}`),
		}).toStrictEqual({
			tagStrip: "word",
			states: [
				"clef-flash Lunch with Bob",
				"clef-flash Lunch with Bob",
				"clef-flash Played pickleball with Alice",
				"clef-flash Played pickleball with Alice",
				"clef-flash Paddles at the park pickleball",
				"clef-flash Paddles at the park pickleball",
			],
		});
	});

	it("samples archived days five levels below the calendar root", async () => {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "cal", name: "📆 Calendar", parentId: null}),
				createTestNode({id: "arch", name: "🗃️ Archive", parentId: "cal"}),
				createTestNode({id: "decade", name: "2020 - 2029 decade", parentId: "arch"}),
				createTestNode({id: "y2025", name: "2025", parentId: "decade"}),
				createTestNode({id: "m2501", name: "January", parentId: "y2025"}),
				createTestNode({id: "d250106", name: dayTime(2025, 1, 6), parentId: "m2501"}),
				createTestNode({id: "a1", name: "Lunch with @Bob", parentId: "d250106"}),
			]),
		});

		await evaluate("--sample", "10", "--since", "2025-01");

		expect(run.mock.calls.map(([request]) => `${request.model} ${request.state.entry}`)).toStrictEqual([
			"clef-flash Lunch with Bob",
			"clef-flash Lunch with Bob",
		]);
	});

	it("exits 1 with a clear error and no Clef calls when the token is missing", async () => {
		delete process.env.CLOUDFLARE_AI_TOKEN;

		const {error} = await evaluate("--since", "2025-01");

		expect({
			message: error?.message,
			code: (error as {oclif?: {exit?: number}} | undefined)?.oclif?.exit,
			calls: run.mock.calls.length,
		}).toStrictEqual({
			message:
				"CLOUDFLARE_AI_TOKEN is not set: add it to .envrc as an op:// reference and run through `op run --`",
			code: 1,
			calls: 0,
		});
	});
});
