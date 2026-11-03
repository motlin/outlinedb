import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../../db/index.js";
import {CacheService} from "../../../services/cache.js";
import {localLookbackCutoff} from "../../../utils/local-date.js";

interface DeclinedItem {
	source: string;
	identifier: string;
	declinedAt: string;
}

interface DeclinedOutput {
	lookbackDays: number;
	items: DeclinedItem[];
}

/**
 * Load declined items from Session Memory.
 *
 * Queries Workflowy Session Memory for items declined in the past N days,
 * preventing re-asking about the same items during bulk capture.
 */
export default class LoadDeclined extends Command {
	static override description = "Load declined items from Session Memory";

	static override examples = [
		"# Load declined items from the last 7 days (default)",
		"<%= config.bin %> <%= command.id %>",
		"",
		"# Load declined items from the last 14 days",
		"<%= config.bin %> <%= command.id %> --lookback-days 14",
	];

	static override enableJsonFlag = true;

	static override flags = {
		"lookback-days": Flags.integer({
			char: "l",
			description: "Number of days to look back",
			default: 7,
		}),
	};

	public async run(): Promise<DeclinedOutput> {
		const {flags} = await this.parse(LoadDeclined);

		const lookbackDays = flags["lookback-days"];

		// Calculate the cutoff date
		const cutoffDateStr = localLookbackCutoff(new Date(), lookbackDays);

		// Initialize cache service
		const database = createDatabase();
		const cacheService = new CacheService(database);

		// Find Session Memory node
		const sessionMemoryPath = ["Metadata", "\u{1F9E0} Session Memory"];
		const sessionMemoryNode = cacheService.findNodeByPath(sessionMemoryPath);

		if (!sessionMemoryNode) {
			const output: DeclinedOutput = {
				lookbackDays,
				items: [],
			};

			if (!this.jsonEnabled()) {
				this.log(JSON.stringify(output));
			}

			return output;
		}

		// Get date nodes (children of Session Memory)
		const dateNodes = cacheService.getChildren(sessionMemoryNode.id);
		const items: DeclinedItem[] = [];

		for (const dateNode of dateNodes) {
			// Filter date nodes >= cutoff date
			// Date node names are in format YYYY-MM-DD
			const dateStr = dateNode.name?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
			if (!dateStr || dateStr < cutoffDateStr) {
				continue;
			}

			// Get entries (children of date node)
			const entries = cacheService.getChildren(dateNode.id);

			for (const entry of entries) {
				const entryName = entry.name ?? "";
				const parsed = this.parseDeclined(entryName);

				if (parsed) {
					items.push({
						source: parsed.source,
						identifier: parsed.identifier,
						declinedAt: `${dateStr}T00:00:00Z`,
					});
				}
			}
		}

		const output: DeclinedOutput = {
			lookbackDays,
			items,
		};

		if (!this.jsonEnabled()) {
			this.log(JSON.stringify(output));
		}

		return output;
	}

	/**
	 * Parse a declined entry from Session Memory.
	 *
	 * Supported formats:
	 * - "capture-declined: <source>: <identifier>" (new format)
	 * - "bulk-capture-declined: <url>" (legacy format)
	 */
	private parseDeclined(entry: string): {source: string; identifier: string} | null {
		if (entry.startsWith("capture-declined: ")) {
			// New format: "capture-declined: chrome: https://..."
			const rest = entry.slice("capture-declined: ".length);
			const colonIndex = rest.indexOf(": ");
			if (colonIndex !== -1) {
				return {
					source: rest.slice(0, colonIndex),
					identifier: rest.slice(colonIndex + 2),
				};
			}
			return null;
		}

		if (entry.startsWith("bulk-capture-declined: ")) {
			// Legacy format: "bulk-capture-declined: https://..."
			return {
				source: "chrome",
				identifier: entry.slice("bulk-capture-declined: ".length),
			};
		}

		return null;
	}
}
