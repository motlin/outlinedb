/**
 * Upstream's Calendar Layout restructure (`JX4` in wf-base, run by the
 * Calendar Layout dialog `P10`'s Update Layout), as a pure planner: given a
 * snapshot of the `📆 Calendar` root's subtree and the levels to show, it
 * replays upstream's walk on an in-memory copy and returns the tree writes in
 * upstream's order. Applying them is the caller's job (one push of internal
 * ops), so the planner can be tested and previewed without touching the
 * account.
 */

import {parseTimeAttrs} from "../dates/date-markup.js";
import
{
	CALENDAR_LEVELS,
	DEFAULT_CALENDAR_LEVELS,
	calendarDateId,
	calendarInsertIndex,
	calendarLevelMetadata,
	calendarLevelName,
	parseDateId,
} from "./calendar-day.js";
import type {CalendarDate, CalendarLevel, CalendarLevelMetadata} from "./calendar-day.js";
import {calendarNodeId} from "./calendar-ids.js";

/** One node of the calendar snapshot; children in Workflowy order, completed ones included. */
export interface LayoutNode
{
	id: string;
	name: string;
	note: string;
	/** The node's `metadata.calendar` level and dateId, for level nodes. */
	calendar?:
	{
		level: string;
		dateId: number;
	};
	/** Mirrors are skipped everywhere, as upstream does. */
	isMirror?: boolean;
	children: LayoutNode[];
}

/** The root's `calendar.levels`; a missing key is off, and a missing object is upstream's default. */
export type CalendarLayoutLevels = Partial<Record<"year" | "month" | "week" | "day", boolean>>;

export interface LayoutLocation
{
	parentId: string;
	/** 0-based index among all siblings, completed ones included. */
	index: number;
}

export type CalendarLayoutStep =
	/** Set (`calendar`) or remove (`null`) a node's `metadata.calendar`. */
	|
	  {
			op: "set-calendar";
			id: string;
			calendar: CalendarLevelMetadata | null;
	  }
	/** Replace the root's `calendar.levels`. */
	|
	  {
			op: "set-levels";
			id: string;
			levels: Partial<Record<CalendarLevel, true>>;
	  }
	|
	  {
			op: "create";
			id: string;
			parentId: string;
			index: number;
			name: string;
			metadata:
			{
				restorableUniqueNode: true;
				calendar: CalendarLevelMetadata;
			};
	  }
	/** `index` is the slot among the target's children counted before removal, like `MoveToInput`. */
	|
	  {
			op: "move";
			id: string;
			parentId: string;
			index: number;
			from: LayoutLocation;
	  }
	|
	  {
			op: "delete";
			id: string;
			from: LayoutLocation;
	  };

export interface CalendarLayoutOptions
{
	/** The root's levels before the change; upstream's default (year, month, day) when absent. */
	currentLevels?: CalendarLayoutLevels;
	/** The account's date format, which names new year, month and week nodes. */
	dateFormat: string;
	/** The account's `weekStartDay` (1 is Monday, else Sunday), which places and numbers weeks. */
	weekStartDay?: number;
	/** The account entropy key behind upstream's deterministic level ids; without it ids come from `generateId`. */
	entropyKey?: string;
	generateId?: () => string;
}

const TIME_TAG = /<time\b([^>]*)>/giu;

/** The enabled levels in upstream order (`GO`); day is always last when enabled. */
function enabledLevels(levels: CalendarLayoutLevels | undefined): CalendarLevel[]
{
	const resolved = levels ?? DEFAULT_CALENDAR_LEVELS;
	return CALENDAR_LEVELS.filter((level) => resolved[level] === true);
}

/** A node's level as a calendar level. */
function toLevel(level: string): CalendarLevel
{
	const known = CALENDAR_LEVELS.find((candidate) => candidate === level);
	if (known === undefined)
	{
		throw new Error(`calendar layout: unknown level ${level}`);
	}
	return known;
}

/**
 * Whether the `level` node with dateId `nodeDateId` holds the date `dateId` (upstream `level.matches(node, date)`):
 * same year or month, the week starting on the node's first day, or the same day.
 */
