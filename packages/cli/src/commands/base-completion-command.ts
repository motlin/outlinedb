import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {PathBuilder, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../db/index.js";
import {CacheService} from "../services/cache.js";
import {logger} from "../services/logger.js";
import {resolveNodeId} from "@outlinedb/shared/utils";

export abstract class BaseCompletionCommand extends Command {
	static override hidden = true;

	static override flags = {
		id: Flags.string({
			char: "i",
			description: "ID of the node",
			exclusive: ["path"],
		}),
		path: Flags.string({
			char: "p",
			description: 'Comma-separated path to the node (e.g., "Work,Tasks,My Task")',
			exclusive: ["id"],
		}),
		"dry-run": Flags.boolean({
			char: "d",
			description: "Show the API call that would be made without executing",
			default: false,
		}),
	};

	protected abstract get action(): "complete" | "uncomplete";
	protected abstract get actionPastTense(): string;
	protected abstract get actionPresent(): string;

	protected abstract executeAction(client: WorkflowyWriteThroughClient, nodeId: string): Promise<void>;

	public async run(): Promise<void> {
		const {flags} = await this.parse(BaseCompletionCommand);

		if (!flags.id && !flags.path) {
			this.error("Either --id or --path is required");
		}

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey) {
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		const apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		const database = createDatabase();
		const cacheService = new CacheService(database);
		const client = new WorkflowyWriteThroughClient(apiClient, cacheService);
		const pathBuilder = new PathBuilder(database);

		const nodeId = await resolveNodeId(flags, cacheService, apiClient);

		const fullPath = pathBuilder.buildFullPath(nodeId);

		if (flags["dry-run"]) {
			this.log("Would execute API call:");
			this.log(`  Method: POST`);
			this.log(`  URL: https://workflowy.com/api/v1/nodes/${nodeId}/${this.action}`);
			this.log("  Headers:");
			this.log("    Authorization: Bearer <WORKFLOWY_API_KEY>");
			this.log("    Content-Type: application/json");
			this.log("");
			this.log(`Node: ${fullPath}`);
		} else {
			this.log(`${this.actionPresent}: ${fullPath}`);

			await this.executeAction(client, nodeId);

			this.log("");
			this.log(`✓ Successfully ${this.actionPastTense}`);
		}
	}
}
