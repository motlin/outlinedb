import {Command} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheStatusService} from "../../services/cache-status.js";
import type {CacheStatus} from "../../services/cache-status.js";

export default class Status extends Command {
	static override enableJsonFlag = true;

	static override description = "Show cache database status and statistics";

	static override examples = ["<%= config.bin %> cache:status", "<%= config.bin %> cache:status --json"];

	public async run(): Promise<CacheStatus> {
		await this.parse(Status);

		const database = createDatabase();
		const cacheStatusService = new CacheStatusService(database);
		const status = cacheStatusService.getStatus();

		if (!this.jsonEnabled()) {
			this.log("📊 Cache Status\n");

			this.log(`📁 Cached Nodes: ${status.nodes.total}`);
			this.log("");

			this.log("🔄 Last Sync:");
			if (status.lastSync) {
				this.log(`  Time: ${this.formatDate(status.lastSync)}`);
				this.log(`  Age: ${this.getTimeAgo(status.lastSync)}`);
			} else {
				this.log("  No data cached");
			}
			this.log("");

			this.log("💾 Backup Import:");
			if (status.lastBackupImport) {
				this.log(`  Last backup date: ${status.lastBackupImport}`);
			} else {
				this.log("  No backup data imported");
			}
			this.log("");

			const {stranded} = status;
			if (stranded.backlinkItems + stranded.mirrors + stranded.referencesRoots > 0) {
				this.log("⚠️ Stranded Rows:");
				this.log(`  Backlink items without an original: ${stranded.backlinkItems}`);
				this.log(`  Mirror rows without both nodes: ${stranded.mirrors}`);
				this.log(`  References roots without a node: ${stranded.referencesRoots}`);
				this.log("");
			}

			this.log("💿 Database:");
			this.log(`  File: ${status.database.path}`);
			this.log(`  Size: ${status.database.size}`);
		}

		return status;
	}

	private formatDate(date: Date): string {
		return date.toLocaleString();
	}

	private getTimeAgo(date: Date): string {
		const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

		if (seconds < 60) {
			return `${seconds} seconds ago`;
		}

		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) {
			return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
		}

		const hours = Math.floor(minutes / 60);
		if (hours < 24) {
			return `${hours} hour${hours === 1 ? "" : "s"} ago`;
		}

		const days = Math.floor(hours / 24);
		if (days < 30) {
			return `${days} day${days === 1 ? "" : "s"} ago`;
		}

		const months = Math.floor(days / 30);
		if (months < 12) {
			return `${months} month${months === 1 ? "" : "s"} ago`;
		}

		const years = Math.floor(months / 12);
		return `${years} year${years === 1 ? "" : "s"} ago`;
	}
}