function samePeriod(level: string, nodeDateId: number, dateId: number, weekStartDay: number): boolean
{
	if (level === "year")
	{
		return Math.floor(nodeDateId / 10_000) === Math.floor(dateId / 10_000);
	}
	if (level === "month")
	{
		return Math.floor(nodeDateId / 100) === Math.floor(dateId / 100);
	}
	if (level === "week")
	{
		return nodeDateId === calendarDateId("week", toDate(dateId), weekStartDay);
	}
	return nodeDateId === dateId;
}

/** The first `<time>` date in `html` (upstream `WF.Date.fromContentText(text)[0]`) and whether it has a time of day. */
function firstDate(html: string):
	|
	  {
			dateId: number;
			hasTime: boolean;
	  }
	| undefined
{
	if (!html.includes("<time"))
	{
		return undefined;
	}
	for (const [, attrText = ""] of html.matchAll(TIME_TAG))
	{
		try
		{
			const attrs = parseTimeAttrs(attrText);
			const dateId = attrs.startYear * 10_000 + attrs.startMonth * 100 + attrs.startDay;
			if (parseDateId(dateId) !== undefined)
			{
				return {
					dateId,
					hasTime: (attrs.startHour ?? 0) !== 0 || (attrs.startMinute ?? 0) !== 0,
				};
			}
		}
		catch
		{
			// A <time> without start attributes names no date.
		}
	}
	return undefined;
}

/** The node's first date, from its name, else its note. */
function nodeDate(node: {name: string; note: string}):
	|
	  {
			dateId: number;
			hasTime: boolean;
	  }
	| undefined
{
	return firstDate(node.name) ?? firstDate(node.note);
}

/** A level dateId (`YYYY0000`, `YYYYMM00` or a week's or day's `YYYYMMDD`) as the first day it covers, like upstream's level timestamps. */
function toDate(dateId: number): CalendarDate
{
	const month = Math.floor(dateId / 100) % 100;
	const date = parseDateId(dateId + (month === 0 ? 100 : 0) + (dateId % 100 === 0 ? 1 : 0));
	if (date === undefined)
	{
		throw new RangeError(`${dateId} is not a YYYYMMDD date`);
	}
	return date;
}

/**
 * Upstream P10's warning scan: the year and month levels with at least one
 * (non-mirror) node whose name differs from the level's formatted name or that
 * has a note; turning such a level off deletes that text.
 */
export function calendarLayoutCustomLevels(root: LayoutNode, dateFormat: string): CalendarLevel[]
{
	const custom = new Set<CalendarLevel>();
	const visit = (node: LayoutNode): void =>
	{
		const level = node.calendar?.level;
		if (node.calendar === undefined || node.isMirror === true || (level !== "year" && level !== "month"))
		{
			return;
		}
		if (node.name !== calendarLevelName(level, toDate(node.calendar.dateId), dateFormat) || node.note !== "")
		{
			custom.add(level);
		}
		node.children.forEach(visit);
	};
	root.children.forEach(visit);
	return CALENDAR_LEVELS.filter((level) => custom.has(level));
}

/**
 * Upstream `OS2` over the root's children: whether a non-calendar, non-mirror
 * node (or a descendant of one) has a dated name or note, so Update Layout
 * first asks "Move nodes into your Calendar?".
 */
export function calendarLayoutNeedsConfirm(root: LayoutNode): boolean
{
	const dated = (node: LayoutNode): boolean =>
		node.calendar === undefined &&
		node.isMirror !== true &&
		(nodeDate(node) !== undefined || node.children.some(dated));
	return root.children.some(dated);
}

interface SimNode
{
	id: string;
	name: string;
	note: string;
	calendar:
		|
		  {
				level: string;
				dateId: number;
		  }
		| undefined;
	isMirror: boolean;
	parentId: string | null;
	children: string[];
}

interface Placement
{
	id: string;
	dateId: number;
}

