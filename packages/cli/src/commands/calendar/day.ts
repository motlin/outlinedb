import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {findCalendarDay} from "@outlinedb/shared/calendar-lookup";
import {CALENDAR_LEVELS} from "@outlinedb/shared/internal";
import type {CalendarLevel} from "@outlinedb/shared/internal";
import {internalAdapter} from "@outlinedb/shared/node";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";
import {isoDateId} from "../../services/journal-existing-entries.js";
import {localIsoDate} from "../../utils/local-date.js";

export interface CalendarDayResult
{
	id: string;
	created: boolean;
	firstChildId: string | null;
}

export default class CalendarDay extends Command
{
	static override description =
		"Find (or with --ensure, create) the 📆 Calendar day node workflowy.com uses for a date. Lookup is a strict metadata.calendar walk from the root; --ensure creates missing year/month/day nodes with calendar metadata";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --date 2026-10-05 --json",
		"<%= config.bin %> <%= command.id %> --date 2026-10-22 --ensure --no-child --json",
	];

	static override flags =
	{
		date: Flags.string(
			{
				description: "Date as YYYY-MM-DD (default: today, local time)",
			},
		),
		ensure: Flags.boolean(
			{
				description: "Create the day (and any missing year/month) with calendar metadata when it is missing",
				default: false,
			},
		),
		"no-child": Flags.boolean(
			{
				description: "With --ensure, do not add an empty first child to a new or empty day",
				default: false,
			},
		),
		level: Flags.option(
			{
				description: "Which node to find or ensure: the day (default), its week, month or year",
				options: CALENDAR_LEVELS,
			},
		)(),
		json: Flags.boolean(
			{
				char: "j",
				description: "Output {id, created, firstChildId} as JSON",
				default: false,
			},
		),
	};

	public async run(): Promise<CalendarDayResult>
	{
		const {flags} = await this.parse(CalendarDay);
		const date = flags.date ?? localIsoDate(new Date());
		const dateId = isoDateId(date);
		if (dateId === undefined)
		{
			this.error(
				`Invalid --date "${date}". Use YYYY-MM-DD.`,
				{
					exit: 1,
				},
			);
		}
		const level: CalendarLevel = flags.level ?? "day";

		const database = createDatabase();
		const cache = new CacheService(database);
		let id = findCalendarDay(
			{
				db: database,
				cache,
			},
			dateId,
			level,
		);
		let created = false;
		let firstChildId: string | null;
		if (id === null)
		{
			if (!flags.ensure)
			{
				this.error(
					`No 📆 Calendar ${level === "day" ? "day" : level} for ${date} (use --ensure)`,
					{
						exit: 1,
					},
				);
			}
			const apiKey = process.env.WORKFLOWY_API_KEY;
			if (!apiKey)
			{
				this.error("WORKFLOWY_API_KEY environment variable is required");
			}
			const writeThrough = new WorkflowyWriteThroughClient(
				new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL),
				cache,
			);
			const adapter = internalAdapter(database, writeThrough);
			if (adapter === undefined)
			{
				this.error(
					"--ensure needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc)",
				);
			}
			const ensured = await adapter.ensureCalendarDay(
				dateId,
				{
					stopAt: level,
					createChild: !flags["no-child"],
				},
			);
			id = ensured.dayId;
			firstChildId = ensured.firstChildId;
			created = ensured.created.length > 0;
		}
		else
		{
			firstChildId = cache.getChildren(id)[0]?.id ?? null;
		}

		const result =
		{
			id,
			created,
			firstChildId,
		};
		if (flags.json)
		{
			this.log(JSON.stringify(result));
		}
		else
		{
			this.log(id);
		}
		return result;
	}
}
