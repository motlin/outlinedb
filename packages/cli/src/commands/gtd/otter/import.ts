import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createDatabase} from "../../../db/index.js";
import {CacheService} from "../../../services/cache.js";
import {logger} from "../../../services/logger.js";

const MeetingSchema = z.object({
	otid: z.string(),
	title: z
		.string()
		.nullable()
		.transform((title) => title ?? "Untitled meeting"),
	start_time: z.number(),
	summary: z.string().nullable(),
	outline: z.array(z.object({title: z.string(), segments: z.array(z.string())})),
	action_items: z
		.array(z.object({text: z.string(), assignee: z.string().nullable(), completed: z.boolean()}))
		.optional(),
});

type Meeting = z.infer<typeof MeetingSchema>;

const SyncOutputSchema = z.object({speeches: z.array(MeetingSchema)});

const ImportStateSchema = z.object({
	imported_otids: z.array(z.string()),
	imported_count: z.number(),
});

type ImportState = z.infer<typeof ImportStateSchema>;

const DEFAULT_CALENDAR_ID = "8111d11c-b80e-f219-8ac3-08567aa37346";
const STATE_FILE = "/tmp/otter_import_state.json";

/**
 * Efficient Otter meeting import using multiline markdown.
 *
 * Uses ~12 POST calls per meeting instead of 88 (JSON mode).
 */
export default class Import extends Command {
	static override description = "Import Otter meetings to Workflowy Calendar";

	static override examples = [
		"# Import meetings with 5 second delay between API calls",
		"<%= config.bin %> <%= command.id %>",
		"",
		"# Import with custom delay and max count",
		"<%= config.bin %> <%= command.id %> --delay 3 --max 10",
		"",
		"# Reset state and start fresh",
		"<%= config.bin %> <%= command.id %> --reset",
	];

	static override flags = {
		delay: Flags.integer({
			char: "d",
			description: "Seconds between API calls",
			default: 5,
		}),
		max: Flags.integer({
			char: "m",
			description: "Maximum meetings to import (0 = unlimited)",
			default: 0,
		}),
		reset: Flags.boolean({
			description: "Reset import state and start fresh",
			default: false,
		}),
		"calendar-id": Flags.string({
			description: "Calendar node ID to import into",
			default: DEFAULT_CALENDAR_ID,
		}),
		"dry-run": Flags.boolean({
			description: "Show what would be imported without creating nodes",
			default: false,
		}),
	};

	private client!: WorkflowyWriteThroughClient;
	private delay = 5;