/** The mutable copy the planner replays upstream's moves on, recording each write as a step. */
class LayoutSim
{
	readonly nodes = new Map<string, SimNode>();
	readonly steps: CalendarLayoutStep[] = [];

	constructor(root: LayoutNode)
	{
		const add = (node: LayoutNode, parentId: string | null): void =>
		{
			this.nodes.set(
				node.id,
				{
					id: node.id,
					name: node.name,
					note: node.note,
					calendar: node.calendar,
					isMirror: node.isMirror === true,
					parentId,
					children: node.children.map((child) => child.id),
				},
			);
			for (const child of node.children)
			{
				add(child, node.id);
			}
		};
		add(root, null);
	}

	get(id: string): SimNode
	{
		const node = this.nodes.get(id);
		if (node === undefined)
		{
			throw new Error(`calendar layout: unknown node ${id}`);
		}
		return node;
	}

	children(id: string): SimNode[]
	{
		return this.get(id).children.map((child) => this.get(child));
	}

	location(id: string): LayoutLocation
	{
		const {parentId} = this.get(id);
		if (parentId === null)
		{
			throw new Error("calendar layout: the root has no location");
		}
		return {
			parentId,
			index: this.get(parentId).children.indexOf(id),
		};
	}

	setCalendar(id: string, calendar: CalendarLevelMetadata | null): void
	{
		this.get(id).calendar =
			calendar === null
				? undefined
				:
					{
						level: calendar.level,
						dateId: calendar.dateId,
					};
		this.steps.push(
			{
				op: "set-calendar",
				id,
				calendar,
			},
		);
	}

	/**
	 * Upstream `moveUnder([id], index)`: `index` counts the target's children before the node is removed. A move
	 * that leaves the node in its slot records nothing; upstream sends those as no-op ops (its day placement compares
	 * a day's sibling index with its position among all days, so every day past the first month gets one).
	 */
	move(id: string, parentId: string, index: number): void
	{
		const from = this.location(id);
		if (from.parentId === parentId && (index === from.index || index === from.index + 1))
		{
			return;
		}
		this.steps.push(
			{
				op: "move",
				id,
				parentId,
				index,
				from,
			},
		);
		const old = this.get(from.parentId).children;
		old.splice(from.index, 1);
		const slot = from.parentId === parentId && index > from.index ? index - 1 : index;
		const target = this.get(parentId).children;
		target.splice(Math.min(Math.max(slot, 0), target.length), 0, id);
		this.get(id).parentId = parentId;
	}

	create(
		step: Extract<
			CalendarLayoutStep,
			{
				op: "create";
			}
		>,
	): void
	{
		this.steps.push(step);
		this.nodes.set(
			step.id,
			{
				id: step.id,
				name: step.name,
				note: "",
				calendar:
				{
					level: step.metadata.calendar.level,
					dateId: step.metadata.calendar.dateId,
				},
				isMirror: false,
				parentId: step.parentId,
				children: [],
			},
		);
		this.get(step.parentId).children.splice(step.index, 0, step.id);
	}

	delete(id: string): void
	{
		const from = this.location(id);
		this.steps.push(
			{
				op: "delete",
				id,
				from,
			},
		);
		this.get(from.parentId).children.splice(from.index, 1);
		this.nodes.delete(id);
	}

	isAncestor(ancestorId: string, id: string): boolean
	{
		for (let current = this.nodes.get(id)?.parentId ?? null; current !== null;)
		{
			if (current === ancestorId)
			{
				return true;
			}
			current = this.nodes.get(current)?.parentId ?? null;
		}
		return false;
	}
}

/**
 * Plan upstream's restructure (`JX4`) of the calendar under `root` to show
 * `levels` (day is always shown). In upstream's order:
 * - Dated nodes among the root's non-calendar children (searched through
 *   undated ones) are collected; a date-only node whose day does not exist yet
 *   becomes that day node, the rest move into their day.
 * - Level nodes are walked: other nodes found inside them stay with their
 *   nearest still-shown level; each day stays the day node unless another node
 *   is that day, in which case it loses its calendar metadata and moves into it.
 * - The root's levels are replaced, days are placed under their new parents
 *   (created as needed) in date order after any kept nodes, the collected
 *   nodes move to the end of their day, and every level node left empty is
 *   deleted (with emptied ancestors).
 */
