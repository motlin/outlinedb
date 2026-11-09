import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {createDatabase} from "../../../db/index.js";
import {CacheService} from "../../../services/cache.js";
import {DEFAULT_DB_FILE} from "../../../db/default-db-file.js";

interface ProjectItem {
	id: string;
	name: string;
}

interface Project {
	id: string;
	name: string;
	linkId: string;
	tag: string;
	context: string;
	items: ProjectItem[];
}

interface PersonMember {
	id: string;
	name: string;
	tag: string;
}

interface NextActionsDestination {
	id: string;
	targetId: string | null;
	name: string;
	context: string;
	containers: {
		asap: {id: string; name: string} | null;
		dueDate: {id: string; name: string} | null;
	};
}

interface SimpleDestination {
	id: string;
	name: string;
	context: string;
}

interface MetadataOutput {
	syncedAt: string;
	reviewNodeId: string | null;
	reviewNodeName: string | null;
	projects: Project[];
	people: Record<string, PersonMember[]>;
	contexts: {
		location: string[];
		mode: string[];
	};
	destinations: {
		nextActions: NextActionsDestination[];
		waitingFor: SimpleDestination[];
		calendar: SimpleDestination[];
		someday: SimpleDestination[];
	};
}

/**
 * Context tags suggested to GTD prompts. No #work/#personal (they only repeat a
 * task's Work or Personal area) and no #computer.
 */
export const GTD_CONTEXTS: MetadataOutput["contexts"] = {
	location: ["#home", "#errands", "#anywhere"],
	mode: ["#call", "#email", "#read", "#buy", "#waiting"],
};

// EnhancedNode type for future API mode support
// interface EnhancedNode extends WorkflowyNode {
// 	linkTargets?: WorkflowyNode[];
// 	children?: EnhancedNode[];
// }

/**
 * Sync GTD metadata to .llm/gtd/metadata.json
 *
 * Fetches projects, people, and contexts from Workflowy and writes
 * a normalized JSON structure for fast offline access by refinement agents.
 */
export default class Sync extends Command {
	static override description = "Sync GTD metadata from Workflowy to local JSON";

	static override examples = [
		"# Sync metadata from cache (default)",
		"<%= config.bin %> <%= command.id %>",
		"",
		"# Force sync from API",
		"<%= config.bin %> <%= command.id %> --data-source api",
	];

	static override flags = {
		"data-source": Flags.string({
			char: "s",
			description: "Data source to use",
			options: ["cache", "api"],
			default: "cache",
		}),
	};

	private cacheService!: CacheService;

	public async run(): Promise<MetadataOutput> {
		// Parse flags (data-source flag reserved for future API mode)
		await this.parse(Sync);

		const projectRoot = this.findProjectRoot();
		const outputFile = path.join(projectRoot, ".llm", "gtd", "metadata.json");

		// Ensure .llm/gtd directory exists
		const gtdDir = path.dirname(outputFile);
		if (!fs.existsSync(gtdDir)) {
			fs.mkdirSync(gtdDir, {recursive: true});
		}

		// Initialize cache service
		const database = createDatabase();
		this.cacheService = new CacheService(database);

		const timestamp = new Date().toISOString();

		// Fetch all metadata sections
		const projects = this.fetchProjects();
		const people = this.fetchPeople();
		const nextActions = this.fetchNextActions();
		const waitingFor = this.fetchWaitingFor();
		const calendar = this.fetchCalendar();
		const someday = this.fetchSomeday();
		const review = this.fetchReview();

		const output: MetadataOutput = {
			syncedAt: timestamp,
			reviewNodeId: review.id,
			reviewNodeName: review.name,
			projects,
			people,
			contexts: GTD_CONTEXTS,
			destinations: {
				nextActions,
				waitingFor,
				calendar,
				someday,
			},
		};

		// Write output file
		fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

		// Output summary for the agent
		const summary = {
			syncedAt: output.syncedAt,
			projectCount: output.projects.length,
			peopleCount: Object.values(output.people).reduce((sum, arr) => sum + arr.length, 0),
			destinationCount:
				output.destinations.nextActions.length +
				output.destinations.waitingFor.length +
				output.destinations.calendar.length +
				output.destinations.someday.length,
			reviewNodeId: output.reviewNodeId,
			reviewNodeName: output.reviewNodeName,
		};
		this.log(JSON.stringify(summary));

		return output;
	}

