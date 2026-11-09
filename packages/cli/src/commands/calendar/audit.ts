import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {auditCalendar} from "@outlinedb/shared/calendar-lookup";
import {calendarLevelMetadata, calendarLevelName, datesInName} from "@outlinedb/shared/internal";
import type {CalendarAuditFinding} from "@outlinedb/shared/internal";
import {internalAdapter} from "@outlinedb/shared/node";
import {resolveIdOrShortId} from "@outlinedb/shared/utils";
import {uuidToShortId} from "@outlinedb/shared/workflowy";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";

const BRACKET_DAY = /^\[(\d{4})-(\d{2})-(\d{2})\]$/u;

export default class CalendarAudit extends Command {
	static override description =
		"Find 📆 Calendar nodes that workflowy.com cannot use as days (name-only `<time>` or [YYYY-MM-DD] days, nested tagged days, duplicate dates, name-only years and months), and with --fix adopt the safe ones by writing their calendar metadata";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --json",
		"<%= config.bin %> <%= command.id %> --fix",
	];

	static override flags = {
		fix: Flags.boolean({
			description:
				"Adopt each untagged day that has no tagged sibling for its date, renaming [YYYY-MM-DD] days to a <time> first. Duplicates and nested days are only reported",
			default: false,
		}),
		"root-id": Flags.string({
			description: "Audit this calendar root node (tagged calendar.root) instead of the account's 📆 Calendar",
		}),
		refresh: Flags.boolean({
			description: "Run cache import-api first so internal metadata is current",
			default: false,
		}),
		json: Flags.boolean({char: "j", description: "Output the findings as JSON", default: false}),
	};

	public async run(): Promise<CalendarAuditFinding[]> {
		const {flags} = await this.parse(CalendarAudit);
		if (flags.refresh) {
			await this.config.runCommand("cache:import-api", []);
		}
		const database = createDatabase();
		const cache = new CacheService(database);
		const rootId = flags["root-id"] === undefined ? undefined : resolveIdOrShortId(flags["root-id"], cache);
		const findings = auditCalendar({db: database, cache}, rootId);

		const fixed: string[] = [];
		if (flags.fix) {
			const apiKey = process.env.WORKFLOWY_API_KEY;
			if (!apiKey) {
				this.error("WORKFLOWY_API_KEY environment variable is required");
			}
			const writeThrough = new WorkflowyWriteThroughClient(
				new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL),
				cache,
			);
			const adapter = internalAdapter(database, writeThrough);
			if (adapter === undefined) {
				this.error(
					"--fix needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc)",
				);
			}
			const reported = new Set(findings.filter(({kind}) => kind === "duplicate").map(({dateId}) => dateId));
			for (const finding of findings) {
				if (
					(finding.kind !== "untagged-day" && finding.kind !== "bracket-day") ||
					reported.has(finding.dateId)
				) {
					continue;
				}
				const name = cache.getNode(finding.id)?.name ?? "";
				const bracket = BRACKET_DAY.exec(name.trim());
				const [date] =
					bracket === null
						? datesInName(name)
						: [{year: Number(bracket[1]), month: Number(bracket[2]), day: Number(bracket[3])}];
				if (date === undefined) {
					continue;
				}
				if (bracket !== null) {
					await writeThrough.updateNode(finding.id, {name: calendarLevelName("day", date, "")});
				}
				await adapter.setNodeMetaValues(finding.id, [
					{path: ["calendar"], value: calendarLevelMetadata("day", date)},
				]);
				fixed.push(finding.id);
			}
		}

		if (flags.json) {
			this.log(JSON.stringify(findings));
		} else if (findings.length === 0) {
			this.log("No calendar problems found.");
		} else {
			for (const {kind, id, dateId} of findings) {
				this.log(
					`${kind} ${uuidToShortId(id)} ${dateId === 0 ? "" : dateId}${fixed.includes(id) ? " (adopted)" : ""}`.trimEnd(),
				);
			}
		}
		return findings;
	}
}
