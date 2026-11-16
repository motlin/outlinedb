import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {PathBuilder, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import type {LocalTreeWriter} from "@outlinedb/shared/cache";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import
{
	drainAfterWrite,
	localDeletePlan,
	logWritePreview,
	openLocalWrites,
	previewLocalWrite,
} from "../../services/local-writes.js";
import {logger} from "../../services/logger.js";
import {resolveNodeId} from "@outlinedb/shared/utils";

export default class Delete extends Command
{
	static override description = "Delete a Workflowy node";

	static override examples = [
		"# Delete node by ID",
		"<%= config.bin %> <%= command.id %> --id abc123",
		"",
		"# Delete node by path",
		'<%= config.bin %> <%= command.id %> --path "Work,Tasks,Completed Task"',
		"",
		"# Preview the local delete and the ops it would push, without deleting",
		"<%= config.bin %> <%= command.id %> --id abc123 --dry-run",
	];

	static override flags =
	{
		id: Flags.string(
			{
				char: "i",
				description: "ID of the node to delete",
				exclusive: ["path"],
			},
		),
		path: Flags.string(
			{
				char: "p",
				description: 'Comma-separated path to the node (e.g., "Work,Tasks,Old Task")',
				exclusive: ["id"],
			},
		),
		"dry-run": Flags.boolean(
			{
				char: "d",
				description:
					"Show the local write and the ops the drain would push, without saving or sending anything",
				default: false,
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(Delete);

		if (!flags.id && !flags.path)
		{
			this.error("Either --id or --path is required");
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

		const nodeId = await resolveNodeId(flags, cacheService, apiClient);

		const fullPath = pathBuilder.buildFullPath(nodeId);
		const plan = await localDeletePlan(cacheService, nodeId);
		const removingMirror = plan.nodeId === null && plan.promotions.length === 0;
		const innerMirrorPaths = removingMirror ? [] : plan.mirrorIds.map((id) => pathBuilder.buildFullPath(id));
		const keptPaths = plan.promotions.map(({originalId, mirrorId}) => (
		{
			originalId,
			from: pathBuilder.buildFullPath(originalId),
			to: pathBuilder.buildFullPath(mirrorId),
		}));
		const warning = removingMirror
			? "WARNING: This removes only this mirror; its original and the original's children are kept."
			: plan.nodeId === null
				? "NOTE: Nothing is deleted: the node has a mirror elsewhere, so it moves into that mirror's place."
				: plan.promotions.length > 0
					? "WARNING: This will permanently delete the node and all its children, except the nodes kept above!"
					: "WARNING: This will permanently delete the node and all its children!";

		const heading = removingMirror ? "Removing mirror" : "Deleting node";
		this.log(flags["dry-run"] ? `${heading} (dry run): ${fullPath}` : `${heading}: ${fullPath}`);
		if (innerMirrorPaths.length > 0)
		{
			this.log("");
			this.log("Mirrors removed first, so their originals drop the reference:");
			for (const mirrorPath of innerMirrorPaths)
			{
				this.log(`  ${mirrorPath}`);
			}
		}
		if (keptPaths.length > 0)
		{
			this.log("");
			for (const {from, to} of keptPaths)
			{
				this.log(`Keeping ${from} by moving it to ${to} (as the web app does)`);
			}
		}
		this.log("");
		this.log(warning);

		// The local delete also deletes the backlink items of every source in the subtree, as upstream's client does.
		const write = (local: LocalTreeWriter): void =>
		{
			local.deleteNode(nodeId, plan);
		};
		if (flags["dry-run"])
		{
			this.log("");
			logWritePreview(this, await previewLocalWrite(database, write));
			return;
		}

		const writes = openLocalWrites(database, client);
		write(writes.local);
		await drainAfterWrite(this, writes);

		this.log("");
		if (removingMirror)
		{
			this.log("Successfully removed mirror");
		}
		else if (plan.nodeId !== null)
		{
			this.log("Successfully deleted node");
		}
		for (const {originalId, from} of keptPaths)
		{
			this.log(`Kept ${from}, now at ${pathBuilder.buildFullPath(originalId)}`);
		}
	}
}
