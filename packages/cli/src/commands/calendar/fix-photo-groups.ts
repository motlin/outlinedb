import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {resolveIdOrShortId} from "@outlinedb/shared/utils";
import {Command, Flags} from "@oclif/core";
import {sql} from "drizzle-orm";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";
import
{
	buildPhotoGroups,
	countGroupsWithoutEvidence,
	describeStaleAttachmentData,
	planPhotoGroup,
} from "../../services/photo-groups.js";
import type {CachedNodeRow, PhotoGroup} from "../../services/photo-groups.js";
import {listBackups, resolveBackupsDirectory} from "../../utils/backup-archive.js";

/** Position argument for the move API: negative is top, zero or more is bottom. */
const MOVE_TO_BOTTOM = 0;

interface CandidateRow
{
	id: string;
	parent_id: string | null;
	name: string | null;
	note: string | null;
	priority: number | null;
	child_count: number;
	created_at: number | null;
	is_mirror: number;
	file_name: string | null;
	file_type: string | null;
}

/**
 * Load every node that could take part in a photo group: each parent of a blank
 * leaf, and the complete sibling sets around them. Partial sibling sets would let
 * two separate photo runs look adjacent, so the whole child list is needed.
 */
function loadCandidateRows(database: ReturnType<typeof createDatabase>): CachedNodeRow[]
{
	const query = sql`
		WITH cur AS (
			SELECT
				nc.id,
				nc.name,
				nc.note,
				nc.parent_id,
				COALESCE(nm.priority, 0) AS priority,
				nm.created_at
			FROM node_content nc
			LEFT JOIN node_metadata nm ON nm.node_id = nc.id AND nm.system_to = ${FAR_FUTURE_DATE}
			WHERE nc.system_to = ${FAR_FUTURE_DATE}
		),
		counts AS (
			SELECT parent_id, COUNT(*) AS n FROM cur WHERE parent_id IS NOT NULL GROUP BY parent_id
		),
		-- Attachments only land in the cache via backup imports, and older rows get
		-- tombstoned, so take the newest row per node regardless of system_to.
		latest_file AS (
			SELECT node_id, file_name, file_type
			FROM (
				SELECT
					node_id,
					file_name,
					file_type,
					is_deleted,
					ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY system_from DESC) AS rn
				FROM s3_files
			)
			WHERE rn = 1 AND COALESCE(is_deleted, 0) = 0
		),
		photo_parents AS (
			SELECT DISTINCT cur.parent_id AS id
			FROM cur
			LEFT JOIN counts ON counts.parent_id = cur.id
			WHERE cur.parent_id IS NOT NULL
				AND COALESCE(counts.n, 0) = 0
				AND TRIM(COALESCE(cur.name, '')) = ''
				AND TRIM(COALESCE(cur.note, '')) = ''
		),
		scope AS (
			SELECT id FROM photo_parents
			UNION
			SELECT parent_id AS id FROM cur WHERE id IN (SELECT id FROM photo_parents) AND parent_id IS NOT NULL
		)
		SELECT
			cur.id,
			cur.parent_id,
			cur.name,
			cur.note,
			cur.priority,
			cur.created_at,
			COALESCE(counts.n, 0) AS child_count,
			CASE WHEN mirrors.mirror_id IS NULL THEN 0 ELSE 1 END AS is_mirror,
			latest_file.file_name,
			latest_file.file_type
		FROM cur
		LEFT JOIN counts ON counts.parent_id = cur.id
		LEFT JOIN latest_file ON latest_file.node_id = cur.id
		LEFT JOIN mirrors ON mirrors.mirror_id = cur.id AND mirrors.system_to = ${FAR_FUTURE_DATE}
		WHERE cur.id IN (SELECT id FROM scope) OR cur.parent_id IN (SELECT id FROM scope)
	`;

	return database.all<CandidateRow>(query).map((row) => (
	{
		id: row.id,
		parentId: row.parent_id,
		name: row.name,
		note: row.note,
		priority: row.priority ?? 0,
		childCount: row.child_count,
		createdAt: row.created_at,
		isMirror: row.is_mirror === 1,
		fileName: row.file_name,
		fileType: row.file_type,
	}));
}

function loadEntryTitles(database: ReturnType<typeof createDatabase>, entryIds: string[]): Map<string, string>
{
	if (entryIds.length === 0)
	{
		return new Map();
	}

	const query = sql`
		SELECT id, name FROM node_content
		WHERE system_to = ${FAR_FUTURE_DATE} AND id IN ${entryIds}
	`;

	return new Map(
		database
			.all<
			{
				id: string;
				name: string | null;
			}>(query)
			.map((row) => [row.id, (row.name ?? "").replaceAll(/<[^>]*>/gu, "").trim()]),
	);
}

/**
 * Newest attachment row in the cache versus the newest backup sitting on disk.
 * Only backup imports populate `s3_files`, so when the newest backup is younger
 * than the newest row, photos pasted since that import are invisible here.
 */
function findStaleAttachmentData(database: ReturnType<typeof createDatabase>): string | null
{
	const row = database.all<
	{
		newest: string | null;
	}>(sql`SELECT MAX(system_from) AS newest FROM s3_files`)[0];

	let newestBackup: Date | null = null;
	try
	{
		for (const backup of listBackups(resolveBackupsDirectory()))
		{
			if (newestBackup === null || backup.backupDate > newestBackup)
			{
				newestBackup = backup.backupDate;
			}
		}
	}
	catch
	{
		return null;
	}

	return describeStaleAttachmentData(row?.newest ?? null, newestBackup);
}

