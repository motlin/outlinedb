import {newSystemTimestamp} from "@workflowy/shared/cache";
import {resolveIdOrShortId} from "@workflowy/shared/utils";
import {Command, Flags} from "@oclif/core";
import path from "node:path";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import type {ClefModel} from "../../services/clef-requests.js";
import {clefClientFromEnv, readLabelRegistries} from "../../services/clef-setup.js";
import {buildLabelPool} from "../../services/label-pool.js";
import type {LabelKind} from "../../services/label-pool.js";
import {entriesToScore, liveHints, saveLabelSuggestions} from "../../services/label-suggestions.js";
import type {EntryHints} from "../../services/label-suggestions.js";
import {
	calendarEntriesSince,
	entryState,
	parseYearMonth,
	scopeEntries,
	scoreEntry,
} from "../../services/suggest-labels.js";

const VERIFIERS = ["clef-flash", "clef"] as const satisfies readonly ClefModel[];
const KINDS = ["person", "tag"] as const satisfies readonly LabelKind[];

export default class SuggestLabels extends Command {
	static override description =
		"Score @mention and #tag suggestions for journal entries or inbox items with hosted Clef on Workers AI (a Clef-flash shortlist pass, then a verify pass), store them, and print the verify-pass suggestions at or above the threshold. Entries already scored against their current text are skipped unless --force";

	static override examples = [
		"op run -- <%= config.bin %> <%= command.id %> --id 6b7118a90648 --json",
		"op run -- <%= config.bin %> <%= command.id %> --parent-id <month or Inbox id> --threshold 0.9 --json",
		"op run -- <%= config.bin %> <%= command.id %> --parent-id <month id> --verifier clef --force",
		"op run -- <%= config.bin %> <%= command.id %> --parent-id <calendar id> --since 2026-10 --kind person --verifier clef --threshold 0.77 --json",
	];

	static override flags = {
		id: Flags.string({description: "Entry to score (full or short id)", exactlyOne: ["id", "parent-id"]}),
		"parent-id": Flags.string({
			description: "Score every entry under this calendar month (through its days) or Inbox (full or short id)",
			exactlyOne: ["id", "parent-id"],
		}),
		since: Flags.custom<{year: number; month: number}>({
			description:
				"With --parent-id, score the entries on calendar days in or after this month (YYYY-MM) at any depth under it, instead of its direct children and days",
			dependsOn: ["parent-id"],
			parse: async (input) => parseYearMonth(input, "--since"),
		})(),
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
		kind: Flags.option({
			description: "Score and print only this label kind (default: both)",
			options: KINDS,
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
		const client = clefClientFromEnv();
		if ("error" in client) {
			this.error(client.error, {exit: 1});
		}
		const {people, hobbies, tagFrequency} = readLabelRegistries(flags["metadata-dir"]);

		const database = createDatabase();
		const cache = new CacheService(database);
		const nodeIds = this.scope(cache, flags);

		for (const entry of entriesToScore(database, nodeIds, {force: flags.force})) {
			const {state, labels} = entryState(cache, entry.nodeId);
			const pool = buildLabelPool({people, hobbies, tagFrequency, entryLabels: labels}).filter(
				({kind}) => flags.kind === undefined || kind === flags.kind,
			);
			const suggestions = await scoreEntry(client, pool, state, flags.verifier);
			database.transaction((tx) => {
				saveLabelSuggestions(tx, entry, suggestions, newSystemTimestamp());
			});
		}

		const hints = liveHints(database, nodeIds, flags.threshold).map(({nodeId, suggestions}) => ({
			nodeId,
			suggestions: suggestions.filter(({kind}) => flags.kind === undefined || kind === flags.kind),
		}));
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

	private scope(
		cache: CacheService,
		flags: {id?: string; "parent-id"?: string; since?: {year: number; month: number}},
	): string[] {
		if (flags.id !== undefined) {
			return [resolveIdOrShortId(flags.id, cache)];
		}
		const rootId = resolveIdOrShortId(flags["parent-id"] ?? "", cache);
		return flags.since === undefined
			? scopeEntries(cache, rootId)
			: calendarEntriesSince(cache, rootId, flags.since);
	}
}
