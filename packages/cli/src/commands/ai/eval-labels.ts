import {findCalendarRoot} from "@outlinedb/shared/calendar-lookup";
import {resolveIdOrShortId} from "@outlinedb/shared/utils";
import {Command, Flags} from "@oclif/core";
import type {Interfaces} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {clefClientFromEnv, readLabelRegistries} from "../../services/clef-setup.js";
import
{
	ARM_MODELS,
	EVAL_ARMS,
	PEOPLE_CONTEXTS,
	TAG_STRIP_MODES,
	buildEvalReport,
	judgedTruth,
	sampleStratified,
	stripLabels,
} from "../../services/label-eval.js";
import type {EvalArm, EvalReport, EvalRun, PeopleContext, TagStripMode} from "../../services/label-eval.js";
import type {ClefState} from "../../services/clef-requests.js";
import type {LabelKind} from "../../services/label-pool.js";
import {buildLabelPool} from "../../services/label-pool.js";
import {parsePeopleHints} from "../../services/people-hints.js";
import
{
	calendarEntriesSince,
	entryState,
	parseYearMonth,
	runShortlist,
	runVerify,
	siblingTexts,
} from "../../services/suggest-labels.js";

/** Word cap for person descriptions once disambiguation hints are folded in. */
const HINTED_PERSON_WORDS = 40;
/** Same-day entries added to state with `--people-context siblings`. */
const MAX_SIBLINGS = 20;

/** One sampled entry's eval run, saved by `--cases-out` with the entry it ran on. */
interface CaseRecord extends EvalRun
{
	readonly nodeId: string;
	readonly state: ClefState;
}

/** The `--cases-out` file: the sampling settings and every entry's run, enough to rescore offline. */
interface CasesFile
{
	readonly since: string;
	readonly seed: number;
	readonly tagStrip: TagStripMode;
	readonly kind: LabelKind | null;
	readonly peopleContext: readonly PeopleContext[];
	readonly arms: readonly EvalArm[];
	readonly runs: readonly CaseRecord[];
}

const KindSchema = z.enum(["person", "tag"]);
const KindedLabelSchema = z.object(
	{
		label: z.string(),
		kind: KindSchema,
	},
);
const passSchema = <T extends z.ZodType>(value: T) =>
	z.object(
		{
			result: z.object(
				{
					value,
					requests: z.number(),
					inputTokens: z.number(),
				},
			),
			ms: z.number(),
		},
	);
const CasesFileSchema: z.ZodType<CasesFile> = z.object(
	{
		since: z.string(),
		seed: z.number(),
		tagStrip: z.enum(TAG_STRIP_MODES),
		kind: KindSchema.nullable(),
		peopleContext: z.array(z.enum(PEOPLE_CONTEXTS)),
		arms: z.array(z.enum(EVAL_ARMS)),
		runs: z.array(
			z.object(
				{
					nodeId: z.string(),
					state: z.object(
						{
							date: z.string(),
							parent: z.string(),
							entry: z.string(),
							siblings: z.array(z.string()).optional(),
						},
					),
					truth: z.array(KindedLabelSchema),
					shortlist: passSchema(
						z.array(
							z.object(
								{
									label: KindedLabelSchema.extend(
										{
											optionId: z.string(),
											description: z.string(),
										},
									),
									score: z.number(),
								},
							),
						),
					),
					verify: z.partialRecord(
						z.enum(EVAL_ARMS),
						passSchema(
							z.array(
								KindedLabelSchema.extend(
									{
										score: z.number(),
									},
								),
							),
						),
					),
				},
			),
		),
	},
);
const JudgmentsSchema = z.record(z.string(), z.record(z.string(), z.boolean()));