function describeGroup(group: PhotoGroup, titles: Map<string, string>): string
{
	const title = titles.get(group.entryId);
	const entry = title ? `entry ${group.entryId} "${title.slice(0, 60)}"` : `entry ${group.entryId}`;
	return group.kind === "wrapped" ? `wrapper ${group.wrapperId} under ${entry}` : entry;
}

export default class FixPhotoGroups extends Command
{
	static override description =
		"Unwrap blank photo-paste wrappers in the calendar and restore chronological photo order";

	static override examples = [
		"# Preview every group that would be fixed",
		"<%= config.bin %> <%= command.id %> --dry-run",
		"",
		"# Fix a single group by wrapper or entry ID",
		"<%= config.bin %> <%= command.id %> --node-id b03bd2f9bf47",
		"",
		"# Fix the first five groups",
		"<%= config.bin %> <%= command.id %> --batch-size 5",
	];

	static override flags =
	{
		"dry-run": Flags.boolean(
			{
				char: "d",
				description: "Report the groups and planned order without making API calls",
				default: false,
			},
		),
		"node-id": Flags.string(
			{
				description: "Limit processing by wrapper or entry UUID or 12-character short ID",
			},
		),
		"batch-size": Flags.integer(
			{
				char: "b",
				description: "Number of groups to fix before stopping (default: all)",
			},
		),
		delay: Flags.integer(
			{
				char: "D",
				description: "Milliseconds between API calls",
				default: 1000,
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(FixPhotoGroups);

		const database = createDatabase();
		const cacheService = new CacheService(database);
		const rows = loadCandidateRows(database);

		let groups = buildPhotoGroups(rows);
		if (flags["node-id"])
		{
			// Cache-only resolution keeps --dry-run usable without an API key.
			const wanted = resolveIdOrShortId(flags["node-id"], cacheService);
			groups = groups.filter((group) => group.wrapperId === wanted || group.entryId === wanted);
			if (groups.length === 0)
			{
				this.error(`No photo group found for node ${wanted}`);
			}
		}

		const planned = groups.map((group) => (
		{
			group,
			plan: planPhotoGroup(group),
		}));
		const fixable = planned.filter((entry) => entry.plan.decision === "reverse");
		const skipped = planned.filter((entry) => entry.plan.decision !== "reverse");

		this.log(`Found ${planned.length} photo groups: ${fixable.length} to fix, ${skipped.length} left alone`);

		const skipCounts = new Map<string, number>();
		for (const {plan} of skipped)
		{
			skipCounts.set(plan.reason, (skipCounts.get(plan.reason) ?? 0) + 1);
		}
		for (const [reason, count] of skipCounts)
		{
			this.log(`  ${count} left alone: ${reason}`);
		}

		// Reported separately from the plan tally: these clusters never became
		// groups at all, so without this line a stale cache reads as a clean sweep.
		const withoutEvidence = countGroupsWithoutEvidence(rows);
		if (withoutEvidence > 0)
		{
			this.log(`  ${withoutEvidence} not examined: no attachment data in the cache`);
		}

		const staleness = findStaleAttachmentData(database);
		if (staleness)
		{
			this.warn(staleness);
		}

		const batchSize = flags["batch-size"];
		const toProcess = batchSize !== undefined && batchSize !== 0 ? fixable.slice(0, batchSize) : fixable;
		const titles = loadEntryTitles(
			database,
			toProcess.map(({group}) => group.entryId),
		);

		if (flags["dry-run"])
		{
			this.log("\n--- DRY RUN ---");
			for (const {group, plan} of toProcess)
			{
				this.log(`  ${describeGroup(group, titles)} — ${plan.decision} (${plan.reason})`);
				for (const id of plan.orderedIds)
				{
					const member = group.members.find((candidate) => candidate.id === id);
					this.log(`    ${id}  ${member?.fileName ?? "(no filename)"}`);
				}
			}
			this.log(`\nTotal: ${toProcess.length} groups would be fixed`);
			return;
		}

		if (toProcess.length === 0)
		{
			return;
		}

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey)
		{
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		const apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		const client = new WorkflowyWriteThroughClient(apiClient, cacheService);
		const {delay} = flags;

		let fixed = 0;
		let errors = 0;

		for (const {group, plan} of toProcess)
		{
			try
			{
				// Appending to the bottom in target order lays the photos out in that
				// order, whether they are leaving a wrapper or being reordered in place.
				for (const id of plan.orderedIds)
				{
					await client.moveNode(id, group.entryId, MOVE_TO_BOTTOM);
					if (delay > 0)
					{
						await new Promise((resolve) =>
						{
							setTimeout(resolve, delay);
						});
					}
				}

				if (group.wrapperId)
				{
					const remaining = cacheService.getChildren(group.wrapperId);
					if (remaining.length > 0)
					{
						this.warn(`Wrapper ${group.wrapperId} still has ${remaining.length} children; not deleting it`);
					}
					else
					{
						await client.deleteNode(group.wrapperId);
					}
				}

				fixed++;
				this.log(`  Fixed ${describeGroup(group, titles)} (${plan.orderedIds.length} photos)`);
			}
			catch (error)
			{
				errors++;
				this.warn(
					`Failed to fix ${describeGroup(group, titles)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		this.log(`\nDone: ${fixed} groups fixed, ${errors} errors`);
	}
}
