import {Command, Flags} from "@oclif/core";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {createDatabase} from "../../db/index.js";
import {parseStrictNumber} from "../../utils/parse-strict-number.js";
import {SearchService} from "../../services/search.js";
import type {SearchMode, SearchResult} from "../../services/search.js";
import {DEFAULT_MODELS, EMBEDDING_MODELS, getEmbeddingModel} from "../../services/embeddings.js";
import type {EmbeddingModelKey} from "../../services/embeddings.js";

export default class Search extends Command {
	static override enableJsonFlag = true;

	static override description = "Semantically search through Workflowy nodes using vector embeddings";

	static override examples = [
		'<%= config.bin %> <%= command.id %> --query "project ideas"',
		'<%= config.bin %> <%= command.id %> --query "meeting notes from last week" --limit 10',
		'<%= config.bin %> <%= command.id %> -q "tasks about refactoring" --threshold 0.3 # stricter matching',
		'<%= config.bin %> <%= command.id %> --query "API" --model bge # use specific model',
		'<%= config.bin %> <%= command.id %> --query "API" --json | jq',
		'<%= config.bin %> <%= command.id %> --query "API" --mode hybrid # BM25 + vector fusion',
	];

	static override flags = {
		query: Flags.string({
			char: "q",
			description: "Search query",
			required: true,
		}),
		limit: Flags.integer({
			char: "l",
			description: "Maximum number of results to return per model",
			default: 5,
		}),
		threshold: Flags.string({
			char: "t",
			description:
				"Maximum distance threshold (lower = more similar, 0-2). Uses model-specific default if not specified.",
		}),
		"show-distance": Flags.boolean({
			char: "d",
			description: "Show similarity distance scores",
			default: false,
		}),
		model: Flags.string({
			char: "m",
			description: "Search using a specific model only (minilm or mpnet)",
			options: Object.keys(EMBEDDING_MODELS),
		}),
		json: Flags.boolean({
			char: "j",
			description: "Output results in JSON format",
			default: false,
		}),
		mode: Flags.option({
			description: "Search mode: vector (default), keyword (FTS5), or hybrid (BM25 + vector RRF fusion)",
			options: ["vector", "keyword", "hybrid"] as const,
			default: "vector",
		})(),
	};

	public async run(): Promise<
		{
			id: string;
			name: string;
			note: string | null | undefined;
			priority: number;
			completed: boolean;
			createdAt: number;
			modifiedAt: number | null;
			completedAt: number | null;
			data?: Record<string, unknown>;
			nodeId: string;
			fullPath: string;
			textContent: string;
			distance?: number;
			model?: EmbeddingModelKey;
		}[]
	> {
		const {flags} = await this.parse(Search);
		const {query} = flags;

		const threshold = flags.threshold === undefined ? undefined : parseStrictNumber(flags.threshold);
		if (flags.threshold !== undefined && threshold === undefined) {
			this.error(`Invalid --threshold value: "${flags.threshold}". Must be a number.`);
		}
		const database = createDatabase();
		const searchService = new SearchService(database);

		if (!this.jsonEnabled()) {
			this.log(`🔍 Searching for: "${query}"\n`);
		}

		const modelsToSearch: EmbeddingModelKey[] = flags.model ? [flags.model] : DEFAULT_MODELS;

		const searchMode: SearchMode = flags.mode;

		const searchPromises = modelsToSearch.map(async (model) => {
			const results = await searchService.search({
				query,
				limit: flags.limit,
				threshold,
				model,
				mode: searchMode,
			});
			return {model, results};
		});

		const allSearchResults = await Promise.all(searchPromises);

		const transformedResults = allSearchResults.flatMap(({model, results}) =>
			results.map((result) => ({
				id: result.id,
				name: result.name,
				note: result.note,
				priority: result.priority,
				completed: result.completed,
				createdAt: result.createdAt,
				modifiedAt: result.modifiedAt,
				completedAt: result.completedAt,
				data: result.data,
				nodeId: result.nodeId,
				fullPath: result.fullPath,
				textContent: result.textContent,
				...(flags["show-distance"] ? {distance: result.distance} : {}),
				...(flags.model ? {} : {model}),
			})),
		);

		if (flags.json) {
			this.log(JSON.stringify(transformedResults, null, 2));
			return transformedResults;
		}

		const totalResults = allSearchResults.reduce((sum, {results}) => sum + results.length, 0);

		if (totalResults === 0) {
			if (!this.jsonEnabled()) {
				this.log("No results found. Try:");
				this.log("  • Using different search terms");
				this.log("  • Increasing the threshold with --threshold");
				this.log("  • Generating embeddings if you haven't: workflowy ai:embed");
			}
			return transformedResults;
		}

		if (!this.jsonEnabled()) {
			for (const {model, results} of allSearchResults) {
				if (!flags.model) {
					const modelConfig = getEmbeddingModel(model);
					this.log(`═══ ${model} (${modelConfig.name.replace("Xenova/", "")}) ═══\n`);
				}

				if (results.length === 0) {
					this.log("No results found.\n");
					continue;
				}

				for (const result of results) {
					this.displayResult(result, flags["show-distance"]);
				}
			}
		}

		return transformedResults;
	}

	private displayResult(result: SearchResult, showDistance: boolean): void {
		const formattedPath = this.formatPathWithGreySeparators(result.fullPath);
		this.log(`📍 ${formattedPath}`);
		if (showDistance) {
			this.log(`   Distance: ${result.distance.toFixed(4)}`);
		}

		const preview = stripHtmlTags(result.textContent).slice(0, 150);
		this.log(`   ${preview}${result.textContent.length > 150 ? "..." : ""}`);
		const greyUrl = `\u001B[90mhttps://workflowy.com/#/${result.nodeId}\u001B[0m`;
		this.log(`   🔗 ${greyUrl}\n`);
	}

	private formatPathWithGreySeparators(path: string): string {
		return path.replaceAll(" > ", "\u001B[90m > \u001B[0m");
	}
}
