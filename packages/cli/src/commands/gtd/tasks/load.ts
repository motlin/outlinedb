import type {EnhancedWorkflowyNode} from "@workflowy/shared/types";
import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createDatabase} from "../../../db/index.js";
import {CacheService} from "../../../services/cache.js";
import {localLookbackCutoff} from "../../../utils/local-date.js";

interface Task {
	id: string;
	name: string;
	createdAt?: number | null;
}

interface ProjectTask {
	id: string;
	name: string;
	projectName: string;
}

interface Meeting {
	id: string;
	name: string;
	date: string;
}

interface TasksOutput {
	nextActions: Task[];
	projectTasks: ProjectTask[];
	recentMeetings: Meeting[];
}

const ContainerSchema = z.object({id: z.string(), name: z.string()});

const MetadataJsonSchema = z.object({
	destinations: z.object({
		nextActions: z.array(
			z.object({
				id: z.string(),
				targetId: z.string().optional(),
				containers: z
					.object({
						asap: ContainerSchema.nullish(),
						dueDate: ContainerSchema.nullish(),
					})
					.optional(),
			}),
		),
		calendar: z.array(z.object({id: z.string()})),
	}),
	projects: z.array(z.object({linkId: z.string()})),
});

type MetadataJson = z.infer<typeof MetadataJsonSchema>;

/**
 * Load existing tasks for duplicate detection during GTD capture.
 *
 * Reads Next Actions lists, active projects, and recent calendar entries
 * to enable duplicate detection when capturing new items.
 */
export default class Load extends Command {
	static override description = "Load existing tasks for duplicate detection";

	static override examples = [
		"# Load existing tasks (requires metadata.json)",
		"<%= config.bin %> <%= command.id %>",
		"",
		"# Output as formatted JSON",
		"<%= config.bin %> <%= command.id %> --json",
	];

	static override enableJsonFlag = true;

	static override flags = {
		"lookback-days": Flags.integer({
			char: "l",
			description: "Number of days to look back for recent meetings",
			default: 7,
		}),
	};

	private cacheService!: CacheService;

	public async run(): Promise<TasksOutput> {
		const {flags} = await this.parse(Load);

		const projectRoot = this.findProjectRoot();
		const metadataFile = path.join(projectRoot, ".llm", "gtd", "metadata.json");

		// Check that metadata.json exists
		if (!fs.existsSync(metadataFile)) {
			this.error("metadata.json not found. Run gtd:metadata:sync first.");
		}

		const metadata = MetadataJsonSchema.parse(JSON.parse(fs.readFileSync(metadataFile, "utf8")));

		// Initialize cache service
		const database = createDatabase();
		this.cacheService = new CacheService(database);

		// Calculate date threshold for recent meetings
		const cutoffDateStr = localLookbackCutoff(new Date(), flags["lookback-days"]);

		// Fetch all data
		const nextActions = this.fetchNextActionsTasks(metadata);
		const projectTasks = this.fetchProjectTasks(metadata);
		const recentMeetings = await this.fetchRecentMeetings(metadata, cutoffDateStr);

		const output: TasksOutput = {
			nextActions,
			projectTasks,
			recentMeetings,
		};

		if (!this.jsonEnabled()) {
			this.log(JSON.stringify(output, null, 2));
		}

		return output;
	}

	/**
	 * Fetch incomplete tasks from Next Actions lists.
	 */
	private fetchNextActionsTasks(metadata: MetadataJson): Task[] {
		const allTasks: Task[] = [];
		const seenIds = new Set<string>();

		// Extract Next Actions container IDs (asap and dueDate containers)
		const containerIds: string[] = [];
		const targetIds: string[] = [];

		for (const na of metadata.destinations.nextActions) {
			if (na.containers?.asap?.id) {
				containerIds.push(na.containers.asap.id);
			}
			if (na.containers?.dueDate?.id) {
				containerIds.push(na.containers.dueDate.id);
			}
			if (na.targetId) {
				targetIds.push(na.targetId);
			}
		}

		const allIds = [...containerIds, ...targetIds].filter((id) => id !== "" && id !== "null");

		for (const id of allIds) {
			const node = this.cacheService.getNode(id);
			if (!node) {
				continue;
			}

			// Get children (depth 2 to get tasks inside containers)
			const children = this.cacheService.getChildren(id);

			for (const child of children) {
				// Skip the root node itself
				if (child.id === id) {
					continue;
				}

				// Skip completed tasks
				if (child.completedAt) {
					continue;
				}

				// Skip container nodes (emoji prefixes: pushpin, alarm, checkbox, checkmark, page, clipboard)
				if (
					child.name &&
					/^(?:\u{1F4CC}|\u{23F0}|\u{2611}\u{FE0F}?|\u{2705}|\u{1F4C4}|\u{1F4CB})\s/u.test(child.name)
				) {
					continue;
				}

				// Skip empty names
				if (!child.name || child.name.trim().length === 0) {
					continue;
				}

				if (!seenIds.has(child.id)) {
					seenIds.add(child.id);
					allTasks.push({
						id: child.id,
						name: child.name,
						createdAt: child.createdAt ? Math.floor(child.createdAt.getTime() / 1000) : null,
					});
				}

				// Also check grandchildren (depth 2)
				const grandchildren = this.cacheService.getChildren(child.id);
				for (const grandchild of grandchildren) {
					if (grandchild.completedAt) {
						continue;
					}
					if (!grandchild.name || grandchild.name.trim().length === 0) {
						continue;
					}
					if (
						/^(?:\u{1F4CC}|\u{23F0}|\u{2611}\u{FE0F}?|\u{2705}|\u{1F4C4}|\u{1F4CB})\s/u.test(
							grandchild.name,
						)
					) {
						continue;
					}

					if (!seenIds.has(grandchild.id)) {
						seenIds.add(grandchild.id);
						allTasks.push({
							id: grandchild.id,
							name: grandchild.name,
							createdAt: grandchild.createdAt ? Math.floor(grandchild.createdAt.getTime() / 1000) : null,
						});
					}
				}
			}
		}

		return allTasks;
	}

