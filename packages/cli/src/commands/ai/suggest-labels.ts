import {newSystemTimestamp} from "@workflowy/shared/cache";
import {resolveIdOrShortId} from "@workflowy/shared/utils";
import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import type {ClefModel} from "../../services/clef-requests.js";
import {buildLabelPool} from "../../services/label-pool.js";
import type {RegistryNode} from "../../services/label-pool.js";
import {entriesToScore, liveHints, saveLabelSuggestions} from "../../services/label-suggestions.js";
import type {EntryHints} from "../../services/label-suggestions.js";
import {entryState, scopeEntries, scoreEntry} from "../../services/suggest-labels.js";
import {WorkersAiClefClient} from "../../services/workers-ai-client.js";

const RegistryNodeSchema: z.ZodType<RegistryNode> = z.lazy(() =>
	z.object({name: z.string(), children: z.array(RegistryNodeSchema).optional()}),
);
const TagFrequencySchema = z.object({tags: z.record(z.string(), z.number())});

const VERIFIERS = ["clef-flash", "clef"] as const satisfies readonly ClefModel[];

export default class SuggestLabels extends Command {
	static override description =
		"Score @mention and #tag suggestions for journal entries or inbox items with hosted Clef on Workers AI (a Clef-flash shortlist pass, then a verify pass), store them, and print the verify-pass suggestions at or above the threshold. Entries already scored against their current text are skipped unless --force";

	static override examples = [
		"op run -- <%= config.bin %> <%= command.id %> --id 6b7118a90648 --json",
		"op run -- <%= config.bin %> <%= command.id %> --parent-id <month or Inbox id> --threshold 0.9 --json",
		"op run -- <%= config.bin %> <%= command.id %> --parent-id <month id> --verifier clef --force",
	];

	static override flags = {
		id: Flags.string({description: "Entry to score (full or short id)", exactlyOne: ["id", "parent-id"]}),
		"parent-id": Flags.string({
			description: "Score every entry under this calendar month (through its days) or Inbox (full or short id)",
			exactlyOne: ["id", "parent-id"],
		}),
		verifier: Flags.option({
			description: "Model for the verify pass; the shortlist pass always uses clef-flash",
			options: VERIFIERS,
			default: "clef-flash",
		})(),
		threshold: Flags.custom<number>({
			description: "Print verify-pass suggestions scoring at least this probability",
			default: 0.8,
			parse: async (input) => {
				const value = Number(input);
				return Number.isFinite(value) && value >= 0 && value <= 1
					? Promise.resolve(value)
					: Promise.reject(new Error(`--threshold must be a number from 0 to 1, got "${input}"`));
			},
		})(),
		force: Flags.boolean({description: "Rescore entries that already have fresh suggestions", default: false}),
		"metadata-dir": Flags.string({
			description: "Directory holding people.json, hobbies-registry.json and tag-frequency.json",
			default: path.join(".llm", "gtd", "metadata"),
		}),
		json: Flags.boolean({char: "j", description: "Output [{nodeId, suggestions}] as JSON", default: false}),
	};

	public async run(): Promise<EntryHints[]> {
		const {flags} = await this.parse(SuggestLabels);
		const token = process.env.CLOUDFLARE_AI_TOKEN;
		if (!token) {
			this.error(
				"CLOUDFLARE_AI_TOKEN is not set: add it to .envrc as an op:// reference and run through `op run --`",
				{exit: 1},
			);
		}
		const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
		if (!accountId) {
			this.error("CLOUDFLARE_ACCOUNT_ID is not set: add it to .envrc", {exit: 1});
		}
		const client = new WorkersAiClefClient(accountId, token);

		const readJson = <T>(file: string, schema: z.ZodType<T>): T =>
			schema.parse(JSON.parse(fs.readFileSync(path.join(flags["metadata-dir"], file), "utf8")));
		const people = readJson("people.json", RegistryNodeSchema);
		const hobbies = readJson("hobbies-registry.json", RegistryNodeSchema);
		const tagFrequency = readJson("tag-frequency.json", TagFrequencySchema).tags;

		const database = createDatabase();
		const cache = new CacheService(database);
		const nodeIds =
			flags.id === undefined
				? scopeEntries(cache, resolveIdOrShortId(flags["parent-id"] ?? "", cache))
				: [resolveIdOrShortId(flags.id, cache)];

		for (const entry of entriesToScore(database, nodeIds, {force: flags.force})) {
			const {state, labels} = entryState(cache, entry.nodeId);
			const pool = buildLabelPool({people, hobbies, tagFrequency, entryLabels: labels});
			const suggestions = await scoreEntry(client, pool, state, flags.verifier);
			database.transaction((tx) => {
				saveLabelSuggestions(tx, entry, suggestions, newSystemTimestamp());
			});
		}

		const hints = liveHints(database, nodeIds, flags.threshold);
		if (flags.json) {
			this.log(JSON.stringify(hints, null, 2));
		} else {
			for (const {nodeId, suggestions} of hints) {
				const text = suggestions.map(({label, score, source}) => `${label} ${score.toFixed(2)} (${source})`);
				this.log(`${nodeId}: ${text.length === 0 ? "-" : text.join(", ")}`);
			}
		}
		return hints;
	}
}
