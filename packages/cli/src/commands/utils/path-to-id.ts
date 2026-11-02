import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";
import {PathResolutionService} from "../../services/path-resolution.js";

export default class PathToId extends Command
{
	static override description = "Resolve a Workflowy path to a node ID";

	static override examples = [
		"# Resolve a path to get the node ID",
		'<%= config.bin %> <%= command.id %> --path "Work,Projects,My Project"',
		"",
		"# Use with node:list for composition",
		'<%= config.bin %> <%= command.id %> --path "Work,Calendar" | xargs <%= config.bin %> node:list --id',
		"",
		"# Resolve from a custom root node",
		'<%= config.bin %> <%= command.id %> --root-id abc123 --path "Tasks,Today"',
		"",
		"# Use cache-only mode (no API calls)",
		'<%= config.bin %> <%= command.id %> --path "Home,Inbox" --data-source cache',
	];

	static override flags =
	{
		path: Flags.string(
			{
				char: "p",
				description: 'Comma-separated path to the node (e.g., "Work,Projects,My Project")',
				required: true,
			},
		),
		"root-id": Flags.string(
			{
				char: "r",
				description: "Root node ID to start path from (omit for root level)",
			},
		),
		"data-source": Flags.option(
			{
				char: "d",
				description: "Data source to use: auto (default), api, or cache",
				options: ["auto", "api", "cache"] as const,
				default: "auto",
			},
		)(),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(PathToId);

		const database = createDatabase();
		const cacheService = new CacheService(database);

		let apiClient: WorkflowyApiClient | null = null;
		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (apiKey)
		{
			apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		}

		const pathResolutionService = new PathResolutionService(cacheService, apiClient);

		const rootId = flags["root-id"] ?? null;
		const dataSource = flags["data-source"];

		try
		{
			const result = await pathResolutionService.resolveTargetNodeId(
				{
					rootId,
					path: flags.path,
					dataSource,
				},
			);

			// Output only the node ID for easy composition with other commands
			this.log(result.nodeId);
		}
		catch (error)
		{
			this.error(String(error));
		}
	}
}
