import {adoptUnderCalendar} from "../../services/calendar-adoption.js";
import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {PathBuilder, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";
import {resolveNodeId, resolveParent} from "@outlinedb/shared/utils";

export default class Move extends Command
{
	static override description = "Move a single node to a new location by ID or path";

	static override examples = [
		"# Move node to inbox (system target)",
		"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id inbox",
		"",
		"# Move node to the top level (Home)",
		"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id home",
		"",
		"# Move node by ID to parent ID",
		"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id def456",
		"",
		"# Move node by path to parent path",
		'<%= config.bin %> <%= command.id %> --node-path "Work,Tasks,My Task" --parent-path "Work,Archive"',
		"",
		"# Move node to bottom of parent (default is top)",
		"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id def456 --position bottom",
		"",
		"# Preview the move command without executing",
		"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id inbox --dry-run",
		"",
		"# Mixed: move by ID to path",
		'<%= config.bin %> <%= command.id %> --node-id abc123 --parent-path "Work,Archive"',
	];

	static override flags =
	{
		"node-id": Flags.string(
			{
				description: "ID of the node to move",
				exclusive: ["node-path"],
			},
		),
		"node-path": Flags.string(
			{
				description: 'Comma-separated path to the node to move (e.g., "Work,Tasks,My Task")',
				exclusive: ["node-id"],
			},
		),
		"parent-id": Flags.string(
			{
				description:
					'ID of the destination parent node, a system target (e.g., "inbox"), or "home" for the top level',
				exclusive: ["parent-path"],
			},
		),
		"parent-path": Flags.string(
			{
				description: 'Comma-separated path to the destination parent node (e.g., "Work,Archive")',
				exclusive: ["parent-id"],
			},
		),
		"dry-run": Flags.boolean(
			{
				char: "d",
				description: "Show the exact CLI command to execute the move without actually moving",
				default: false,
			},
		),
		position: Flags.string(
			{
				char: "p",
				description: "Position within the destination parent (top or bottom)",
				options: ["top", "bottom"],
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(Move);

		if (!flags["node-id"] && !flags["node-path"])
		{
			this.error("Either --node-id or --node-path is required");
		}

		if (!flags["parent-id"] && !flags["parent-path"])
		{
			this.error("Either --parent-id or --parent-path is required");
		}

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey)
		{
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		const apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		const database = createDatabase();
		const cacheService = new CacheService(database);
		const client = new WorkflowyWriteThroughClient(apiClient, cacheService);
		const pathBuilder = new PathBuilder(database);

		const nodeId = await resolveNodeId(
			{
				id: flags["node-id"],
				path: flags["node-path"],
			},
			cacheService,
			apiClient,
		);
		const parentId = await resolveParent(
			{
				id: flags["parent-id"],
				path: flags["parent-path"],
			},
			cacheService,
			apiClient,
		);

		const sourcePath = pathBuilder.buildFullPath(nodeId);
		const destinationPath = pathBuilder.buildFullPath(parentId);

		// Convert position string to number for API (-1 for top, 0 for bottom)
		const positionValue = flags.position === "top" ? -1 : flags.position === "bottom" ? 0 : undefined;

		if (flags["dry-run"])
		{
			let command = `${this.config.bin} node:move --node-id ${nodeId} --parent-id ${parentId ?? HOME_TARGET}`;
			if (flags.position)
			{
				command += ` --position ${flags.position}`;
			}
			this.log(`Would move:`);
			this.log(`  From: ${sourcePath}`);
			this.log(`  To:   ${destinationPath}`);
			if (flags.position)
			{
				this.log(`  Position: ${flags.position}`);
			}
			this.log(``);
			this.log(`Execute with:`);
			this.log(`  ${command}`);
		}
		else
		{
			this.log(`Moving:`);
			this.log(`  From: ${sourcePath}`);
			this.log(`  To:   ${destinationPath}`);
			if (flags.position)
			{
				this.log(`  Position: ${flags.position}`);
			}

			await client.moveNode(nodeId, parentId, positionValue);
			await adoptUnderCalendar(
				{
					rows: [
						{
							id: nodeId,
							name: cacheService.getNode(nodeId)?.name ?? "",
						},
					],
					parentId,
					database,
					cache: cacheService,
					writeThrough: client,
					warn: (message) =>
					{
						this.logToStderr(message);
					},
				},
			);

			this.log(`Successfully moved node`);
		}
	}
}
