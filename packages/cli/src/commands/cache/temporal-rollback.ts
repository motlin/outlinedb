import {rebuildNodeTags} from "@workflowy/shared/cache";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {Command, Flags} from "@oclif/core";
import {sql} from "drizzle-orm";
import * as readline from "node:readline/promises";
import {createDatabase} from "../../db/index.js";

const TEMPORAL_TABLES = [
	"node_content",
	"node_metadata",
	"calendar_metadata",
	"calendar_levels",
	"node_embeddings",
	"mirrors",
	"backlinks",
	"virtual_root_ids",
	"ai_metadata",
	"s3_files",
	"changes_metadata",
	"references_roots",
	"backup_imports",
	"api_import_timestamp",
] as const;

interface RollbackCounts {
	table: string;
	purged: number;
	restored: number;
}

export default class TemporalRollback extends Command {
	static override description =
		"Roll back all temporal tables to a previous point in time. This is a destructive operation for disaster recovery.";

	static override examples = [
		'<%= config.bin %> cache:temporal-rollback --to "2026-01-23 00:00:00" --dry-run',
		'<%= config.bin %> cache:temporal-rollback --to "2026-01-23 00:00:00" --exclude node_embeddings',
		'<%= config.bin %> cache:temporal-rollback --to "2026-01-23 00:00:00" --exclude node_embeddings --yes',
	];

	static override flags = {
		to: Flags.string({
			description: 'Target timestamp to roll back to (e.g., "2026-01-23 00:00:00")',
			required: true,
		}),
		exclude: Flags.option({
			description: "Table to exclude from rollback (repeatable)",
			options: TEMPORAL_TABLES,
			multiple: true,
			default: [],
		})(),
		"dry-run": Flags.boolean({
			description: "Show row counts without executing",
			default: false,
		}),
		yes: Flags.boolean({
			char: "y",
			description: "Skip confirmation prompt",
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(TemporalRollback);
		const target = flags.to;

		// Validate timestamp format
		if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u.test(target)) {
			this.error('Invalid timestamp format. Expected: "YYYY-MM-DD HH:MM:SS"');
		}

		const excludeSet = new Set(flags.exclude);
		const tables = TEMPORAL_TABLES.filter((t) => !excludeSet.has(t));

		const db = createDatabase();

		// Discover which tables actually exist in the database
		const existingTables = new Set(
			db.all<{name: string}>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name),
		);

		const skippedTables: string[] = [];

		// Gather counts for preview
		const counts: RollbackCounts[] = [];
		for (const table of tables) {
			if (!existingTables.has(table)) {
				skippedTables.push(table);
				continue;
			}

			const purgeResult = db.get<{count: number}>(
				sql.raw(`SELECT COUNT(*) as count FROM ${table} WHERE system_from > '${target}'`),
			);
			const restoreResult = db.get<{count: number}>(
				sql.raw(
					`SELECT COUNT(*) as count FROM ${table} WHERE system_from <= '${target}' AND system_to > '${target}' AND system_to != '${FAR_FUTURE_DATE}'`,
				),
			);

			counts.push({
				table,
				purged: purgeResult.count,
				restored: restoreResult.count,
			});
		}

		// Display summary
		this.log(`\nTemporal rollback to: ${target}`);
		if (flags.exclude.length > 0) {
			this.log(`Excluding: ${flags.exclude.join(", ")}`);
		}

		if (skippedTables.length > 0) {
			this.log(`Skipped (not in database): ${skippedTables.join(", ")}`);
		}

		this.log("");
		this.log(this.formatTable(counts));

		const totalPurged = counts.reduce((sum, c) => sum + c.purged, 0);
		const totalRestored = counts.reduce((sum, c) => sum + c.restored, 0);
		this.log(
			`\nTotal: ${totalPurged.toLocaleString()} rows to purge, ${totalRestored.toLocaleString()} rows to restore`,
		);

		if (flags["dry-run"]) {
			this.log("\n(dry run - no changes made)");
			return;
		}

		// Confirm
		if (!flags.yes) {
			if (totalPurged === 0 && totalRestored === 0) {
				this.log("\nNothing to do.");
				return;
			}

			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});

			const answer = await rl.question("\nThis is a destructive operation. Continue? (y/n) ");
			rl.close();

			if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
				this.log("Rollback cancelled.");
				return;
			}
		}

		// Execute rollback in a single transaction (only for tables that exist)
		const rollbackTables = counts.map((c) => c.table);
		db.transaction((tx) => {
			for (const table of rollbackTables) {
				tx.run(sql.raw(`DELETE FROM ${table} WHERE system_from > '${target}'`));
				tx.run(
					sql.raw(
						`UPDATE ${table} SET system_to = '${FAR_FUTURE_DATE}' WHERE system_from <= '${target}' AND system_to > '${target}'`,
					),
				);
			}
			// node_tags is derived from the live content this just rewound, outside any unit of work.
			rebuildNodeTags(tx);
		});

		this.log(
			`\nRollback complete. ${totalPurged.toLocaleString()} rows purged, ${totalRestored.toLocaleString()} rows restored.`,
		);
	}

	private formatTable(counts: RollbackCounts[]): string {
		type Row = [string, string, string];
		const header: Row = ["Table", "Purge", "Restore"];
		const rows = counts.map((c): Row => [c.table, c.purged.toLocaleString(), c.restored.toLocaleString()]);

		// Calculate column widths
		const columnWidth = (column: 0 | 1 | 2) => Math.max(...[header, ...rows].map((r) => r[column].length));
		const widths: [number, number, number] = [columnWidth(0), columnWidth(1), columnWidth(2)];

		const separator = widths.map((w) => "-".repeat(w)).join("  ");
		const formatRow = ([table, purged, restored]: Row) =>
			[table.padEnd(widths[0]), purged.padStart(widths[1]), restored.padStart(widths[2])].join("  ");

		return [formatRow(header), separator, ...rows.map((row) => formatRow(row))].join("\n");
	}
}
