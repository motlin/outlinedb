import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {deletePlanCalls, PathBuilder, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {Command, Flags} from "@oclif/core";
import {linkedSourcesInSubtree} from "@outlinedb/shared/internal";
import {createDatabase} from "../../db/index.js";
import {deleteBacklinksOfDeleted} from "@outlinedb/shared/node";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";
import {resolveNodeId} from "@outlinedb/shared/utils";

export default class Delete extends Command {
	static override description = "Delete a Workflowy node";

	static override examples = [
		"# Delete node by ID",
		"<%= config.bin %> <%= command.id %> --id abc123",
		"",
		"# Delete node by path",
		'<%= config.bin %> <%= command.id %> --path "Work,Tasks,Completed Task"',
		"",
		"# Preview the API calls without deleting",
		"<%= config.bin %> <%= command.id %> --id abc123 --dry-run",
	];

	static override flags = {
		id: Flags.string({
			char: "i",
			description: "ID of the node to delete",
			exclusive: ["path"],
		}),
		path: Flags.string({
			char: "p",
			description: 'Comma-separated path to the node (e.g., "Work,Tasks,Old Task")',
			exclusive: ["id"],
		}),
		"dry-run": Flags.boolean({
			char: "d",
			description: "Show the API calls that would be made without executing",
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(Delete);

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
		const plan = await client.planDelete(nodeId);
		const removingMirror = plan.nodeId === null && plan.promotions.length === 0;
		const innerMirrorPaths = removingMirror ? [] : plan.mirrorIds.map((id) => pathBuilder.buildFullPath(id));
		const keptPaths = plan.promotions.map(({originalId, mirrorId}) => ({
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

		if (flags["dry-run"]) {
			this.log("Would execute API calls:");
			for (const call of deletePlanCalls(plan)) {
				const body = call.body === undefined ? "" : ` ${JSON.stringify(call.body)}`;
				this.log(`  ${call.method} https://workflowy.com/api/v1${call.path}${body}`);
			}
			this.log("  Headers:");
			this.log("    Authorization: Bearer <WORKFLOWY_API_KEY>");
			this.log("");
			this.log(`Node: ${fullPath}`);
		} else {
			this.log(`${removingMirror ? "Removing mirror" : "Deleting node"}: ${fullPath}`);
		}
		if (innerMirrorPaths.length > 0) {
			this.log("");
			this.log("Mirrors removed first through the mirror endpoint, so their originals drop the reference:");
			for (const mirrorPath of innerMirrorPaths) {
				this.log(`  ${mirrorPath}`);
			}
		}
		if (keptPaths.length > 0) {
			this.log("");
			for (const {from, to} of keptPaths) {
				this.log(`Keeping ${from} by moving it to ${to} (as the web app does)`);
			}
		}
		this.log("");
		this.log(warning);
		if (flags["dry-run"]) {
			return;
		}

		// Upstream's client deletes a deleted source's backlink items; read the
		// linked sources before the delete drops the subtree from the cache.
		const linked = linkedSourcesInSubtree(database, nodeId);
		await client.deleteNode(nodeId, plan);
		await deleteBacklinksOfDeleted(linked, database, client);

		this.log("");
		if (removingMirror) {
			this.log("Successfully removed mirror");
		} else if (plan.nodeId !== null) {
			this.log("Successfully deleted node");
		}
		for (const {originalId, from} of keptPaths) {
			this.log(`Kept ${from}, now at ${pathBuilder.buildFullPath(originalId)}`);
		}
	}
}
