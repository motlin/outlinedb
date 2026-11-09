import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {NodeTreeReader, PathBuilder, systemFromToDate} from "@outlinedb/shared/cache";
import type {NodeTree} from "@outlinedb/shared/cache";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../db/index.js";
import {CacheService} from "../services/cache.js";
import {logger} from "../services/logger.js";
import {formatDuration} from "../utils/format-duration.js";
import {htmlToAnsi} from "../utils/html-to-ansi.js";

export interface ListCommandFlags {
	"force-refresh": boolean;
	json: boolean;
	depth: number;
	"follow-links": boolean;
	fields?: string[];
}

function isKeyOf<T extends object>(object: T, key: PropertyKey): key is keyof T {
	return key in object;
}

export abstract class BaseListCommand extends Command {
	static hidden = true;

	protected apiClient: WorkflowyApiClient | null = null;
	#cacheService?: CacheService;
	#pathBuilder?: PathBuilder;

	protected get cacheService(): CacheService {
		return (this.#cacheService ??= new CacheService(createDatabase()));
	}

	protected get pathBuilder(): PathBuilder {
		return (this.#pathBuilder ??= new PathBuilder(createDatabase()));
	}

	static baseFlags = {
		"force-refresh": Flags.boolean({
			char: "f",
			description: "Force refresh from API, ignoring cache",
			default: false,
		}),
		json: Flags.boolean({
			char: "j",
			description: "Output all node details in JSON format",
			default: false,
		}),
		depth: Flags.integer({
			description: "Depth of children to fetch (0 = no children, 1 = direct children only, etc.)",
			default: 0,
			min: 0,
			max: 10,
		}),
		"follow-links": Flags.boolean({
			char: "l",
			description: "Follow Workflowy links in node names to include linked node children (requires --depth > 0)",
			default: false,
		}),
		fields: Flags.string({
			description:
				'Comma-separated list of fields to include in JSON output (e.g., "id,name,note,children"). Reduces output size for LLM processing.',
			multiple: true,
		}),
	};

	/**
	 * Parse fields from flags, handling comma-separated values.
	 * E.g., ["id,name,note"] becomes ["id", "name", "note"]
	 */
	protected parseFields(fieldsInput: string[]): string[] {
		return fieldsInput.flatMap((f) => f.split(",").map((s) => s.trim()));
	}

	/**
	 * Filter a node to only include specified fields.
	 * Always includes 'id' for identification.
	 * The 'children' and 'linkTargets' fields are recursively filtered if requested.
	 */
	protected filterNodeFields(node: NodeTree, fields: string[]): Record<string, unknown> {
		// Always include 'id' for identification
		const fieldsSet = new Set([...fields, "id"]);

		const result: Record<string, unknown> = {};
		for (const field of fieldsSet) {
			if (field === "children" && node.children) {
				result.children = node.children.map((child) => this.filterNodeFields(child, fields));
			} else if (field === "linkTargets" && node.linkTargets) {
				result.linkTargets = node.linkTargets.map((target) => ({
					id: target.id,
					name: target.name,
					shortId: target.shortId,
				}));
			} else if (isKeyOf(node, field)) {
				result[field] = node[field];
			}
		}
		// Always include mirror metadata for mirrors.
		if (node.mirror.isMirror) {
			result.mirror = node.mirror;
		}
		return result;
	}

	protected initializeApiClient(): void {
		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (apiKey) {
			this.apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		}
	}

	protected async fetchNodesWithCacheFallback(
		parentId: string | null,
		flags: ListCommandFlags,
		fetchFromApi: () => Promise<WorkflowyNode[]>,
	): Promise<{nodes: NodeTree[]; fromApi: boolean}> {
		let fetchedFromApi = false;

		// Try API first if force-refresh or no cached data
		const cachedNodes = this.cacheService.getChildrenWithMergedData(parentId);
		const hasCachedData = cachedNodes.length > 0;
		const shouldRefresh = flags["force-refresh"] || !hasCachedData;

		if (shouldRefresh && this.apiClient) {
			try {
				const apiNodes = await fetchFromApi();
				this.cacheService.storeApiResponse(apiNodes, parentId);
				if (!flags.json) {
					this.log(`Fetched fresh data from API`);
				}
				fetchedFromApi = true;
			} catch (apiError) {
				if (!hasCachedData && !flags.json) {
					this.warn(`API request failed, falling back to cache: ${String(apiError)}`);
				}
			}
		}

		const nodes = await new NodeTreeReader(this.cacheService).readChildren(parentId, {
			depth: flags.depth,
			followLinks: flags["follow-links"],
		});
		if (nodes.length > 0 && !flags.json && !fetchedFromApi) {
			const cacheAge = this.calculateCacheAge(nodes);
			this.log(`Using cached data (age: ${formatDuration(cacheAge)}, sources: cache)`);
		}

		return {nodes, fromApi: fetchedFromApi};
	}

	/**
	 * Calculate cache age in seconds from the oldest systemFrom timestamp.
	 */
	private calculateCacheAge(nodes: {systemFrom: string}[]): number {
		const fetchTimes = nodes.map((n) => systemFromToDate(n.systemFrom).getTime());
		const oldestFetch = fetchTimes.length > 0 ? Math.min(...fetchTimes) : undefined;
		return oldestFetch !== undefined && oldestFetch !== 0 ? Math.floor((Date.now() - oldestFetch) / 1000) : 0;
	}

	protected async displayNodes(nodes: NodeTree[], flags: ListCommandFlags): Promise<void> {
		if (flags.json) {
			const {fields} = flags;
			const output = fields ? nodes.map((node) => this.filterNodeFields(node, this.parseFields(fields))) : nodes;
			this.log(JSON.stringify(output, null, 2));
		} else if (nodes.length === 0) {
			this.log("No nodes found");
		} else {
			this.log(`Nodes (${nodes.length}):`);
			await this.displayNodesRecursive(nodes, 0, flags.depth > 0);
		}
	}

	private async displayNodesRecursive(nodes: NodeTree[], depth: number, showTreeStructure: boolean): Promise<void> {
		for (const [i, node] of nodes.entries()) {
			const isLast = i === nodes.length - 1;

			const completedIndicator = node.completedAt ? "✓ " : "";
			const noteIndicator = node.note ? "📝 " : "";
			const mirrorIndicator = node.mirror.isMirror ? "🪞 " : "";
			const layoutIndicator =
				node.layoutMode && node.layoutMode !== "bullets" ? this.getLayoutModeEmoji(node.layoutMode) : "";
			const backlinksIndicator = this.hasBacklinks(node) ? "↗️ " : "";
			const aiChatIndicator = node.inChat ? "💬 " : "";
			const referencesRootIndicator = node.hasReferencesRoot ? "🔗 " : "";
			const linkTargetsIndicator = node.linkTargets && node.linkTargets.length > 0 ? "🔗→ " : "";

			let prefix: string;
			let urlPrefix: string;
			if (showTreeStructure) {
				const indent = "│   ".repeat(depth);
				const branch = isLast ? "└── " : "├── ";
				prefix = indent + branch;
				const urlIndent = depth > 0 ? "│   ".repeat(depth) : "";
				urlPrefix = `${urlIndent + (isLast ? "    " : "│   ")}    `;
			} else {
				prefix = "  ";
				urlPrefix = "     ";
			}

			const nodeName = htmlToAnsi(node.name ?? "");
			const greyUrl = `\u001B[90mhttps://workflowy.com/#/${node.id}\u001B[0m`;

			this.log(
				`${prefix}${completedIndicator}${noteIndicator}${mirrorIndicator}${layoutIndicator}${backlinksIndicator}${aiChatIndicator}${referencesRootIndicator}${linkTargetsIndicator}${nodeName}`,
			);
			this.log(`${urlPrefix}🔗 ${greyUrl}`);

			if (node.children && node.children.length > 0) {
				await this.displayNodesRecursive(node.children, depth + 1, showTreeStructure);
			}

			// Display linkTargets if present
			if (node.linkTargets && node.linkTargets.length > 0) {
				for (const target of node.linkTargets) {
					const targetIndent = showTreeStructure ? "│   ".repeat(depth + 1) : "    ";
					this.log(`${targetIndent}↳ Link target: ${htmlToAnsi(target.name ?? "")}`);
					this.log(`${targetIndent}  🔗 \u001B[90mhttps://workflowy.com/#/${target.shortId}\u001B[0m`);
					if (target.children && target.children.length > 0) {
						await this.displayNodesRecursive(target.children, depth + 2, showTreeStructure);
					}
				}
			}
		}
	}

	private getLayoutModeEmoji(layoutMode: string): string {
		switch (layoutMode) {
			case "todo": {
				return "☑️ ";
			}
			case "headings": {
				return "📋 ";
			}
			default: {
				return `[${layoutMode}] `;
			}
		}
	}

	private hasBacklinks(node: NodeTree): boolean {
		const backlinkPrefix = '<a href="https://workflowy.com/#/';
		return (node.name ?? "").includes(backlinkPrefix) || (node.note ?? "").includes(backlinkPrefix);
	}
}