	public async run(): Promise<{imported: number; total: number}> {
		const {flags} = await this.parse(Import);

		this.delay = flags.delay;

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey) {
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		const apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		const database = createDatabase();
		const cacheService = new CacheService(database);
		this.client = new WorkflowyWriteThroughClient(apiClient, cacheService);

		this.log("=== Otter Import ===");
		this.log(`Delay between meetings: ${flags.delay}s`);
		if (flags.max > 0) {
			this.log(`Max meetings: ${flags.max}`);
		}
		if (flags["dry-run"]) {
			this.log("DRY RUN - no nodes will be created");
		}
		this.log("");

		// Load or initialize state
		let state: ImportState = {imported_otids: [], imported_count: 0};

		if (flags.reset && fs.existsSync(STATE_FILE)) {
			fs.unlinkSync(STATE_FILE);
			this.log("State reset");
		} else if (fs.existsSync(STATE_FILE)) {
			state = ImportStateSchema.parse(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
			this.log(`Resuming: ${state.imported_count} meetings already imported`);
		}

		// Fetch meetings using otter:sync
		this.log("");
		this.log("Fetching meetings from Otter...");

		const projectRoot = this.findProjectRoot();
		const syncOutput = await this.runOtterSync(projectRoot);

		if (syncOutput.speeches.length === 0) {
			this.log("No meetings to import");
			return {imported: 0, total: state.imported_count};
		}

		this.log(`Got ${syncOutput.speeches.length} meetings`);

		// Process meetings
		let totalImported = 0;

		for (const meeting of syncOutput.speeches) {
			// Skip if already imported
			if (state.imported_otids.includes(meeting.otid)) {
				continue;
			}

			// Skip if no summary (not processed by Otter)
			if (!meeting.summary) {
				this.log(`  Skipping (not processed): ${meeting.title}`);
				continue;
			}

			// Import meeting
			if (flags["dry-run"]) {
				this.log(`  Would import: ${meeting.title}`);
			} else {
				const success = await this.importMeeting(meeting, flags["calendar-id"]);
				if (success) {
					state.imported_count++;
					totalImported++;
					state.imported_otids.push(meeting.otid);

					// Save state
					fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
				}
			}

			// Check max
			if (flags.max > 0 && totalImported >= flags.max) {
				this.log("");
				this.log(`Reached max meetings limit (${flags.max})`);
				break;
			}
		}

		this.log("");
		this.log("=== Import Complete ===");
		this.log(`Total imported this run: ${totalImported}`);
		this.log(`Total imported overall: ${state.imported_count}`);

		return {imported: totalImported, total: state.imported_count};
	}

	private async runOtterSync(projectRoot: string): Promise<{speeches: Meeting[]}> {
		// Run otter:sync command to get meetings
		// For now, we'll shell out to the CLI itself
		const {execSync} = await import("node:child_process");
		const cliPath = path.join(projectRoot, "bin", "run.js");

		try {
			const result = execSync(`"${cliPath}" gtd:otter:sync --page-size 100 2>/dev/null`, {
				encoding: "utf8",
				env: process.env,
				cwd: projectRoot,
			});
			return SyncOutputSchema.parse(JSON.parse(result));
		} catch (error) {
			// Try running the bash script as fallback
			const scriptPath = path.join(projectRoot, ".claude", "scripts", "gtd", "otter-api.sh");
			if (fs.existsSync(scriptPath)) {
				const result = execSync(`"${scriptPath}" sync 100`, {
					encoding: "utf8",
					env: process.env,
					cwd: projectRoot,
				});
				return SyncOutputSchema.parse(JSON.parse(result));
			}
			throw error;
		}
	}

	private async importMeeting(meeting: Meeting, calendarId: string): Promise<boolean> {
		this.log(`  Importing: ${meeting.title}`);

		try {
			// Build time tag
			const timeTag = this.formatTimeTag(meeting.start_time);

			// 1. Create meeting header
			const escapedTitle = this.escapeHtml(meeting.title);
			const header = `<a href="https://otter.ai/u/${meeting.otid}">${escapedTitle}</a> #meeting ${timeTag}`;
			const meetingNode = await this.client.createNode({
				parent_id: calendarId,
				name: header,
				position: "bottom",
			});
			await this.sleep(this.delay);

			this.log(`    Created meeting: ${meetingNode.id}`);

			// 2. Create URL (leaf)
			await this.client.createNode({
				parent_id: meetingNode.id,
				name: `otter.ai/u/${meeting.otid}`,
				position: "bottom",
			});
			await this.sleep(this.delay);

			// 3. Create Overview + summary
			if (meeting.summary) {
				const escapedSummary = this.escapeHtml(meeting.summary);
				const overviewMd = `- <b>Overview</b>\n  - ${escapedSummary}`;
				await this.client.createNode({
					parent_id: meetingNode.id,
					name: overviewMd,
					position: "bottom",
				});
				await this.sleep(this.delay);
			}

			// 4. Create Action Items
			if (meeting.action_items && meeting.action_items.length > 0) {
				let actionMd = "- <b>Action Items</b>";

				for (const item of meeting.action_items) {
					const escapedText = this.escapeHtml(item.text);
					const checkbox = item.completed ? "[x]" : "[ ]";

					actionMd += item.assignee
						? `\n  - ${checkbox} ${escapedText} (@${item.assignee})`
						: `\n  - ${checkbox} ${escapedText}`;
				}

				await this.client.createNode({
					parent_id: meetingNode.id,
					name: actionMd,
					position: "bottom",
				});
				await this.sleep(this.delay);

				this.log(`    Created ${meeting.action_items.length} action items`);
			}

			// 5. Create Outline
			if (meeting.outline.length > 0) {
				// Create Outline header
				const outlineNode = await this.client.createNode({
					parent_id: meetingNode.id,
					name: "<b>Outline</b>",
					position: "bottom",
				});
				await this.sleep(this.delay);

				// Create each section with segments
				for (const section of meeting.outline) {
					const escapedSectionTitle = this.escapeHtml(section.title);
					let sectionMd = `- <b>${escapedSectionTitle}</b>`;

					for (const segment of section.segments) {
						const escapedSegment = this.escapeHtml(segment);
						sectionMd += `\n  - ${escapedSegment}`;
					}

					await this.client.createNode({
						parent_id: outlineNode.id,
						name: sectionMd,
						position: "bottom",
					});
					await this.sleep(this.delay);
				}

				this.log(`    Created ${meeting.outline.length} outline sections`);
			}

			return true;
		} catch (error) {
			this.log(`    ERROR: ${error instanceof Error ? error.message : "Unknown error"}`);
			return false;
		}
	}

	private formatTimeTag(timestamp: number): string {
		const date = new Date(timestamp * 1000);
		const year = date.getFullYear();
		const month = date.getMonth(); // 0-indexed for Workflowy
		const day = date.getDate();
		const hour = date.getHours().toString().padStart(2, "0");
		const min = date.getMinutes().toString().padStart(2, "0");

		// Format readable date
		const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const dayName = days[date.getDay()];
		const monthName = months[month];

		let hours12 = date.getHours() % 12;
		if (hours12 === 0) {
			hours12 = 12;
		}
		const ampm = date.getHours() >= 12 ? "pm" : "am";
		const readable = `${dayName}, ${monthName} ${day}, ${year} at ${hours12}:${min}${ampm}`;

		return `<time startYear="${year}" startMonth="${month}" startDay="${day}" startHour="${hour}" startMinute="${min}">${readable}</time>`;
	}

	private escapeHtml(text: string): string {
		return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
	}

	private async sleep(seconds: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, seconds * 1000);
		});
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
