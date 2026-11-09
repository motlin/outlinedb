import {Command, Flags} from "@oclif/core";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {createDatabase} from "../../db/index.js";
import {parseStrictNumber} from "../../utils/parse-strict-number.js";
import {QmdSearchService} from "../../services/qmd-search.js";
import type {QmdSearchResultItem} from "../../services/qmd-search.js";

export default class QmdSearch extends Command {
	static override enableJsonFlag = true;

	static override description = "Search Workflowy nodes using qmd hybrid search (BM25 + vector + LLM reranking)";

	static override examples = [
		'<%= config.bin %> <%= command.id %> --query "project ideas"',
		'<%= config.bin %> <%= command.id %> --query "meeting notes" --mode keyword',
		'<%= config.bin %> <%= command.id %> --query "API design" --mode vector',
		'<%= config.bin %> <%= command.id %> --query "tasks" --limit 10 --json',
	];

	static override flags = {
		query: Flags.string({
			char: "q",
			description: "Search query",
			required: true,
		}),
		limit: Flags.integer({
			char: "l",
			description: "Maximum number of results to return",
			default: 5,
		}),
		threshold: Flags.string({
			char: "t",
			description: "Minimum score threshold (0-1, higher = more relevant)",
		}),
		"show-distance": Flags.boolean({
			char: "d",
			description: "Show relevance scores",
			default: false,
		}),
		json: Flags.boolean({
			char: "j",
			description: "Output results in JSON format",
			default: false,
		}),
		mode: Flags.option({
			char: "m",
			description: "Search mode",
			options: ["hybrid", "vector", "keyword"] as const,
			default: "hybrid",
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
			modifiedAt: number;
			completedAt: number | null;
			data?: Record<string, unknown>;
			nodeId: string;
			fullPath: string;
			textContent: string;
			score?: number;
		}[]
	> {
		const {flags} = await this.parse(QmdSearch);
		const {query} = flags;
		const minScore = flags.threshold === undefined ? undefined : parseStrictNumber(flags.threshold);
		if (flags.threshold !== undefined && minScore === undefined) {
			this.error(`Invalid --threshold value: "${flags.threshold}". Must be a number.`);
		}

		const database = createDatabase();
		const service = new QmdSearchService(database);

		try {
			if (!this.jsonEnabled()) {
				this.log(`Searching for: "${query}" (mode: ${flags.mode})\n`);
			}

			const results = await service.search({
				query,
				limit: flags.limit,
				minScore,
				mode: flags.mode,
			});

			const transformedResults = results.map((result) => ({
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
				...(flags["show-distance"] ? {score: result.score} : {}),
			}));

			if (flags.json) {
				this.log(JSON.stringify(transformedResults, null, 2));
				return transformedResults;
			}

			if (results.length === 0) {
				if (!this.jsonEnabled()) {
					this.log("No results found. Try:");
					this.log("  - Using different search terms");
					this.log("  - Lowering the threshold with --threshold");
					this.log("  - Running embeddings if you haven't: outlinedb ai:qmd-embed");
				}
				return transformedResults;
			}

			if (!this.jsonEnabled()) {
				for (const result of results) {
					this.displayResult(result, flags["show-distance"]);
				}
			}

			return transformedResults;
		} finally {
			await service.close();
		}
	}

	private displayResult(result: QmdSearchResultItem, showScore: boolean): void {
		const formattedPath = this.formatPathWithGreySeparators(result.fullPath);
		this.log(`\u{1F4CD} ${formattedPath}`);
		if (showScore) {
			this.log(`   Score: ${result.score.toFixed(4)}`);
		}

		const preview = stripHtmlTags(result.textContent).slice(0, 150);
		this.log(`   ${preview}${result.textContent.length > 150 ? "..." : ""}`);
		const greyUrl = `\u001B[90mhttps://workflowy.com/#/${result.nodeId}\u001B[0m`;
		this.log(`   \u{1F517} ${greyUrl}\n`);
	}

	private formatPathWithGreySeparators(path: string): string {
		return path.replaceAll(" > ", "\u001B[90m > \u001B[0m");
	}
}
