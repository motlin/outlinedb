import {Command} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheVacuumService, formatBytes} from "../../services/cache-vacuum.js";
import type {VacuumResult} from "../../services/cache-vacuum.js";

export default class Vacuum extends Command
{
	static override enableJsonFlag = true;

	static override description =
		"Reclaim dead pages from the cache database by running VACUUM, shrinking the file on disk";

	static override examples = ["<%= config.bin %> cache:vacuum", "<%= config.bin %> cache:vacuum --json"];

	public async run(): Promise<VacuumResult>
	{
		await this.parse(Vacuum);

		const database = createDatabase();
		const cacheVacuumService = new CacheVacuumService(database);

		if (!this.jsonEnabled())
		{
			this.log("🧹 Vacuuming cache database...");
		}

		const result = cacheVacuumService.vacuum();

		if (!this.jsonEnabled())
		{
			const reclaimedBytes = result.sizeBeforeBytes - result.sizeAfterBytes;
			this.log(`  File: ${result.path}`);
			this.log(`  Size before: ${formatBytes(result.sizeBeforeBytes)}`);
			this.log(`  Size after:  ${formatBytes(result.sizeAfterBytes)}`);
			this.log(`  Reclaimed:   ${formatBytes(Math.max(0, reclaimedBytes))}`);
			this.log(`  Freelist pages: ${result.freelistBefore} → ${result.freelistAfter}`);
		}

		return result;
	}
}