	/**
	 * Fetch projects from Metadata > Projects
	 */
	private fetchProjects(): Project[] {
		const projectsPath = ["Metadata", "\u{1F4C1} Projects"];
		const projectsNode = this.cacheService.findNodeByPath(projectsPath);

		if (!projectsNode) {
			return [];
		}

		const children = this.cacheService.getChildren(projectsNode.id);
		const projects: Project[] = [];

		for (const child of children) {
			// Get link target if this is a link
			const linkTarget = this.getLinkTarget(child.id);
			const target = linkTarget ?? child;

			// Get name from target or extract from anchor text
			let projectName = target.name ?? "";
			projectName = this.extractAnchorText(projectName);
			projectName = projectName.replace(/\s*\u{1F4C1}\s*Projects?$/u, "").trim();

			// Extract context from link node name
			const context = this.extractContext(child.name ?? "");

			// Get project items (children of target)
			const items: ProjectItem[] = [];
			const targetChildren = this.cacheService.getChildren(target.id);
			for (const item of targetChildren.slice(0, 20)) {
				items.push({
					id: item.id,
					name: item.name ?? "",
				});
			}

			projects.push({
				id: child.id,
				name: projectName,
				linkId: target.id,
				tag: `#${projectName.replaceAll(/\s+/gu, "-").toLowerCase()}`,
				context,
				items,
			});
		}

		return projects;
	}

	/**
	 * Fetch people from Metadata > People
	 */
	private fetchPeople(): Record<string, PersonMember[]> {
		const peoplePath = ["Metadata", "\u{1F465} People"];
		const peopleNode = this.cacheService.findNodeByPath(peoplePath);

		if (!peopleNode) {
			return {};
		}

		const categories = this.cacheService.getChildren(peopleNode.id);
		const people: Record<string, PersonMember[]> = {};

		for (const category of categories) {
			const categoryName = category.name ?? "Unknown";
			const members = this.cacheService.getChildren(category.id);

			people[categoryName] = members.map((member) => ({
				id: member.id,
				name: member.name ?? "",
				tag: `@${(member.name ?? "").replaceAll(/\s+/gu, "")}`,
			}));
		}

		return people;
	}

	/**
	 * Fetch Next Actions destinations
	 */
	private fetchNextActions(): NextActionsDestination[] {
		const naPath = ["Metadata", "\u{2611}\u{FE0F} Next Actions"];
		const naNode = this.cacheService.findNodeByPath(naPath);

		if (!naNode) {
			return [];
		}

		const children = this.cacheService.getChildren(naNode.id);
		const destinations: NextActionsDestination[] = [];

		for (const child of children) {
			// Get link target
			const linkTarget = this.getLinkTarget(child.id);
			const target = linkTarget ?? child;

			// Get name
			let name = target.name ?? child.name ?? "";
			name = this.extractAnchorText(name);

			// Extract context
			const context = this.extractContext(child.name ?? "");

			// Find asap and dueDate containers in target children
			let asap: {id: string; name: string} | null = null;
			let dueDate: {id: string; name: string} | null = null;

			const targetChildren = this.cacheService.getChildren(target.id);
			for (const tc of targetChildren) {
				const tcName = tc.name ?? "";
				if (/asap/iu.test(tcName)) {
					asap = {id: tc.id, name: tcName};
				} else if (/due/iu.test(tcName)) {
					dueDate = {id: tc.id, name: tcName};
				}
			}

			destinations.push({
				id: child.id,
				targetId: target.id,
				name,
				context,
				containers: {asap, dueDate},
			});
		}

		return destinations;
	}

