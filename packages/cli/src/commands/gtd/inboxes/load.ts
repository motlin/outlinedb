import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {createDatabase} from "../../../db/index.js";
import {CacheService} from "../../../services/cache.js";
import {findSameTitleSiblings, resolveInboxLinks} from "../../../services/inbox-registry.js";
import {findUnregisteredInboxes} from "../../../services/unregistered-inboxes.js";
import {DEFAULT_DB_FILE} from "../../../db/default-db-file.js";

interface InboxItem {
	id: string;
	name: string;
	note?: string;
	completed?: boolean;
	completedAt?: number | null;
	children?: InboxItem[];
}

interface Inbox {
	id: string;
	name: string;
	linkId: string;
	items: InboxItem[];
	probableDuplicates: {title: string; ids: string[]}[];
}

interface InboxesOutput {
	unregisteredInboxes: {id: string; name: string; path: string}[];
	loadedAt: string;
	inboxes: Inbox[];
	itemCount: number;
}

/**
 * Load all inbox items to .llm/gtd-inboxes.json
 *
 * Reads from Metadata > Inboxes, follows all inbox links, and writes
 * a consolidated JSON file with all inbox items for the refinement agents.
 */
export default class Load extends Command {
	static override description = "Load inbox items from Workflowy for GTD processing";

	static override examples = [
		"# Load all inbox items",
		"<%= config.bin %> <%= command.id %>",
		"# Load with children (depth 3 for refinement nodes)",
		"<%= config.bin %> <%= command.id %> --depth 3",
	];

	static override flags = {
		depth: Flags.integer({
			default: 0,
			description: "Depth of children to fetch for each inbox item (0 = none, max 10)",
			max: 10,
			min: 0,
		}),
	};

	public async run(): Promise<InboxesOutput> {
		const {flags} = await this.parse(Load);
		const {depth} = flags;

		const projectRoot = this.findProjectRoot();
		const outputFile = path.join(projectRoot, ".llm", "gtd-inboxes.json");

		// Ensure .llm directory exists
		const llmDir = path.dirname(outputFile);
		if (!fs.existsSync(llmDir)) {
			fs.mkdirSync(llmDir, {recursive: true});
		}

		// Initialize cache service
		const database = createDatabase();
		const cacheService = new CacheService(database);

		// Find inboxes node
		const inboxesPath = ["Metadata", "\u{1F4E5} Inboxes"];
		const inboxesNode = cacheService.findNodeByPath(inboxesPath);

		if (!inboxesNode) {
			this.error(`Inboxes node not found at path: ${inboxesPath.join(" > ")}`);
		}

		const timestamp = new Date().toISOString();
		const inboxes: Inbox[] = [];

		// Get children of Inboxes node (these are links to actual inboxes)
		const inboxLinks = cacheService.getChildren(inboxesNode.id);

		const {targets: childIdToTargetUuid, broken} = resolveInboxLinks(database, inboxLinks);
		if (broken.length > 0) {
			const details = broken
				.map((link) => `${link.name} (link ${link.linkId} -> missing ${link.shortId})`)
				.join("; ");
			this.error(
				`Broken inbox registration under Metadata > 📥 Inboxes: ${details}. The linked inbox no longer exists, so the real inbox would be skipped. Repoint the link before loading.`,
			);
		}

		for (const child of inboxLinks) {
			// Resolve link target via short ID extracted from anchor href
			const targetUuid = childIdToTargetUuid.get(child.id);
			const target = targetUuid ? cacheService.getNode(targetUuid) : null;

			// Extract inbox name from anchor tag or raw name
			let inboxName = child.name ?? "";
			inboxName = this.extractAnchorText(inboxName);
			inboxName = inboxName.replace(/\s*\u{1F4E5}\s*Inbox$/u, "").trim();

			const items: InboxItem[] = [];

			// Get items from the target inbox (or from the link itself if no target)
			const itemsParentId = target?.id ?? child.id;
			const inboxItems = cacheService.getChildren(itemsParentId);

			for (const item of inboxItems) {
				items.push(this.nodeToInboxItem(item));
			}

			// Fetch children at requested depth using batch queries per level
			if (depth > 0 && items.length > 0) {
				this.fetchChildrenByDepth(cacheService, items, depth);
			}

			inboxes.push({
				id: target?.id ?? child.id,
				name: inboxName,
				linkId: child.id,
				items,
				probableDuplicates: findSameTitleSiblings(items),
			});
		}

		const registeredIds = new Set(inboxes.flatMap((inbox) => [inbox.id, inbox.linkId]));
		const unregisteredInboxes = findUnregisteredInboxes(database, registeredIds);
		for (const inbox of unregisteredInboxes) {
			this.warn(
				`Unregistered inbox: ${inbox.path} (${inbox.id}); absent from Metadata > 📥 Inboxes and excluded from triage.`,
			);
		}

		const itemCount = inboxes.reduce((sum, inbox) => sum + inbox.items.length, 0);

		const output: InboxesOutput = {
			loadedAt: timestamp,
			unregisteredInboxes,
			inboxes,
			itemCount,
		};

		// Write output file
		fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

		// Output summary for the agent
		const summary = {
			loadedAt: output.loadedAt,
			unregisteredInboxes,
			probableDuplicates: inboxes.flatMap((inbox) =>
				inbox.probableDuplicates.map((group) => ({inbox: inbox.name, ...group})),
			),
			inboxCount: output.inboxes.length,
			itemCount: output.itemCount,
		};
		this.log(JSON.stringify(summary));

		return output;
	}

	private nodeToInboxItem(node: {
		id: string;
		name: string | null;
		note: string | null;
		completedAt: Date | null;
	}): InboxItem {
		return {
			id: node.id,
			name: node.name ?? "",
			note: node.note ?? undefined,
			completed: node.completedAt !== null,
			completedAt: node.completedAt ? Math.floor(node.completedAt.getTime() / 1000) : null,
		};
	}

	private fetchChildrenByDepth(cacheService: CacheService, items: InboxItem[], maxDepth: number): void {
		const itemMap = new Map<string, InboxItem>();
		for (const item of items) {
			itemMap.set(item.id, item);
		}

		let currentLevelIds = items.map((item) => item.id);

		for (let currentDepth = 1; currentDepth <= maxDepth; currentDepth++) {
			if (currentLevelIds.length === 0) {
				break;
			}

			const childrenByParent = cacheService.getChildrenForMultipleParents(currentLevelIds);
			const nextLevelIds: string[] = [];

			for (const [parentId, children] of childrenByParent) {
				const parentItem = itemMap.get(parentId);
				if (parentItem && children.length > 0) {
					const childItems = children.map((child) => this.nodeToInboxItem(child));
					parentItem.children = childItems;

					for (const childItem of childItems) {
						itemMap.set(childItem.id, childItem);
						nextLevelIds.push(childItem.id);
					}
				}
			}

			currentLevelIds = nextLevelIds;
		}
	}

	private extractAnchorText(html: string): string {
		const match = html.match(/<a[^>]*>([^<]*)<\/a>/u);
		return match?.[1] ?? html;
	}

	private findProjectRoot(): string {
		let dir = process.cwd();

		while (dir !== "/") {
			if (fs.existsSync(path.join(dir, DEFAULT_DB_FILE)) || fs.existsSync(path.join(dir, "package.json"))) {
				return dir;
			}
			dir = path.dirname(dir);
		}

		return process.cwd();
	}
}
