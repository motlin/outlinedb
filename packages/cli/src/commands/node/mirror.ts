import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {PathBuilder, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import type {NodeMirrorResult} from "@outlinedb/shared/types";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {drainAfterWrite, localParent, openLocalWrites} from "../../services/local-writes.js";
import {logger} from "../../services/logger.js";
import {resolveNodeId, resolveParent} from "@outlinedb/shared/utils";

export default class Mirror extends Command
{
	static override description = "Create or remove a live Workflowy mirror of a node";

	static override examples = [
		"# Mirror a node into another parent (top by default)",
		"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id def456",
		"",
		"# Mirror a node to the top level (Home)",
		"<%= config.bin %> <%= command.id %> --node-id abc123 --parent-id home",
		"",
		"# Mirror by path, placing the mirror at the bottom",
		'<%= config.bin %> <%= command.id %> --node-path "Work,Tasks,My Task" --parent-path "Work,Agendas" --position bottom',
		"",
		"# Remove a mirror (pass the mirror node, not the origin)",
		"<%= config.bin %> <%= command.id %> --node-id mirror123 --delete",
	];

	static override flags =
	{
		"node-id": Flags.string(
			{
				description: "ID of the node to mirror, or of the mirror to remove with --delete",
				exclusive: ["node-path"],
			},
		),
		"node-path": Flags.string(
			{
				description: "Comma-separated path to the node to mirror, or to the mirror to remove with --delete",
				exclusive: ["node-id"],
			},
		),
		"parent-id": Flags.string(
			{
				description:
					'ID of the parent to place the mirror under, a system target (e.g., "inbox"), or "home" for the top level',
				exclusive: ["parent-path", "delete"],
			},
		),
		"parent-path": Flags.string(
			{
				description: "Comma-separated path to the parent to place the mirror under",
				exclusive: ["parent-id", "delete"],
			},
		),
		position: Flags.option(
			{
				char: "p",
				description: "Position within the parent",
				options: ["top", "bottom"] as const,
				default: "top",
			},
		)(),
		delete: Flags.boolean(
			{
				description: "Remove the mirror given by --node-id/--node-path; the origin is untouched",
				default: false,
			},
		),
		json: Flags.boolean(
			{
				description: "Output the result as JSON (see `node schema --command mirror`)",
				default: false,
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(Mirror);

		if (!flags["node-id"] && !flags["node-path"])
		{
			this.error("Either --node-id or --node-path is required");
		}

		if (!flags.delete && !flags["parent-id"] && !flags["parent-path"])
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

		if (flags.delete)
		{
			if (cacheService.getMirrorOriginal(nodeId) === null)
			{
				this.error(`${nodeId} is not a mirror; pass the mirror node, not its origin`);
			}
			const writes = openLocalWrites(database, client);
			writes.local.deleteNode(
				nodeId,
				{
					mirrorIds: [nodeId],
					promotions: [],
					nodeId: null,
				},
			);
			await drainAfterWrite(this, writes);
			this.report(
				{
					action: "deleted",
					mirrorId: nodeId,
					originId: null,
					parentId: null,
				},
				flags.json,
				() =>
				{
					this.log(`Successfully deleted mirror ${nodeId}`);
				},
			);
			return;
		}

		const parentId = await resolveParent(
			{
				id: flags["parent-id"],
				path: flags["parent-path"],
			},
			cacheService,
			apiClient,
		);
		const {position} = flags;

		if (!flags.json)
		{
			this.log("Mirroring:");
			this.log(`  Origin: ${pathBuilder.buildFullPath(nodeId)}`);
			this.log(`  Into:   ${parentId === null ? "Home" : pathBuilder.buildFullPath(parentId)}`);
		}

		const writes = openLocalWrites(database, client);
		const
		{
			ids: [mirrorId = ""],
		} = writes.local.createMirrorsAt(
			{
				originalIds: [nodeId],
				parentId: localParent(database, parentId),
				...(position === "top"
					?
						{
							index: 0,
						}
					: {}),
			},
		);
		await drainAfterWrite(this, writes);

		this.report(
			{
				action: "created",
				mirrorId,
				originId: nodeId,
				parentId,
			},
			flags.json,
			() =>
			{
				this.log("Successfully created mirror");
				this.log(`  ID: ${mirrorId}`);
				this.log(`  Origin: ${nodeId}`);
			},
		);
	}

	private report(result: NodeMirrorResult, json: boolean, logText: () => void): void
	{
		if (json)
		{
			this.log(JSON.stringify(result, null, 2));
		}
		else
		{
			logText();
		}
	}
}