	/**
	 * Fetch tasks from active projects.
	 */
	private fetchProjectTasks(metadata: MetadataJson): ProjectTask[] {
		const allTasks: ProjectTask[] = [];
		const seenIds = new Set<string>();

		const projectIds = metadata.projects.map((p) => p.linkId).filter((id) => id !== "" && id !== "null");

		for (const id of projectIds) {
			const node = this.cacheService.getNode(id);
			if (!node) {
				continue;
			}

			const projectName = node.name ?? "";

			// Get children (depth 2)
			const children = this.cacheService.getChildren(id);

			for (const child of children) {
				// Skip the root node
				if (child.id === id) {
					continue;
				}

				// Skip completed tasks
				if (child.completedAt) {
					continue;
				}

				// Skip project header nodes (emoji prefixes)
				if (
					child.name &&
					/^[\u{1F4C1}\u{1F527}\u{1F4E6}\u{1F3AE}\u{1F310}\u{1F4DD}\u{1F3A8}\u{1F50C}\u{1F6AB}\u{2705}\u{1F3F0}\u{1F981}\u{1F916}\u{1F9EC}]/u.test(
						child.name,
					)
				) {
					continue;
				}

				// Skip nodes that are just hashtags
				if (child.name && /^#[a-z-]+$/iu.test(child.name)) {
					continue;
				}

				// Skip empty names
				if (!child.name || child.name.trim().length === 0) {
					continue;
				}

				if (!seenIds.has(child.id)) {
					seenIds.add(child.id);
					allTasks.push({
						id: child.id,
						name: child.name,
						projectName,
					});
				}

				// Also check grandchildren
				const grandchildren = this.cacheService.getChildren(child.id);
				for (const grandchild of grandchildren) {
					if (grandchild.completedAt) {
						continue;
					}
					if (!grandchild.name || grandchild.name.trim().length === 0) {
						continue;
					}

					if (!seenIds.has(grandchild.id)) {
						seenIds.add(grandchild.id);
						allTasks.push({
							id: grandchild.id,
							name: grandchild.name,
							projectName,
						});
					}
				}
			}

			// Limit per project to prevent excessive output
			if (allTasks.length > 100) {
				break;
			}
		}

		return allTasks.slice(0, 100);
	}

	/**
	 * Fetch recent calendar entries.
	 */
	private async fetchRecentMeetings(metadata: MetadataJson, cutoffDateStr: string): Promise<Meeting[]> {
		const allMeetings: Meeting[] = [];
		const seenIds = new Set<string>();

		const calendarIds = metadata.destinations.calendar.map((c) => c.id).filter((id) => id !== "" && id !== "null");

		// Date pattern to extract from <time> elements
		const timePattern = /<time[^>]*startYear="(\d+)"[^>]*startMonth="(\d+)"[^>]*startDay="(\d+)"/u;

		for (const id of calendarIds) {
			// Fetch calendar with depth to get date nodes and children
			const children = await this.fetchNodeWithDepth(id, 3);

			for (const child of children) {
				// Try to extract date from <time> element in name
				const match = child.name.match(timePattern);
				if (!match) {
					continue;
				}

				const year = match[1];
				const month = String(Number(match[2])).padStart(2, "0");
				const day = String(Number(match[3])).padStart(2, "0");
				const dateStr = `${year}-${month}-${day}`;

				// Skip if before cutoff
				if (dateStr < cutoffDateStr) {
					continue;
				}

				// Get children of this date node (meetings)
				const dateChildren = this.cacheService.getChildren(child.id);
				for (const meeting of dateChildren) {
					if (!meeting.name || meeting.name.trim().length === 0) {
						continue;
					}

					if (!seenIds.has(meeting.id)) {
						seenIds.add(meeting.id);
						allMeetings.push({
							id: meeting.id,
							name: meeting.name,
							date: dateStr,
						});
					}
				}
			}
		}

		return allMeetings;
	}

	/**
	 * Fetch a node and its descendants up to a given depth.
	 */
	private async fetchNodeWithDepth(nodeId: string, depth: number): Promise<EnhancedWorkflowyNode[]> {
		const results: EnhancedWorkflowyNode[] = [];

		const node = this.cacheService.getNode(nodeId);
		if (!node) {
			return results;
		}

		results.push({
			id: node.id,
			name: node.name ?? "",
			note: node.note ?? undefined,
			priority: 0,
			completed: node.completedAt !== null,
			createdAt: node.createdAt ? Math.floor(node.createdAt.getTime() / 1000) : 0,
			modifiedAt: node.modifiedAt ? Math.floor(node.modifiedAt.getTime() / 1000) : 0,
			completedAt: node.completedAt ? Math.floor(node.completedAt.getTime() / 1000) : null,
		});

		if (depth > 0) {
			const children = this.cacheService.getChildren(nodeId);
			for (const child of children) {
				const childResults = await this.fetchNodeWithDepth(child.id, depth - 1);
				results.push(...childResults);
			}
		}

		return results;
	}

	private findProjectRoot(): string {
		let dir = process.cwd();

		while (dir !== "/") {
			if (fs.existsSync(path.join(dir, "workflowy.sqlite")) || fs.existsSync(path.join(dir, "package.json"))) {
				return dir;
			}
			dir = path.dirname(dir);
		}

		return process.cwd();
	}
}
