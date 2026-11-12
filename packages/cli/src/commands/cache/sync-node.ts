import {WorkflowyApiClient, WorkflowyInternalClient} from "@outlinedb/shared/api";
import {readInternalAuth} from "@outlinedb/shared/node";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";
import {resolveNodeId} from "@outlinedb/shared/utils";
import {NodeSyncService} from "../../services/node-sync.js";
import type {NodeSyncProgress} from "../../services/node-sync.js";

export default class SyncNode extends Command
{
	static override description =
		"Sync a specific node and optionally its children from the Workflowy API to the cache";

	static override examples = [
		"<%= config.bin %> cache:sync-node --id 61111c3a-e939-d4dc-1a8c-6bf42551caa3",
		"<%= config.bin %> cache:sync-node --path Personal,Journal",
		"<%= config.bin %> cache:sync-node --path Work,Projects --recursive",
		"<%= config.bin %> cache:sync-node --id 39caff96-e338-0f20-55f2-65f9e140ba02 --recursive",
	];

	static override flags =
	{
		id: Flags.string(
			{
				char: "i",
				description: "Node ID to sync",
				exclusive: ["path"],
			},
		),
		path: Flags.string(
			{
				char: "p",
				description: "Path to the node (comma-separated)",
				exclusive: ["id"],
			},
		),
		recursive: Flags.boolean(
			{
				char: "r",
				description: "Recursively sync all children",
				default: false,
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(SyncNode);

		if (!flags.id && !flags.path)
		{
			this.error("Either --id or --path must be specified");
		}

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey)
		{
			this.error("WORKFLOWY_API_KEY environment variable is not set");
		}

		const apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		const database = createDatabase();
		const cacheService = new CacheService(database);
		const syncService = new NodeSyncService(
			apiClient,
			cacheService,
			{
				database,
				treeData: async () =>
				{
					const auth = readInternalAuth();
					return auth ? (await new WorkflowyInternalClient(auth).getTreeSnapshot()).items : undefined;
				},
			},
		);

		const targetNodeId = await resolveNodeId(flags, cacheService, apiClient);
		const targetNodeName = flags.path ? `${flags.path} (${targetNodeId})` : targetNodeId;

		this.log(`Syncing node: ${targetNodeName}`);
		if (flags.recursive)
		{
			this.log("Mode: Recursive (will sync all descendants)");
		}

		const startTime = Date.now();

		try
		{
			const handleProgress = (progress: NodeSyncProgress) =>
			{
				if (progress.childCount > 0)
				{
					this.log(`  ${progress.message}`);
				}
			};

			const stats = await syncService.syncNode(
				{
					nodeId: targetNodeId,
					recursive: flags.recursive,
					onProgress: handleProgress,
				},
			);

			const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
			this.log(`✓ Successfully synced ${stats.syncedCount} nodes in ${elapsedSeconds} seconds`);
		}
		catch (error)
		{
			this.error(`Failed to sync node: ${String(error)}`);
		}
	}
}
