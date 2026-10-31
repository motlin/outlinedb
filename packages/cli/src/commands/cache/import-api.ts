import {WorkflowyApiClient, WorkflowyInternalClient} from "@workflowy/shared/api";
import type {TreeSnapshot} from "@workflowy/shared/api";
import {importInternalMetadata, WorkflowyWriteThroughClient} from "@workflowy/shared/cache";
import {internalAdapter, readInternalAuth} from "@workflowy/shared/node";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {importFromApi} from "../../services/cache-import-api.js";
import type {ImportApiResult} from "../../services/cache-import-api.js";
import {logger} from "../../services/logger.js";

export default class ImportApi extends Command {
	static override description = "Import all nodes from Workflowy API export endpoint";

	static override examples = ["<%= config.bin %> cache:import-api", "<%= config.bin %> cache:import-api --dry-run"];

	static override flags = {
		"dry-run": Flags.boolean({
			char: "d",
			description: "Show what would be imported without making changes",
			default: false,
		}),
		verbose: Flags.boolean({
			char: "v",
			description: "Show detailed timing information",
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(ImportApi);

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey) {
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		const startTime = Date.now();

		try {
			this.log("Fetching all nodes from Workflowy API...");

			const apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
			const nodes = await apiClient.exportAllNodes();
			const snapshot = await this.fetchTreeSnapshot();
			const treeItems = snapshot?.items;

			const fetchElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			this.log(`Fetched ${nodes.length.toLocaleString()} nodes in ${fetchElapsed}s`);

			if (flags["dry-run"]) {
				this.log("\n[DRY RUN] Would import to cache:");
				this.log(`  Total nodes: ${nodes.length.toLocaleString()}`);
				if (treeItems !== undefined) {
					this.log(`  Tree data items: ${treeItems.length.toLocaleString()}`);
				}
				this.log("  No changes made.");
				return;
			}

			const database = createDatabase();
			const result: ImportApiResult = importFromApi(database, nodes, flags.verbose, undefined, treeItems);

			const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

			const changedCount = result.nodesAdded + result.nodesUpdated + result.nodesDeleted;

			if (changedCount === 0) {
				this.log(`\nNo changes (${result.totalNodes.toLocaleString()} nodes in ${totalElapsed}s)`);
			} else {
				this.log(
					`\n+${result.nodesAdded.toLocaleString()} added, ` +
						`~${result.nodesUpdated.toLocaleString()} updated ` +
						`(${result.contentUpdated.toLocaleString()} content, ${result.priorityUpdated.toLocaleString()} priority, ${result.metadataUpdated.toLocaleString()} metadata), ` +
						`=${result.nodesUnchanged.toLocaleString()} unchanged, ` +
						`-${result.nodesDeleted.toLocaleString()} deleted`,
				);
				this.log(
					`(${result.nodesAdded} + ${result.nodesUpdated} + ${result.nodesUnchanged} + ${result.nodesDeleted} = ${result.totalNodes.toLocaleString()} nodes in ${totalElapsed}s)`,
				);
			}
			if (snapshot !== undefined) {
				const {written, skipped} = importInternalMetadata(database, snapshot, Date.now());
				this.log(`Item metadata: ${written.toLocaleString()} nodes (${skipped.toLocaleString()} not in cache)`);
				await this.backfillCalendarMetadata(database, apiClient);
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("429")) {
				this.error("Rate limit exceeded. Please wait 1 minute before trying again.");
			}
			this.error(`Failed to import from API: ${String(error)}`);
		}
	}

	/**
	 * Run workflowy.com's one-time calendar migrations (`calendar.ts_added_v2`,
	 * `calendar.dateId_added_v1`) on the freshly imported metadata, as upstream
	 * does on boot. Once both flags are set this only reads root metadata. A
	 * failure is reported without failing the import, like upstream's Sentry catch.
	 */
	private async backfillCalendarMetadata(
		database: ReturnType<typeof createDatabase>,
		apiClient: WorkflowyApiClient,
	): Promise<void> {
		const adapter = internalAdapter(
			database,
			new WorkflowyWriteThroughClient(apiClient, new CacheService(database)),
		);
		if (adapter === undefined) {
			return;
		}
		try {
			const {timestamps, dateIds} = await adapter.backfillCalendarMetadata();
			if (timestamps.length > 0 || dateIds.length > 0) {
				this.log(`Calendar backfill: +${timestamps.length} timestamps, +${dateIds.length} dateIds`);
			}
		} catch (error) {
			this.warn(`Calendar metadata backfill failed: ${String(error)}`);
		}
	}

	/**
	 * Read `/get_tree_data/` from the internal API, when WORKFLOWY_USERNAME and
	 * WORKFLOWY_PASSWORD are set or a session cookie is saved. Its item metadata
	 * carries what the public API omits: mirrors (backlink items included),
	 * references roots, numbered_start, calendar and priority.defaultToBottom.
	 * Its transaction id seeds the cache's transaction-log position.
	 */
	private async fetchTreeSnapshot(): Promise<TreeSnapshot | undefined> {
		const auth = readInternalAuth();
		if (!auth) {
			return undefined;
		}
		return new WorkflowyInternalClient(auth).getTreeSnapshot();
	}
}