function readJson<T>(file: string, schema: z.ZodType<T>): T
{
	return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export default class EvalLabels extends Command
{
	static override description =
		"Measure Clef label suggestions on held-out tagged journal entries: strip each sampled entry's @mentions (to first names) and #tags (dropped, or kept as plain words with --tag-strip word), run the Clef-flash shortlist once and each arm's verify pass, and report shortlist recall, precision/recall per threshold, the threshold reaching the target precision, latency and cost from usage.input_tokens, per arm and label kind";

	static override examples = [
		"op run -- <%= config.bin %> <%= command.id %> --sample 500 --since 2025-01 --arms flash,clef --json",
	];

	static override flags =
	{
		sample: Flags.integer(
			{
				description: "Entries to evaluate, split between people and tags",
				default: 500,
				min: 1,
			},
		),
		since: Flags.string(
			{
				description: "Earliest calendar month to sample from (YYYY-MM)",
				default: "2025-01",
				parse: async (input) => parseYearMonth(input, "--since").then(() => input),
			},
		),
		arms: Flags.option(
			{
				description: "Verify-pass models to compare: flash is Clef-flash, clef is full Clef",
				options: EVAL_ARMS,
				multiple: true,
				delimiter: ",",
				default: ["flash"],
			},
		)(),
		thresholds: Flags.string(
			{
				description: "Comma-separated verify-score thresholds to report precision and recall at",
				default: "0.5,0.6,0.7,0.8,0.9,0.95",
			},
		),
		"target-precision": Flags.custom<number>(
			{
				description: "Report the lowest threshold whose precision reaches this",
				default: 0.9,
				parse: async (input) => probability(input, "--target-precision"),
			},
		)(),
		seed: Flags.integer(
			{
				description: "Sampling seed",
				default: 1,
			},
		),
		"tag-strip": Flags.option(
			{
				description:
					"How to hide #tags from Clef: drop removes them, word keeps the tag's word as plain text so evidence like '#fasting day 1' survives",
				options: TAG_STRIP_MODES,
				default: "drop",
			},
		)(),
		kind: Flags.option(
			{
				description:
					"Evaluate one label kind: keep the sampled entries that carry it, only their labels of that kind, and a pool of that kind",
				options: ["person", "tag"] as const,
			},
		)(),
		"people-context": Flags.option(
			{
				description:
					"Experimental extra context (default none): aliases folds people-disambiguation hints into person descriptions, siblings adds the day's other entries (stripped the same way) to state",
				options: PEOPLE_CONTEXTS,
				multiple: true,
				delimiter: ",",
				default: [],
			},
		)(),
		"disambiguation-file": Flags.string(
			{
				description: "People-disambiguation markdown read by --people-context aliases",
				default: path.join(".llm", "gtd", "people-disambiguation.md"),
			},
		),
		"calendar-id": Flags.string(
			{
				description: "Calendar root (full or short id); defaults to 📆 Calendar",
			},
		),
		"metadata-dir": Flags.string(
			{
				description: "Directory holding people.json, hobbies-registry.json and tag-frequency.json",
				default: path.join(".llm", "gtd", "metadata"),
			},
		),
		"cases-out": Flags.string(
			{
				description:
					"Save each sampled entry's stripped state, truth, shortlist and verify scores to this JSON file, for judging and offline rescoring",
			},
		),
		"from-cases": Flags.string(
			{
				description:
					"Rescore a --cases-out file offline instead of sampling and calling Clef; its sampling settings and arms replace the flags",
				exclusive: ["cases-out"],
			},
		),
		judgments: Flags.string(
			{
				description:
					"JSON file of node id to {label: acceptable}: true labels judged false leave the truth, predicted labels judged true join it, and the report says relevance judged",
			},
		),
		json: Flags.boolean(
			{
				char: "j",
				description: "Output the report as JSON",
				default: false,
			},
		),
	};

	public async run(): Promise<EvalReport>
	{
		const {flags} = await this.parse(EvalLabels);
		const thresholds = await Promise.all(
			flags.thresholds.split(",").map(async (value) => probability(value.trim(), "--thresholds")),
		);
		const cases: CasesFile =
			flags["from-cases"] === undefined
				? await this.sampleAndScore(flags)
				: readJson(flags["from-cases"], CasesFileSchema);
		if (flags["cases-out"] !== undefined)
		{
			fs.writeFileSync(flags["cases-out"], `${JSON.stringify(cases, null, 2)}\n`);
		}
		const judgments = flags.judgments === undefined ? undefined : readJson(flags.judgments, JudgmentsSchema);
		const runs: EvalRun[] = cases.runs.map((record) => (
		{
			...record,
			truth: judgedTruth(record.truth, judgments?.[record.nodeId]),
		}));
		const arms = cases.arms.map((arm) => (
		{
			arm,
			model: ARM_MODELS[arm],
		}));

		const report = buildEvalReport(
			runs,
			{
				since: cases.since,
				seed: cases.seed,
				tagStrip: cases.tagStrip,
				kind: cases.kind,
				peopleContext: cases.peopleContext,
				targetPrecision: flags["target-precision"],
				relevance: judgments === undefined ? "truth" : "judged",
				thresholds,
				arms,
			},
		);
		if (flags.json)
		{
			this.log(JSON.stringify(report, null, 2));
		}
		else
		{
			this.logSummary(report);
		}
		return report;
	}

	/** Samples held-out entries, strips their labels and runs the Clef passes on each. */
	private async sampleAndScore(flags: Interfaces.InferredFlags<typeof EvalLabels.flags>): Promise<CasesFile>
	{
		const client = clefClientFromEnv();
		if ("error" in client)
		{
			this.error(
				client.error,
				{
					exit: 1,
				},
			);
		}
		const since = await parseYearMonth(flags.since, "--since");

		const peopleContext = flags["people-context"];
		const registries = readLabelRegistries(flags["metadata-dir"]);
		const fullPool = buildLabelPool(
			{
				...registries,
				entryLabels: [],
				...(peopleContext.includes("aliases") &&
				{
					personHints: parsePeopleHints(fs.readFileSync(flags["disambiguation-file"], "utf8")),
					personDescriptionWords: HINTED_PERSON_WORDS,
				}),
			},
		);
		const poolLabels = new Map(fullPool.map((label) => [label.label.toLowerCase(), label]));
		const pool = fullPool.filter(({kind}) => flags.kind === undefined || kind === flags.kind);

		const database = createDatabase();
		const cache = new CacheService(database);
		const rootId =
			flags["calendar-id"] === undefined
				? findCalendarRoot(
						{
							db: database,
							cache,
						},
					)
				: resolveIdOrShortId(flags["calendar-id"], cache);
		if (rootId === undefined)
		{
			this.error(
				"No 📆 Calendar root in the cache: pass --calendar-id",
				{
					exit: 1,
				},
			);
		}

		const strip = (text: string) =>
			stripLabels(
				text,
				{
					tags: flags["tag-strip"],
				},
			);
		const candidates = calendarEntriesSince(cache, rootId, since).flatMap((nodeId) =>
		{
			const {state} = entryState(cache, nodeId);
			const {text, labels} = strip(state.entry);
			const truth = labels.filter(({label}) => poolLabels.has(label.toLowerCase()));
			return truth.length === 0
				? []
				: [
						{
							nodeId,
							state:
							{
								...state,
								entry: text,
							},
							truth,
						},
					];
		});
		// Sample over every kind so --kind keeps the same entries as an unfiltered run with the same seed.
		const sample = sampleStratified(
			candidates,
			{
				size: flags.sample,
				seed: flags.seed,
				stratum: ({truth}) => (truth.some(({kind}) => kind === "person") ? "person" : "tag"),
			},
		).flatMap(({nodeId, state, truth}) =>
		{
			const kept = truth.filter(({kind}) => flags.kind === undefined || kind === flags.kind);
			if (kept.length === 0)
			{
				return [];
			}
			const siblings = peopleContext.includes("siblings")
				?
					{
						siblings: siblingTexts(cache, nodeId, MAX_SIBLINGS).map((text) => strip(text).text),
					}
				: {};
			return [
				{
					nodeId,
					state:
					{
						...state,
						...siblings,
					},
					truth: kept,
				},
			];
		});

		const runs: CaseRecord[] = [];
		for (const {nodeId, state, truth} of sample)
		{
			const shortlist = await timed(async () => runShortlist(client, pool, state));
			const verify: EvalRun["verify"] = {};
			for (const arm of flags.arms)
			{
				verify[arm] = await timed(async () =>
					runVerify(client, shortlist.result.value, state, ARM_MODELS[arm]),
				);
			}
			runs.push(
				{
					nodeId,
					state,
					truth,
					shortlist,
					verify,
				},
			);
		}
		return {
			since: flags.since,
			seed: flags.seed,
			tagStrip: flags["tag-strip"],
			kind: flags.kind ?? null,
			peopleContext,
			arms: flags.arms,
			runs,
		};
	}

	private logSummary(report: EvalReport): void
	{
		const {shortlist} = report;
		this.log(`${report.entries} entries since ${report.since} (seed ${report.seed}, tags ${report.tagStrip})`);
		this.log(
			`shortlist (${shortlist.model}): people recall ${pct(shortlist.person.recall)} (mean ${shortlist.person.meanSize.toFixed(1)}), tags recall ${pct(shortlist.tag.recall)} (mean ${shortlist.tag.meanSize.toFixed(1)}), p50 ${shortlist.latencyMs.p50}ms`,
		);
		for (const arm of report.arms)
		{
			for (const kind of ["person", "tag"] as const)
			{
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

async function probability(input: string, flag: string): Promise<number>
{
	const value = Number(input);
	return Number.isFinite(value) && value >= 0 && value <= 1
		? Promise.resolve(value)
		: Promise.reject(new Error(`${flag} must be a number from 0 to 1, got "${input}"`));
}

async function timed<T>(work: () => Promise<T>): Promise<
{
	result: T;
	ms: number;
}>
{
	const start = performance.now();
	const result = await work();
	return {
		result,
		ms: performance.now() - start,
	};
}

function pct(value: number): string
{
	return `${(value * 100).toFixed(0)}%`;
}
