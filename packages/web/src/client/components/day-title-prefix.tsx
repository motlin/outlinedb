import {useState} from "react";
import {friendlyPrefix} from "@outlinedb/shared";
import type {NodeResponse} from "../../node-types.js";
import {useDayPrefix} from "../hooks/use-calendar-settings.js";
import {useAncestors} from "../hooks/use-nodes.js";

/** Upstream's `calendar_relative-date-name` span classes, copied literally. */
const PREFIX_CLASS =
	"flex h-[var(--line-height)] whitespace-nowrap items-center pr-m pt-[--wf-content-padding-top] pb-[--wf-content-padding-bottom]";

/** The local-midnight date a `YYYYMMDD` dateId names. */
function dateOfId(dateId: number): Date {
	return new Date(Math.floor(dateId / 10_000), (Math.floor(dateId / 100) % 100) - 1, dateId % 100);
}

/**
 * Upstream's friendly title prefix (`r10`): `Yesterday,` / `Today,` / `Tomorrow,`
 * before a day page's name, unless the 📆 Calendar root turns Friendly day names
 * off. The setting comes from the calendar settings cache (so a toggle shows at
 * once), falling back to the root among the day's ancestors; nothing renders
 * until the ancestors load. "Now" is read once per mount, as upstream reads it per render.
 */
export function DayTitlePrefix({node}: {node: Pick<NodeResponse, "id" | "calendar">}) {
	const dateId = node.calendar?.level === "day" ? node.calendar.dateId : null;
	const {data: ancestors} = useAncestors(dateId === null ? null : node.id);
	const dayPrefix = useDayPrefix(
		ancestors?.find((ancestor) => ancestor.calendar?.root === true)?.calendar?.dayPrefix,
	);
	const [now] = useState(() => new Date());
	if (dateId === null || ancestors === undefined) {
		return null;
	}
	const prefix = dayPrefix ? friendlyPrefix(dateOfId(dateId), now) : null;
	return prefix === null ? null : <span className={PREFIX_CLASS}>{prefix},</span>;
}