export function planCalendarLayout(
	root: LayoutNode,
	levels: CalendarLayoutLevels,
	options: CalendarLayoutOptions,
): CalendarLayoutStep[]
{
	const current = enabledLevels(options.currentLevels);
	const next = enabledLevels(
		{
			...levels,
			day: true,
		},
	);
	const generateId = options.generateId ?? (() => crypto.randomUUID());
	const weekStartDay = options.weekStartDay ?? 0;
	const sim = new LayoutSim(root);
	const rootId = root.id;
	const prune = new Set<string>();
	const kept: string[] = [];
	const intoDay: Placement[] = [];
	const days: Placement[] = [];
	const collected = new Set<string>();

	/** Upstream `HC1`: the existing node for the day under the current levels, if every level node exists. */
	const findDay = (dateId: number): SimNode | undefined =>
	{
		let node = sim.get(rootId);
		for (const level of current)
		{
			const match = sim
				.children(node.id)
				.find(
					(child) =>
						child.calendar?.level === level &&
						samePeriod(level, child.calendar.dateId, dateId, weekStartDay),
				);
			if (match === undefined)
			{
				return undefined;
			}
			node = match;
		}
		return node;
	};

	/** Upstream `C9`: find or create each shown level node down to `stopAt` (the day by default). */
	const ensurePath = (dateId: number, stopAt?: CalendarLevel): string =>
	{
		const date = toDate(dateId);
		let parentId = rootId;
		for (const level of next)
		{
			const levelDateId = calendarDateId(level, date, weekStartDay);
			const children = sim.children(parentId);
			const match = children.find(
				(child) =>
					child.calendar?.level === level &&
					samePeriod(level, child.calendar.dateId, levelDateId, weekStartDay),
			);
			if (match === undefined)
			{
				const index = calendarInsertIndex(
					children.map((child) => child.calendar),
					level,
					levelDateId,
				);
				const id =
					options.entropyKey === undefined
						? generateId()
						: calendarNodeId(options.entropyKey, level, levelDateId, date.year);
				if (sim.nodes.has(id))
				{
					sim.move(id, parentId, index);
				}
				else
				{
					sim.create(
						{
							op: "create",
							id,
							parentId,
							index,
							name: calendarLevelName(level, date, options.dateFormat, weekStartDay),
							metadata:
							{
								restorableUniqueNode: true,
								calendar: calendarLevelMetadata(level, date, weekStartDay),
							},
						},
					);
				}
				parentId = id;
			}
			else
			{
				parentId = match.id;
			}
			if (level === stopAt)
			{
				break;
			}
		}
		return parentId;
	};

	// Upstream `m`: dated nodes among the root's non-calendar children.
	const collect = (node: SimNode): void =>
	{
		if (node.calendar !== undefined || node.isMirror)
		{
			return;
		}
		const dated = nodeDate(node);
		if (dated === undefined)
		{
			sim.children(node.id).forEach(collect);
			return;
		}
		collected.add(node.id);
		if (dated.hasTime)
		{
			intoDay.push(
				{
					id: node.id,
					dateId: dated.dateId,
				},
			);
			return;
		}
		if (findDay(dated.dateId) === undefined && !days.some((placed) => placed.dateId === dated.dateId))
		{
			sim.setCalendar(node.id, calendarLevelMetadata("day", toDate(dated.dateId)));
			days.push(
				{
					id: node.id,
					dateId: dated.dateId,
				},
			);
		}
		else
		{
			intoDay.push(
				{
					id: node.id,
					dateId: dated.dateId,
				},
			);
		}
	};
	sim.children(rootId).forEach(collect);

	// Upstream `i`: walk the level nodes.
	const walk = (node: SimNode): void =>
	{
		if (collected.has(node.id) || node.isMirror)
		{
			return;
		}
		if (node.id === rootId)
		{
			sim.children(node.id).forEach(walk);
			return;
		}
		if (node.calendar === undefined)
		{
			kept.push(node.id);
			return;
		}
		if (node.calendar.level !== "day")
		{
			prune.add(node.id);
			sim.children(node.id).forEach(walk);
			return;
		}
		const {dateId} = node.calendar;
		const existing = findDay(dateId);
		if (existing === undefined)
		{
			(days.some((placed) => placed.dateId === dateId) ? intoDay : days).push(
				{
					id: node.id,
					dateId,
				},
			);
		}
		else if (existing.id === node.id)
		{
			days.push(
				{
					id: node.id,
					dateId,
				},
			);
		}
		else
		{
			sim.setCalendar(node.id, null);
			intoDay.push(
				{
					id: node.id,
					dateId,
				},
			);
		}
	};
	walk(sim.get(rootId));

	sim.steps.push(
		{
			op: "set-levels",
			id: rootId,
			levels: Object.fromEntries(next.map((level) => [level, true])),
		},
	);
	days.sort((a, b) => a.dateId - b.dateId);

	/** Upstream `f`: the new parent for a node of `level` (or, by default, for a day). */
	const parentFor = (dateId: number, level?: CalendarLevel): string =>
	{
		const stopAt = level ?? (next.length > 1 ? next.at(-2) : undefined);
		return stopAt === undefined ? rootId : ensurePath(dateId, stopAt);
	};

	// Kept nodes follow their nearest still-shown level node, at its top.
	const keptCount = new Map<string, number>();
	for (const id of kept)
	{
		let holder = sim.get(id).parentId;
		while (
			holder !== null &&
			holder !== rootId &&
			!next.some((level) => sim.get(holder ?? "").calendar?.level === level)
		)
		{
			holder = sim.get(holder).parentId;
		}
		const holderNode = holder === null || holder === rootId ? undefined : sim.get(holder);
		const target =
			holderNode?.calendar === undefined
				? rootId
				: parentFor(holderNode.calendar.dateId, toLevel(holderNode.calendar.level));
		if (sim.get(id).parentId !== target)
		{
			const index = keptCount.get(target) ?? 0;
			keptCount.set(target, index + 1);
			sim.move(id, target, index);
		}
	}

	// Days go under their new parent in date order, after the kept nodes.
	for (const [position, {id, dateId}] of days.entries())
	{
		const target = next.length > 1 ? parentFor(dateId) : rootId;
		const node = sim.get(id);
		if (node.parentId === target && sim.location(id).index === position)
		{
			continue;
		}
		let index = keptCount.get(target) ?? 0;
		const siblings = sim.children(target);
		for (let slot = index; slot < siblings.length; slot++)
		{
			const calendar = siblings[slot]?.calendar;
			if (calendar?.level === "day")
			{
				if (calendar.dateId < dateId)
				{
					index = slot + 1;
				}
				else
				{
					break;
				}
			}
		}
		sim.move(id, target, index);
	}

	// Collected nodes move to the end of their day, grouped by day in first-seen order.
	const groups = new Map<string, string[]>();
	for (const {id, dateId} of intoDay)
	{
		const dayId = ensurePath(dateId);
		groups.set(dayId, [...(groups.get(dayId) ?? []), id]);
	}
	for (const [dayId, ids] of groups)
	{
		for (const id of ids)
		{
			// A node cannot move into itself or its own subtree (upstream would fail the same way).
			if (id !== dayId && !sim.isAncestor(id, dayId))
			{
				sim.move(id, dayId, sim.get(dayId).children.length);
			}
		}
	}

	// Upstream `d`: delete each emptied level node, then its emptied ancestors.
	const deleteIfEmpty = (id: string): void =>
	{
		const node = sim.nodes.get(id);
		if (node === undefined || id === rootId || node.calendar === undefined || node.children.length > 0)
		{
			return;
		}
		const {parentId} = node;
		sim.delete(id);
		if (parentId !== null)
		{
			deleteIfEmpty(parentId);
		}
	};
	for (const id of prune)
	{
		deleteIfEmpty(id);
	}
	return sim.steps;
}