	/**
	 * Fetch Waiting For destinations
	 */
	private fetchWaitingFor(): SimpleDestination[] {
		const wfPath = ["Metadata", "\u{1F4E4} Waiting For"];
		const wfNode = this.cacheService.findNodeByPath(wfPath);

		if (!wfNode) {
			return [];
		}

		const children = this.cacheService.getChildren(wfNode.id);
		return this.mapToSimpleDestinations(children);
	}

	/**
	 * Fetch Calendar destinations
	 */
	private fetchCalendar(): SimpleDestination[] {
		const calPath = ["Metadata", "\u{1F4C5} Calendar"];
		const calNode = this.cacheService.findNodeByPath(calPath);

		if (!calNode) {
			return [];
		}

		const children = this.cacheService.getChildren(calNode.id);
		return this.mapToSimpleDestinations(children);
	}

	/**
	 * Fetch Someday destinations
	 */
	private fetchSomeday(): SimpleDestination[] {
		const sdPath = ["Metadata", "\u{1F331} Someday"];
		const sdNode = this.cacheService.findNodeByPath(sdPath);

		if (!sdNode) {
			return [];
		}

		const children = this.cacheService.getChildren(sdNode.id);
		return this.mapToSimpleDestinations(children);
	}

	/**
	 * Fetch Review node
	 */
	private fetchReview(): {id: string | null; name: string | null} {
		const reviewPath = ["Metadata", "\u{1F504} Review"];
		const reviewNode = this.cacheService.findNodeByPath(reviewPath);

		if (!reviewNode) {
			return {id: null, name: null};
		}

		// Check for link target
		const linkTarget = this.getLinkTarget(reviewNode.id);
		const target = linkTarget ?? reviewNode;

		return {
			id: target.id,
			name: target.name ?? reviewNode.name ?? null,
		};
	}

	/**
	 * Map children to simple destinations
	 */
	private mapToSimpleDestinations(children: {id: string; name?: string | null}[]): SimpleDestination[] {
		const destinations: SimpleDestination[] = [];

		for (const child of children) {
			const linkTarget = this.getLinkTarget(child.id);
			const target = linkTarget ?? child;

			let name = target.name ?? child.name ?? "";
			name = this.extractAnchorText(name);

			const context = this.extractContext(child.name ?? "");

			destinations.push({
				id: child.id,
				name,
				context,
			});
		}

		return destinations;
	}

	/**
	 * Get the link target for a node if it's a link
	 */
	private getLinkTarget(nodeId: string): {id: string; name?: string | null} | null {
		// Check if this node has any mirrors (is a mirror of another node)
		const originalId = this.cacheService.getMirrorOriginal(nodeId);
		if (originalId) {
			const original = this.cacheService.getNode(originalId);
			if (original) {
				return {id: original.id, name: original.name};
			}
		}

		return null;
	}

	/**
	 * Extract text from anchor tag: <a href="...">Text</a> -> Text
	 */
	private extractAnchorText(html: string): string {
		const match = html.match(/<a[^>]*>([^<]*)<\/a>/u);
		return match?.[1] ?? html;
	}

	/**
	 * Extract context from link node name.
	 * "Personal Projects" -> "personal"
	 * "Work Next Actions" -> "work"
	 */
	private extractContext(name: string): string {
		const text = this.extractAnchorText(name);
		// Remove emoji markers and everything after (folder, checkbox, outbox, calendar, seedling)
		const emojiPattern = /\s*(?:\u{1F4C1}|\u{2611}\u{FE0F}?|\u{1F4E4}|\u{1F4C5}|\u{1F331}).*$/u;
		const cleaned = text.replace(emojiPattern, "");
		return cleaned.toLowerCase().trim();
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
