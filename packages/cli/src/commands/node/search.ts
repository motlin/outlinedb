import {Command, Flags} from "@oclif/core";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {createDatabase} from "../../db/index.js";
import {TextSearchService} from "../../services/text-search.js";
import type {TextSearchResult} from "../../services/text-search.js";

export default class Search extends Command {
	static override description = "Search Workflowy nodes by text in names and notes";

	static override examples = [
		'<%= config.bin %> <%= command.id %> --query "meeting notes"',
		'<%= config.bin %> <%= command.id %> -q "project ideas" --limit 10',
		'<%= config.bin %> <%= command.id %> --query "TODO" --json',
		'<%= config.bin %> <%= command.id %> --query "#llm-task" --incomplete',
	];

	static override flags = {
		query: Flags.string({
			char: "q",
			description: "Text to search for in node names and notes",
			required: true,
		}),
		limit: Flags.integer({
			char: "l",
			description: "Maximum number of results to return",
			default: 20,
		}),
		incomplete: Flags.boolean({
			description: "Only show incomplete (not completed) nodes",
			default: false,
		}),
		json: Flags.boolean({
			char: "j",
			description: "Output results in JSON format",
			default: false,
		}),
	};

	public async run(): Promise<TextSearchResult[]> {
		const {flags} = await this.parse(Search);
		const {query} = flags;

		const database = createDatabase();
		const searchService = new TextSearchService(database);

		const results = searchService.search({
			query,
			limit: flags.limit,
			incomplete: flags.incomplete,
		});

		if (flags.json) {
			this.log(JSON.stringify(results, null, 2));
			return results;
		}

		if (results.length === 0) {
			this.log("No results found.");
			return results;
		}

		this.log(`Found ${results.length} result${results.length === 1 ? "" : "s"}:\n`);

		for (const result of results) {
			const formattedPath = this.formatPathWithGreySeparators(result.path);
			this.log(`  ${formattedPath}`);

			const name = stripHtmlTags(result.name ?? "");
			if (name) {
				this.log(`    Name: ${name}`);
			}

			if (result.note) {
				const note = stripHtmlTags(result.note);
				const preview = note.slice(0, 150);
				this.log(`    Note: ${preview}${note.length > 150 ? "..." : ""}`);
			}

			if (result.shortId) {
				const greyUrl = `\u001B[90mhttps://workflowy.com/#/${result.shortId}\u001B[0m`;
				this.log(`    ${greyUrl}`);
			}

			this.log("");
		}

		return results;
	}

	private formatPathWithGreySeparators(path: string): string {
		return path.replaceAll(" > ", "\u001B[90m > \u001B[0m");
	}
}
