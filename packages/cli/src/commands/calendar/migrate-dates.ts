import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {currentVersion, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {Command, Flags} from "@oclif/core";
import {and, eq, isNotNull, notLike, sql} from "drizzle-orm";
import {alias} from "drizzle-orm/sqlite-core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {drainAfterWrite, openLocalWrites} from "../../services/local-writes.js";
import {logger} from "../../services/logger.js";

const MONTH_ABBREVS: Record<string, number> =
{
	Jan: 1,
	Feb: 2,
	Mar: 3,
	Apr: 4,
	May: 5,
	Jun: 6,
	Jul: 7,
	Aug: 8,
	Sep: 9,
	Oct: 10,
	Nov: 11,
	Dec: 12,
};

const MONTH_NAMES: Record<string, number> =
{
	January: 1,
	February: 2,
	March: 3,
	April: 4,
	May: 5,
	June: 6,
	July: 7,
	August: 8,
	September: 9,
	October: 10,
	November: 11,
	December: 12,
};

interface CandidateNode
{
	id: string;
	name: string;
	monthName: string;
	yearName: string;
}

interface ParsedDate
{
	year: number;
	month: number;
	day: number;
}

function parseTextDate(name: string): ParsedDate | null
{
	const trimmed = name.trim();

	// "[YYYY-MM-DD]" bracket format (from previous failed migration)
	const bracketFormat = /^\[(\d{4})-(\d{2})-(\d{2})\]$/u;
	let match = bracketFormat.exec(trimmed);
	if (match)
	{
		return {
			year: Number(match[1]),
			month: Number(match[2]),
			day: Number(match[3]),
		};
	}

	// "Weekday M/D/YY" or "Weekday M/D/YYYY"
	const weekdaySlash = /^\w+ (\d{1,2})\/(\d{1,2})\/(\d{2,4})$/u;
	match = weekdaySlash.exec(trimmed);
	if (match)
	{
		const month = Number(match[1]);
		const day = Number(match[2]);
		let year = Number(match[3]);
		if (year < 100)
		{
			year += 2000;
		}
		return {
			year,
			month,
			day,
		};
	}

	// "Ddd, Mmm D, YYYY" (e.g., "Tue, Nov 17, 2020")
	const abbrevFormat = /^\w{3}, (\w{3}) (\d{1,2}), (\d{4})$/u;
	match = abbrevFormat.exec(trimmed);
	if (match)
	{
		const monthNum = MONTH_ABBREVS[match[1] ?? ""];
		if (monthNum === undefined)
		{
			return null;
		}
		const day = Number(match[2]);
		const year = Number(match[3]);
		return {
			year,
			month: monthNum,
			day,
		};
	}

	// "M/D/YY" bare format
	const bareSlash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/u;
	match = bareSlash.exec(trimmed);
	if (match)
	{
		const month = Number(match[1]);
		const day = Number(match[2]);
		let year = Number(match[3]);
		if (year < 100)
		{
			year += 2000;
		}
		return {
			year,
			month,
			day,
		};
	}

	return null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBREV_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatTimeElement(parsed: ParsedDate): string
{
	const date = new Date(parsed.year, parsed.month - 1, parsed.day);
	const dayName = DAY_NAMES[date.getDay()];
	const monthName = MONTH_ABBREV_NAMES[date.getMonth()];
	const displayText = `${dayName}, ${monthName} ${parsed.day}, ${parsed.year}`;
	return `<time startYear="${parsed.year}" startMonth="${parsed.month}" startDay="${parsed.day}">${displayText}</time>`;
}

export default class MigrateDates extends Command
{
	static override description = "Convert text dates to native Workflowy dates in calendar archive day nodes";

	static override examples = [
		"# Preview all changes without making API calls",
		"<%= config.bin %> <%= command.id %> --dry-run",
		"",
		"# Test with a specific year first",
		"<%= config.bin %> <%= command.id %> --dry-run --year 2017",
		"",
		"# Execute migration for one year",
		"<%= config.bin %> <%= command.id %> --year 2017",
		"",
		"# Execute the full migration",
		"<%= config.bin %> <%= command.id %>",
	];

	static override flags =
	{
		"dry-run": Flags.boolean(
			{
				char: "d",
				description: "Parse and log all changes without writing anything",
				default: false,
			},
		),
		"archive-id": Flags.string(
			{
				char: "a",
				description: "ID of the archive root node",
				default: "f6b557fbf770",
			},
		),
		"batch-size": Flags.integer(
			{
				char: "b",
				description: "Number of nodes to process before stopping (default: all)",
			},
		),
		year: Flags.integer(
			{
				description: "Limit processing to a specific year",
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(MigrateDates);

		const database = createDatabase();

		const archiveShortId = flags["archive-id"];
		const yearFilter = flags.year === undefined || flags.year === 0 ? null : String(flags.year);

		// Find archive root node by short ID
		const archiveResult = database
			.select(
				{
					id: nodeContent.id,
				},
			)
			.from(nodeContent)
			.innerJoin(nodeMetadata, and(eq(nodeContent.id, nodeMetadata.nodeId), currentVersion(nodeMetadata)))
			.where(and(eq(nodeMetadata.shortId, archiveShortId), currentVersion(nodeContent)))
			.limit(1)
			.all();
		const [archiveRow] = archiveResult;
		if (!archiveRow)
		{
			this.error(`Archive node with short ID "${archiveShortId}" not found`);
		}
		const archiveId = archiveRow.id;
		this.log(`Archive root: ${archiveId}`);

		// Query candidate day nodes:
		// archive -> year -> month -> day
		// Filter out nodes that already have <time (native dates)
		const day = alias(nodeContent, "day");
		const month = alias(nodeContent, "month");
		const year = alias(nodeContent, "year");
		const candidates = database
			.select(
				{
					id: day.id,
					name: sql<string>`${day.name}`,
					monthName: sql<string>`${month.name}`,
					yearName: sql<string>`${year.name}`,
				},
			)
			.from(day)
			.innerJoin(month, and(eq(day.parentId, month.id), currentVersion(month)))
			.innerJoin(year, and(eq(month.parentId, year.id), currentVersion(year)))
			.where(
				and(
					eq(year.parentId, archiveId),
					currentVersion(day),
					notLike(day.name, "%<time%"),
					isNotNull(day.name),
					yearFilter ? eq(year.name, yearFilter) : undefined,
				),
			)
			.orderBy(year.name, month.name, day.name)
			.all();

		this.log(`Found ${candidates.length} candidate nodes`);

		const parsed:
		{
			node: CandidateNode;
			date: ParsedDate;
			formatted: string;
		}[] = [];
		const skipped:
		{
			id: string;
			name: string;
			reason: string;
		}[] = [];

		for (const row of candidates)
		{
			const node: CandidateNode =
			{
				id: row.id,
				name: row.name,
				monthName: row.monthName,
				yearName: row.yearName,
			};

			const date = parseTextDate(node.name);
			if (!date)
			{
				skipped.push(
					{
						id: node.id,
						name: node.name,
						reason: "unparseable",
					},
				);
				continue;
			}

			// Cross-validate against parent hierarchy
			const expectedYear = Number(node.yearName);
			const expectedMonth = MONTH_NAMES[node.monthName];

			if (expectedYear && date.year !== expectedYear)
			{
				this.warn(`Year mismatch: "${node.name}" parsed as ${date.year} but parent year is ${node.yearName}`);
			}
			if (expectedMonth !== undefined && date.month !== expectedMonth)
			{
				this.warn(
					`Month mismatch: "${node.name}" parsed as month ${date.month} but parent is ${node.monthName}`,
				);
			}

			const formatted = formatTimeElement(date);
			parsed.push(
				{
					node,
					date,
					formatted,
				},
			);
		}

		this.log(`Parsed: ${parsed.length}, Skipped: ${skipped.length}`);

		if (skipped.length > 0)
		{
			this.log("\nSkipped nodes:");
			for (const s of skipped)
			{
				this.log(`  [${s.id}] "${s.name}" (${s.reason})`);
			}
		}

		if (flags["dry-run"])
		{
			this.log("\n--- DRY RUN ---");
			for (const {node, formatted} of parsed)
			{
				this.log(`  "${node.name}" → ${formatted}  (${node.yearName}/${node.monthName})`);
			}
			this.log(`\nTotal: ${parsed.length} nodes would be updated`);
			return;
		}

		// Execute updates
		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey)
		{
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		const writes = openLocalWrites(
			database,
			new WorkflowyWriteThroughClient(
				new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL),
				new CacheService(database),
			),
		);

		const batchSize = flags["batch-size"];
		const toProcess = batchSize !== undefined && batchSize !== 0 ? parsed.slice(0, batchSize) : parsed;

		this.log(`\nUpdating ${toProcess.length} nodes...`);

		let updated = 0;
		let errors = 0;

		for (const {node, formatted} of toProcess)
		{
			try
			{
				writes.local.updateNode(
					node.id,
					{
						name: formatted,
					},
				);
				updated++;
				if (updated % 50 === 0)
				{
					this.log(`  Progress: ${updated}/${toProcess.length}`);
				}
			}
			catch (error)
			{
				errors++;
				this.warn(
					`Failed to update "${node.name}" (${node.id}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		this.log(`\nDone: ${updated} updated, ${errors} errors`);
		if (batchSize !== undefined && batchSize !== 0 && parsed.length > batchSize)
		{
			this.log(`Remaining: ${parsed.length - batchSize} nodes`);
		}
		if (updated > 0)
		{
			await drainAfterWrite(this, writes);
		}
	}
}
