import {formatTimeLabel, friendlyPrefix, parseTimeAttrsLoose} from "@outlinedb/shared";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {MENTION_PATTERN, parseMentionAttrs, resolveMentionName} from "./mention-pills.js";
import type {MentionAccount} from "./mention-pills.js";

/** The local-midnight date a `YYYYMMDD` dateId names. */
function dateOfId(dateId: number): Date {
	return new Date(Math.floor(dateId / 10_000), (Math.floor(dateId / 100) % 100) - 1, dateId % 100);
}

export interface CrumbLabelOptions {
	now: Date;
	dateFormat?: string;
	timeFormat?: string;
	/** `YYYYMMDD` of the calendar day node, or null/undefined for any other node. */
	dayDateId?: number | null;
	/** The 📆 Calendar root's Friendly day names setting; only `true` adds the prefix. */
	dayPrefix?: boolean;
	account?: MentionAccount;
}

const TIME_PATTERN = /<time\b([^>]*)>[\s\S]*?<\/time>/giu;

/**
 * Plain crumb text: `<time>` pills rendered as formatted dates, other tags stripped. Upstream's crumb decorator adds
 * `Yesterday, ` / `Today, ` / `Tomorrow, ` only for a calendar day node (`dayDateId`) whose root keeps Friendly day
 * names on (`dayPrefix === true`; a missing setting is off).
 */
export function crumbLabel(
	nameHtml: string,
	{now, dateFormat = "YYYY-MM-DD ddd", timeFormat, dayDateId = null, dayPrefix, account = null}: CrumbLabelOptions,
): string {
	const label = stripHtmlTags(
		nameHtml
			.replaceAll(TIME_PATTERN, (_match, attrText: string) =>
				formatTimeLabel(parseTimeAttrsLoose(attrText), {dateFormat, timeFormat, now}),
			)
			.replaceAll(MENTION_PATTERN, (_match, attrText: string) =>
				resolveMentionName(parseMentionAttrs(attrText).id, account),
			),
	);
	const prefix = dayDateId !== null && dayPrefix === true ? friendlyPrefix(dateOfId(dayDateId), now) : null;
	return prefix === null ? label : `${prefix}, ${label}`;
}
