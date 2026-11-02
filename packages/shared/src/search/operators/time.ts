import type {SearchItem, SearchOperator} from "../query-nodes.js";
import {MetaNode} from "./meta.js";

/**
 * Port of upstream's time-range cutoff: `parseInt(value)` (NaN or negative -> 0) with suffix `h` = hours,
 * `d` = days and anything else (including `w`) = minutes. Returns `now` minus that many minutes.
 */
export function sinceTimestamp(value: string, now: number): number
{
	const amount = Math.max(0, Number(/^[+-]?\d+/u.exec(value)?.[0] ?? 0));
	const multiplier = value.endsWith("h") ? 60 : value.endsWith("d") ? 1440 : 1;
	return now - amount * multiplier * 60_000;
}

type Timestamp = (item: SearchItem) => number | null;

function timeRange(prefixes: [string, ...string[]], timestamp: Timestamp, before = false): SearchOperator
{
	const prefixOf = (token: string): string => prefixes.find((prefix) => token.startsWith(prefix)) ?? "";
	return {
		name: prefixes[0],
		matchesToken: (token) => prefixOf(token).length > 0,
		create(token, _rawToken, context)
		{
			const since = sinceTimestamp(token.slice(prefixOf(token).length), context.now);
			return new MetaNode((item) =>
			{
				const at = timestamp(item);
				return at !== null && (before ? at < since : at >= since);
			});
		},
	};
}

export const changed = timeRange(["changed:", "last-changed:", "last-changed-since:"], (item) => item.modifiedAt);
export const changedBefore = timeRange(["last-changed-before:"], (item) => item.modifiedAt, true);
export const created = timeRange(["created:"], (item) => item.createdAt);
export const completed = timeRange(["completed:", "completed-since:"], (item) => item.completedAt);

/**
 * `changed-by:me` always matches and anything else (`others`) never does: in a single-user tree upstream leaves
 * last-modified-by unset, so every change is the viewer's own.
 */
export const changedBy: SearchOperator =
{
	name: "changed-by:",
	matchesToken: (token) => token.startsWith("changed-by:") || token.startsWith("last-changed-by:"),
	create(token)
	{
		const isMe = token.slice(token.indexOf(":") + 1) === "me";
		return new MetaNode(() => isMe);
	},
};
