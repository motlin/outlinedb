import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {CALENDAR_LEVELS} from "@workflowy/shared/internal";
import type {StoreClient} from "@workflowy/web/server-app";
import {z} from "zod";
import {errorResult, jsonResult, opError} from "./results.js";

export function registerCalendarTools(server: McpServer, store: StoreClient): void {
	server.registerTool(
		"workflowy_calendar_day",
		{
			description:
				"Find the 📆 Calendar day node workflowy.com uses for a date (strict metadata.calendar walk), or with ensure create it, and any missing year/month, with calendar metadata. Always use this instead of creating date nodes by name under the 📆 Calendar.",
			inputSchema: {
				date: z.string().describe("Date as YYYY-MM-DD"),
				ensure: z.boolean().optional().describe("Create the node when it is missing (needs internal API auth)"),
				level: z.enum(CALENDAR_LEVELS).optional().describe("Which node: day (default), week, month or year"),
				createChild: z
					.boolean()
					.optional()
					.describe("With ensure, add an empty first child to a new or empty node (default true)"),
			},
		},
		async ({date, ensure, level, createChild}) => {
			const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
			if (match === null) {
				return errorResult(`Invalid date "${date}". Use YYYY-MM-DD.`);
			}
			const dateId = `${match[1]}${match[2]}${match[3]}`;
			const stopAt = level ?? "day";
			const found = await store.call("calendar.day", {dateId, level: stopAt});
			if (found.ok) {
				return jsonResult({id: found.value.id, created: false, firstChildId: found.value.firstChildId});
			}
			if (found.status !== 404) {
				return opError(found);
			}
			if (!ensure) {
				return errorResult(`No 📆 Calendar ${stopAt} for ${date} (pass ensure: true)`);
			}
			const ensured = await store.call("calendar.ensure", {
				dateId,
				level: stopAt,
				createChild: String(createChild ?? true),
			});
			if (!ensured.ok) {
				return opError(ensured);
			}
			const {dayId, created, firstChildId} = ensured.value;
			return jsonResult({id: dayId, created: created.length > 0, firstChildId});
		},
	);
}
