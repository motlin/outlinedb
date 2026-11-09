import {NodeTreeReader} from "@outlinedb/shared/cache";
import type {NodeTree} from "@outlinedb/shared/cache";
import {isShortId} from "@outlinedb/shared/workflowy";
import {Flags} from "@oclif/core";
import {logger} from "../../services/logger.js";
import {htmlToAnsi} from "../../utils/html-to-ansi.js";
import {BaseListCommand} from "../base-list-command.js";
import type {ListCommandFlags} from "../base-list-command.js";

interface GetFlags extends ListCommandFlags {
	id?: string;
	path?: string;
	fields?: string[];
	"follow-mirror"?: boolean;
}

export default class Get extends BaseListCommand {
	static override hidden = false;
	static override description = "Read a single Workflowy node with optional children";

	static override examples = [
		"# Read node by ID",
		"<%= config.bin %> <%= command.id %> --id abc123",
		"",
		"# Read node by short ID from Workflowy URL (12 hex chars)",
		"<%= config.bin %> <%= command.id %> --id c8708df23f1e",
		"",
		"# Read node by path",
		'<%= config.bin %> <%= command.id %> --path "Work,Projects,My Project"',
		"",
		"# Read node with children (depth 3)",
		"<%= config.bin %> <%= command.id %> --id abc123 --depth 3",
		"",
		"# Read node with full tree and follow links",
		'<%= config.bin %> <%= command.id %> --path "Personal,Inbox" --depth 5 --follow-links',
		"",
		"# Follow a mirror to its original node",
		"<%= config.bin %> <%= command.id %> --id abc123 --follow-mirror",
		"",
		"# Output as JSON",
		"<%= config.bin %> <%= command.id %> --id abc123 --json",
		"",
		"# Output JSON with only specific fields (reduces token usage for LLM processing)",
		'<%= config.bin %> <%= command.id %> --path "Metadata,Inboxes" --depth 3 --json --fields id,name,note,completed,children',
	];

	static override flags = {
		...BaseListCommand.baseFlags,
		id: Flags.string({
			char: "i",
			description: "ID of the node to read (full UUID or 12-char short ID from URL)",
			exclusive: ["path"],
		}),
		path: Flags.string({
			char: "p",
			description: 'Comma-separated path to the node (e.g., "Work,Projects,My Project")',
			exclusive: ["id"],
		}),
		"follow-mirror": Flags.boolean({
			char: "m",
			description: "If the node is a mirror, follow it to the original node",
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(Get);
		const typedFlags = flags as GetFlags;

		if (!typedFlags.id && !typedFlags.path) {
			this.error("Either --id or --path is required");
		}

		this.initializeApiClient();

		let nodeId: string | undefined;

		// Resolve the node ID from --id (UUID or short ID) or --path.
		if (typedFlags.id) {
			const idInput = typedFlags.id;
			if (isShortId(idInput)) {
				const resolvedId = this.cacheService.resolveShortIdToUuid(idInput);
				if (resolvedId) {
					nodeId = resolvedId;
					logger.debug(`Resolved short ID ${idInput} to full UUID ${resolvedId}`);
				} else {
					this.error(`No node found for short ID: ${idInput}`);
				}
			} else {
				nodeId = idInput;
			}
		} else if (typedFlags.path) {
			const nodePath = typedFlags.path.split(",").map((s) => s.trim());
			const cachedNode = this.cacheService.findNodeByPath(nodePath);
			if (cachedNode) {
				nodeId = cachedNode.id;
			} else {
				this.error(`Node not found at path: ${nodePath.join(" > ")}`);
			}
		}

		if (!nodeId) {
			this.error("Could not resolve a node ID");
		}

		// Detect a mirror so we can report it (or follow it) before reading the tree.
		let isMirror = false;
		let originalId: string | null = this.cacheService.getMirrorOriginal(nodeId);
		if (originalId) {
			isMirror = true;
			if (typedFlags["follow-mirror"]) {
				logger.debug(`Node ${nodeId} is a mirror of ${originalId}, following to original`);
				nodeId = originalId;
				originalId = null;
			}
		}

		const trees = await new NodeTreeReader(this.cacheService).readNodes([nodeId], {
			depth: typedFlags.depth,
			followLinks: typedFlags["follow-links"],
		});
		const node = trees[0];
		if (node === undefined) {
			this.error(`Node not found with ID: ${nodeId}`);
		}

		await this.displayNodeWithChildren(node, typedFlags, {isMirror, originalId});
	}

	private async displayNodeWithChildren(
		node: NodeTree,
		flags: GetFlags,
		mirrorInfo: {isMirror: boolean; originalId: string | null},
	): Promise<void> {
		const fullPath = this.pathBuilder.buildFullPath(node.id);

		if (flags.json) {
			let outputNode: Record<string, unknown>;
			if (flags.fields) {
				const parsedFields = this.parseFields(flags.fields);
				outputNode = this.filterNodeFields(node, parsedFields);
				if (parsedFields.includes("path")) {
					outputNode.path = fullPath;
				}
			} else {
				outputNode = {...node, path: fullPath};
			}
			this.log(JSON.stringify(outputNode, null, 2));
			return;
		}

		// Node header.
		this.log(`Node: ${fullPath}`);
		this.log(`🔗 \u001B[90mhttps://workflowy.com/#/${node.id}\u001B[0m`);

		if (mirrorInfo.isMirror && !flags["follow-mirror"] && mirrorInfo.originalId) {
			this.log(`\u001B[33m🪞 This is a mirror of: ${mirrorInfo.originalId}\u001B[0m`);
			this.log(`   Use --follow-mirror (-m) to view the original node`);
		}
		this.log("");

		if (flags.depth > 0 && node.children && node.children.length > 0) {
			this.log(htmlToAnsi(node.name ?? ""));
			this.log(`Children (${this.countDescendants(node)} nodes):`);
			await this.displayNodes(node.children, flags);
		} else if (flags.depth > 0) {
			this.log(htmlToAnsi(node.name ?? ""));
			this.log("No children");
		} else {
			this.log(`Name: ${htmlToAnsi(node.name ?? "")}`);
			if (node.note) {
				this.log(`Note: ${node.note}`);
			}
			this.log(`Completed: ${node.completedAt !== null}`);
			if (node.createdAt) {
				this.log(`Created: ${node.createdAt.toISOString()}`);
			}
			if (node.modifiedAt) {
				this.log(`Modified: ${node.modifiedAt.toISOString()}`);
			}
			if (node.completedAt) {
				this.log(`Completed At: ${node.completedAt.toISOString()}`);
			}
			if (node.layoutMode) {
				this.log(`Layout: ${node.layoutMode}`);
			}
		}
	}

	private countDescendants(node: NodeTree): number {
		let count = 0;
		if (node.children) {
			for (const child of node.children) {
				count += 1 + this.countDescendants(child);
			}
		}
		return count;
	}
}
