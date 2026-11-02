/**
 * 📆 Calendar date nodes, created the way upstream's Today does so
 * workflowy.com recognises them (deterministic ids and calendar metadata).
 *
 * `GET /api/v1/calendar/day/:dateId[?level=week|month|year]` -> 200 `{id, firstChildId}` / 404 (read-only lookup of the
 * day, or the week, month or year node holding it; `firstChildId` is the first live, non-references-root child, or null
 * when the node has none).
 * `GET /api/v1/calendar/days?year=&month=[&found=1]` -> 200 `{days}`: the month's days with
 * journal content, for the date picker's event dots; with `found=1` (the strip's picker) also the existing days a
 * dated node elsewhere covers, unless the root turns Found Dates off.
 * `GET /api/v1/calendar/settings` -> 200 `{foundDates, dayPrefix}`: the root's picker toggles, each default true.
 * `PUT /api/v1/calendar/settings` `{foundDates?, dayPrefix?}` -> 200 the new settings; writes the root's
 * `calendar.found_dates` / `calendar.day_prefix` metadata (409 when its internal metadata is not cached).
 * `GET /api/v1/calendar/layout` -> 200 `{levels, customLevels, needsConfirm, applyEnabled}`: what the Calendar Layout
 * dialog opens with (upstream `P10`): the root's levels, the levels whose nodes hold custom text or notes, whether
 * Update Layout first asks "Move nodes into your Calendar?", and whether Update Layout applies or only previews (409
 * without the root's cached internal metadata).
 * `PUT /api/v1/calendar/layout` `{levels, rootId?}` -> 200 `{rootId, writes}`: restructure the calendar (the tagged
 * root, or `rootId`, such as a sandbox copy) in one push, planned from the cache with only the written parents read
 * fresh, reporting each phase's time in `Server-Timing` (403 when `CALENDAR_LAYOUT_ENABLED=false`).
 * `POST /api/v1/calendar/layout/undo` `{rootId?}` -> 200 `{rootId, writes}`: undo the last applied layout once (409 when
 * there is none; 403 like PUT). PUT and undo resolve their root (409 when it is not cached), log it, and hand it to the
 * adapter, which refuses any write outside it.
 * `POST /api/v1/calendar/layout/preview` `{levels, rootId?}` -> 200 `{steps}`: the tree writes upstream's restructure
 * (`JX4`) would make for those levels, planned from the cache (under `rootId` when given); nothing is written.
 * `GET /api/v1/calendar/dots?from=YYYYMMDD&to=YYYYMMDD` -> 200 `{dateIds}`: the days in the range with journal
 * content, for the day strip's dots.
 * `POST /api/v1/calendar/day/:dateId/ensure[?level=week|month|year][&createChild=false]` -> 200
 * `{dayId, firstChildId, created}` (`dayId` is the week, month or year node with `level`), or 403 when
 * `CALENDAR_ENSURE_ENABLED=false`.
 */

import
{
	CALENDAR_LEVELS,
	CalendarRootMissing,
	calendarLayoutCustomLevels,
	calendarLayoutNeedsConfirm,
	parseDateId,
	planCalendarLayout,
} from "@outlinedb/shared/internal";
import type {CalendarLevel, LayoutTimings} from "@outlinedb/shared/internal";
import {z} from "zod";
import {findCalendarDay, findCalendarDays, findTaggedCalendarRoot, readCalendarSettings} from "../calendar-day.js";
import {foundDaysInMonth} from "../calendar-found.js";
import {loadCalendarLayout} from "../calendar-layout.js";
import type {CalendarDayDeps} from "../calendar-day.js";
import type {ServerContext} from "../context.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api-error.js";
import {defineOp, fail, ok, toJson} from "./define.js";

const ENSURE_DISABLED = "Calendar day ensure is disabled (CALENDAR_ENSURE_ENABLED=false)";
const INVALID_DATE_ID = "dateId must be a YYYYMMDD calendar day";
const INVALID_MONTH = "year and month must be a calendar year and a 1-12 month";
const INVALID_LEVEL = "level must be day, week, month or year";
const ROOT_METADATA_MISSING = "The 📆 Calendar root's internal metadata is not cached";
const MAX_DOT_RANGE_DAYS = 100;
const INVALID_RANGE = `from and to must be YYYYMMDD days at most ${MAX_DOT_RANGE_DAYS} days apart, from first`;
const DAY_MS = 86_400_000;
const LAYOUT_DISABLED = "Applying calendar layouts is disabled (CALENDAR_LAYOUT_ENABLED)";
const NOTHING_TO_UNDO = "There is no calendar layout to undo";
const LAYOUT_ROOT_MISSING = "No calendar root is cached for this layout";
const LayoutBody = z.object(
	{
		levels: z.strictObject(
			{
				year: z.boolean().optional(),
				month: z.boolean().optional(),
				week: z.boolean().optional(),
				day: z.boolean().optional(),
			},
		),
		rootId: z.string().min(1).optional(),
	},
);
const UndoBody = z.object(
	{
		rootId: z.string().min(1).optional(),
	},
);
/** At least one of the root's picker toggles. */
const SettingsBody = z
	.object(
		{
			foundDates: z.boolean().optional(),
			dayPrefix: z.boolean().optional(),
		},
	)
	.refine((settings) => settings.foundDates !== undefined || settings.dayPrefix !== undefined);
const CalendarLevelSchema = z.enum(CALENDAR_LEVELS);
/** The root's `calendar.levels`; a missing key is off. */
const LayoutLevelsSchema = z.partialRecord(CalendarLevelSchema, z.boolean());
export const CalendarSettingsSchema = z.strictObject(
	{
		foundDates: z.boolean(),
		dayPrefix: z.boolean(),
	},
);
/** What a layout write (or its undo) pushed; `writes` is 0 when the layout was already in place. */
export const AppliedLayoutSchema = z.strictObject(
	{
		rootId: z.string(),
		writes: z.number(),
	},
);
const CalendarLevelMetadataSchema = z.strictObject(
	{
		level: CalendarLevelSchema,
		value: z.string(),
		timestamp: z.number(),
		dateId: z.number(),
	},
);
const LayoutLocationSchema = z.strictObject(
	{
		parentId: z.string(),
		index: z.number(),
	},
);
/** One tree write of upstream's restructure, as `planCalendarLayout` returns it. */
export const LayoutStepSchema = z.discriminatedUnion("op", [
	z.strictObject(
		{
			op: z.literal("set-calendar"),
			id: z.string(),
			calendar: CalendarLevelMetadataSchema.nullable(),
		},
	),
	z.strictObject(
		{
			op: z.literal("set-levels"),
			id: z.string(),
			levels: z.partialRecord(CalendarLevelSchema, z.literal(true)),
		},
	),
	z.strictObject(
		{
			op: z.literal("create"),
			id: z.string(),
			parentId: z.string(),
			index: z.number(),
			name: z.string(),
			metadata: z.strictObject(
				{
					restorableUniqueNode: z.literal(true),
					calendar: CalendarLevelMetadataSchema,
				},
			),
		},
	),
	z.strictObject(
		{
			op: z.literal("move"),
			id: z.string(),
			parentId: z.string(),
			index: z.number(),
			from: LayoutLocationSchema,
		},
	),
	z.strictObject(
		{
			op: z.literal("delete"),
			id: z.string(),
			from: LayoutLocationSchema,
		},
	),
]);
/** The planned restructure `POST /calendar/layout/preview` answers. */
export const CalendarLayoutPreviewSchema = z.strictObject(
	{
		steps: z.array(LayoutStepSchema),
	},
);

/**
 * The calendar root a layout write targets: `explicitRootId` (a sandbox copy) or the tagged root, and only when that
 * node is cached; undefined otherwise. The adapter is always handed this id, never left to fall back on its own.
 */
function resolveLayoutRoot(ctx: ServerContext, explicitRootId: string | undefined): string | undefined
{
	const rootId =
		explicitRootId ??
		findTaggedCalendarRoot(
			{
				db: ctx.db,
			},
		);
	return rootId !== undefined && ctx.cacheService.getNode(rootId) !== undefined ? rootId : undefined;
}

/** Upstream `I10`'s levels when the root has none. */
const DEFAULT_LAYOUT_LEVELS =
{
	year: true,
	month: true,
	day: true,
};

/** The account date format, which names year and month nodes; empty (upstream's defaults) without the internal API. */
async function accountDateFormat(ctx: ServerContext): Promise<string>
{
	const dateFormat = await ctx.internalAdapter?.()?.getRootMeta(["dateFormat"]);
	return typeof dateFormat === "string" ? dateFormat : "";
}

/** The account's `weekStartDay`, which places weeks; undefined (Sunday) when unset or without the internal API. */
async function accountWeekStartDay(ctx: ServerContext): Promise<number | undefined>
{
	const weekStartDay = await ctx.internalAdapter?.()?.getRootMeta(["weekStartDay"]);
	return typeof weekStartDay === "number" ? weekStartDay : undefined;
}

/** The `?level=` query parameter (default day), else undefined. */
function levelParam(raw: string | undefined): CalendarLevel | undefined
{
	return raw === undefined ? "day" : CALENDAR_LEVELS.find((level) => level === raw);
}

/** A day dateId's UTC midnight. */
function utcOf(dateId: number): number
{
	return Date.UTC(Math.floor(dateId / 10_000), (Math.floor(dateId / 100) % 100) - 1, dateId % 100);
}

/** The days from `from` to `to` inclusive as dateIds, or undefined when the range is reversed or too long. */
function dayRange(from: number, to: number): number[] | undefined
{
	const start = utcOf(from);
	const length = Math.round((utcOf(to) - start) / DAY_MS) + 1;
	if (length < 1 || length > MAX_DOT_RANGE_DAYS)
	{
		return undefined;
	}
	return Array.from(
		{
			length,
		},
		(_, index) =>
		{
			const date = new Date(start + index * DAY_MS);
			return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
		},
	);
}

/** A `YYYYMMDD` path segment as a real calendar day's dateId, else undefined. */
function dayDateId(raw: string): number | undefined
{
	const dateId = Number(raw);
	return /^\d{8}$/u.test(raw) && parseDateId(dateId) !== undefined ? dateId : undefined;
}

/** A query parameter as an integer in `[min, max]`, else undefined. */
function intParam(raw: string | undefined, min: number, max: number): number | undefined
{
	const value = Number(raw);
	return raw !== undefined && /^\d+$/u.test(raw) && value >= min && value <= max ? value : undefined;
}

/** The lookup deps, with the account entropy key when the internal API can supply it. */
async function calendarDayDeps(ctx: ServerContext): Promise<CalendarDayDeps>
{
	try
	{
		const entropyKey = await ctx.internalAdapter?.()?.getEntropyKey();
		return {
			db: ctx.db,
			cache: ctx.cacheService,
			...(entropyKey === undefined
				? {}
				:
					{
						entropyKey,
					}),
		};
	}
	catch (error)
	{
		// The metadata and name lookups still find most days without it.
		console.error("Failed to read the account entropy key", error);
		return {
			db: ctx.db,
			cache: ctx.cacheService,
		};
	}
}

/** Upstream's event-dot test: two or more children, or a first child with a name or a note. */
function hasJournalContent(deps: CalendarDayDeps, dayId: string): boolean
{
	const children = deps.cache.getChildren(dayId);
	const [first] = children;
	return children.length >= 2 || Boolean(first?.name) || Boolean(first?.note);
}

/** The day's first live child that is not its references root, or null; Today puts the caret there. */
function firstDayChild(deps: CalendarDayDeps, dayId: string): string | null
{
	return deps.cache.getChildrenWithMergedData(dayId).find((child) => child.referencesRoot == null)?.id ?? null;
}

const DayInput = z.object(
	{
		dateId: z.string(),
		level: z.string().optional(),
	},
);
const DaysInput = z.object(
	{
		year: z.string().optional(),
		month: z.string().optional(),
		found: z.string().optional(),
	},
);
const DotsInput = z.object(
	{
		from: z.string().optional(),
		to: z.string().optional(),
	},
);
const EnsureInput = z.object(
	{
		dateId: z.string(),
		level: z.string().optional(),
		createChild: z.string().optional(),
	},
);

const notConfigured = () =>
	fail(
		503,
		{
			error: INTERNAL_API_NOT_CONFIGURED,
		},
	);

/** The root's picker toggles, each default true. */
const calendarSettingsGet = defineOp(
	{
		input: z.object({}),
		output: CalendarSettingsSchema,
		run(ctx)
		{
			return ok(
				toJson(
					readCalendarSettings(
						{
							db: ctx.db,
							cache: ctx.cacheService,
						},
					),
				),
			);
		},
	},
);

/** A found day (or the week, month or year holding it) and its first live child. */
export const CalendarDayResponseSchema = z.strictObject(
	{
		id: z.string(),
		firstChildId: z.string().nullable(),
	},
);
/** The month's days with journal content. */
export const CalendarDaysResponseSchema = z.strictObject(
	{
		days: z.array(z.number()),
	},
);
/** The range's YYYYMMDD days with journal content. */
export const CalendarDotsResponseSchema = z.strictObject(
	{
		dateIds: z.array(z.number()),
	},
);
/** What ensuring a day made. */
export const CalendarEnsureResponseSchema = z.strictObject(
	{
		/** The ensured node: the day, or the week, month or year with `level`. */
		dayId: z.string(),
		firstChildId: z.string().nullable(),
		/** Ids created by this call, outermost first. */
		created: z.array(z.string()),
	},
);

/** `{id, firstChildId}` for a day (or the week, month or year holding it), 404 when it is not found. */
const calendarDay = defineOp(
	{
		input: DayInput,
		output: CalendarDayResponseSchema,
		async run(ctx, input)
		{
			const dateId = dayDateId(input.dateId);
			if (dateId === undefined)
			{
				return fail(
					400,
					{
						error: INVALID_DATE_ID,
					},
				);
			}
			const level = levelParam(input.level);
			if (level === undefined)
			{
				return fail(
					400,
					{
						error: INVALID_LEVEL,
					},
				);
			}
			const deps = await calendarDayDeps(ctx);
			const weekStartDay = level === "week" ? await accountWeekStartDay(ctx) : undefined;
			const id = findCalendarDay(
				weekStartDay === undefined
					? deps
					:
						{
							...deps,
							weekStartDay,
						},
				dateId,
				level,
			);
			return id === null
				? fail(
						404,
						{
							error: "Calendar day not found",
						},
					)
				: ok(
						{
							id,
							firstChildId: firstDayChild(deps, id),
						},
					);
		},
	},
);

/** The month's days with journal content, for the date picker's event dots. */
const calendarDays = defineOp(
	{
		input: DaysInput,
		output: CalendarDaysResponseSchema,
		async run(ctx, input)
		{
			const year = intParam(input.year, 1, 9999);
			const month = intParam(input.month, 1, 12);
			if (year === undefined || month === undefined)
			{
				return fail(
					400,
					{
						error: INVALID_MONTH,
					},
				);
			}
			const deps = await calendarDayDeps(ctx);
			// Upstream `S10`: a found date dots only a day whose node exists.
			const found =
				input.found === "1" && readCalendarSettings(deps).foundDates
					? foundDaysInMonth(deps, year, month)
					: new Set<number>();
			const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
			const dayIds = findCalendarDays(
				deps,
				Array.from(
					{
						length,
					},
					(_, index) => year * 10_000 + month * 100 + index + 1,
				),
			);
			const days = [...dayIds]
				.filter(([dateId, id]) => hasJournalContent(deps, id) || found.has(dateId % 100))
				.map(([dateId]) => dateId % 100);
			return ok(
				{
					days,
				},
			);
		},
	},
);

/** Writes the root's `calendar.found_dates` / `calendar.day_prefix` metadata. */
const calendarSettingsPut = defineOp(
	{
		input: z.object(
			{
				body: SettingsBody,
			},
		),
		output: CalendarSettingsSchema,
		async run(ctx, {body})
		{
			const changes = [
				...(body.foundDates === undefined
					? []
					: [
							{
								path: ["calendar", "found_dates"],
								value: body.foundDates,
							},
						]),
				...(body.dayPrefix === undefined
					? []
					: [
							{
								path: ["calendar", "day_prefix"],
								value: body.dayPrefix,
							},
						]),
			];
			const adapter = ctx.apiKey ? ctx.internalAdapter?.() : undefined;
			if (!adapter)
			{
				return notConfigured();
			}
			const rootId = findTaggedCalendarRoot(
				{
					db: ctx.db,
				},
			);
			if (rootId === undefined)
			{
				return fail(
					409,
					{
						error: ROOT_METADATA_MISSING,
					},
				);
			}
			await adapter.setNodeMetaValues(rootId, changes);
			return ok(
				toJson(
					readCalendarSettings(
						{
							db: ctx.db,
							cache: ctx.cacheService,
						},
					),
				),
			);
		},
	},
);

/** What the Calendar Layout dialog opens with. */
export const CalendarLayoutSchema = z.strictObject(
	{
		levels: LayoutLevelsSchema,
		/** Levels with nodes whose name or note was customized; turning one off deletes that text. */
		customLevels: z.array(CalendarLevelSchema),
		/** Whether Update Layout first asks to move dated nodes into the calendar. */
		needsConfirm: z.boolean(),
		/** Whether Update Layout applies the restructure (`CALENDAR_LAYOUT_ENABLED`) or only previews it. */
		applyEnabled: z.boolean(),
	},
);

const calendarLayoutGet = defineOp(
	{
		input: z.object({}),
		output: CalendarLayoutSchema,
		async run(ctx)
		{
			const snapshot = loadCalendarLayout(
				{
					db: ctx.db,
					cache: ctx.cacheService,
				},
			);
			if (snapshot === undefined)
			{
				return fail(
					409,
					{
						error: ROOT_METADATA_MISSING,
					},
				);
			}
			return ok(
				{
					levels: snapshot.levels ?? DEFAULT_LAYOUT_LEVELS,
					customLevels: calendarLayoutCustomLevels(snapshot.root, await accountDateFormat(ctx)),
					needsConfirm: calendarLayoutNeedsConfirm(snapshot.root),
					applyEnabled: ctx.calendarLayoutEnabled !== false,
				},
			);
		},
	},
);

/** Restructures the calendar in one push, reporting each phase's time in `Server-Timing`. */
const calendarLayoutPut = defineOp(
	{
		input: z.object(
			{
				body: LayoutBody,
			},
		),
		output: AppliedLayoutSchema,
		async run(ctx, {body})
		{
			if (ctx.calendarLayoutEnabled === false)
			{
				return fail(
					403,
					{
						error: LAYOUT_DISABLED,
					},
				);
			}
			const adapter = ctx.apiKey ? ctx.internalAdapter?.() : undefined;
			if (!adapter)
			{
				return notConfigured();
			}
			const {levels} = body;
			const rootId = resolveLayoutRoot(ctx, body.rootId);
			if (rootId === undefined)
			{
				return fail(
					409,
					{
						error: LAYOUT_ROOT_MISSING,
					},
				);
			}
			console.info(`calendar layout: applying under root ${rootId}`);
			const timings: LayoutTimings = {};
			try
			{
				const applied = await adapter.applyCalendarLayout(
					levels,
					{
						rootId,
						loadSnapshot: () =>
							loadCalendarLayout(
								{
									db: ctx.db,
									cache: ctx.cacheService,
								},
								rootId,
							),
						timings,
					},
				);
				const phases = Object.entries(timings).map(([phase, ms]) => `${phase};dur=${ms.toFixed(1)}`);
				console.info(
					`calendar layout: ${applied.writes} writes under root ${applied.rootId} (${phases.join(", ")})`,
				);
				return ok(
					toJson(applied),
					{
						timing: phases,
					},
				);
			}
			catch (error)
			{
				if (error instanceof CalendarRootMissing)
				{
					return fail(
						409,
						{
							error: error.message,
						},
					);
				}
				throw error;
			}
		},
	},
);

/** Undoes the last applied layout once. */
const calendarLayoutUndo = defineOp(
	{
		input: z.object(
			{
				body: UndoBody,
			},
		),
		output: AppliedLayoutSchema,
		async run(ctx, {body})
		{
			if (ctx.calendarLayoutEnabled === false)
			{
				return fail(
					403,
					{
						error: LAYOUT_DISABLED,
					},
				);
			}
			const adapter = ctx.apiKey ? ctx.internalAdapter?.() : undefined;
			if (!adapter)
			{
				return notConfigured();
			}
			const rootId = resolveLayoutRoot(ctx, body.rootId);
			if (rootId === undefined)
			{
				return fail(
					409,
					{
						error: LAYOUT_ROOT_MISSING,
					},
				);
			}
			console.info(`calendar layout: undoing under root ${rootId}`);
			const undone = await adapter.undoCalendarLayout(rootId);
			return undone === undefined
				? fail(
						409,
						{
							error: NOTHING_TO_UNDO,
						},
					)
				: ok(toJson(undone));
		},
	},
);

/** The steps the layout would take; nothing is written. */
const calendarLayoutPreview = defineOp(
	{
		input: z.object(
			{
				body: LayoutBody,
			},
		),
		output: CalendarLayoutPreviewSchema,
		async run(ctx, {body})
		{
			const {rootId} = body;
			const snapshot = loadCalendarLayout(
				{
					db: ctx.db,
					cache: ctx.cacheService,
				},
				rootId,
			);
			if (snapshot === undefined)
			{
				return fail(
					409,
					{
						error: ROOT_METADATA_MISSING,
					},
				);
			}
			// An explicit (sandbox) root gets random ids, as applying it does: deterministic ids belong to the real calendar.
			const {entropyKey} =
				rootId === undefined
					? await calendarDayDeps(ctx)
					:
						{
							entropyKey: undefined,
						};
			const weekStartDay = await accountWeekStartDay(ctx);
			const steps = planCalendarLayout(
				snapshot.root,
				body.levels,
				{
					...(snapshot.levels === undefined
						? {}
						:
							{
								currentLevels: snapshot.levels,
							}),
					dateFormat: await accountDateFormat(ctx),
					...(weekStartDay === undefined
						? {}
						:
							{
								weekStartDay,
							}),
					...(entropyKey === undefined
						? {}
						:
							{
								entropyKey,
							}),
				},
			);
			return ok(
				toJson(
					{
						steps,
					},
				),
			);
		},
	},
);

/** The days in a range with journal content, for the day strip's dots. */
const calendarDots = defineOp(
	{
		input: DotsInput,
		output: CalendarDotsResponseSchema,
		async run(ctx, input)
		{
			const from = dayDateId(input.from ?? "");
			const to = dayDateId(input.to ?? "");
			const days = from === undefined || to === undefined ? undefined : dayRange(from, to);
			if (days === undefined)
			{
				return fail(
					400,
					{
						error: INVALID_RANGE,
					},
				);
			}
			const deps = await calendarDayDeps(ctx);
			const dateIds = [...findCalendarDays(deps, days)]
				.filter(([, id]) => hasJournalContent(deps, id))
				.map(([dateId]) => dateId);
			return ok(
				{
					dateIds,
				},
			);
		},
	},
);

/** Creates the day (and its ancestors) the way upstream's Today does. */
const calendarEnsure = defineOp(
	{
		input: EnsureInput,
		output: CalendarEnsureResponseSchema,
		async run(ctx, input)
		{
			if (ctx.calendarEnsureEnabled !== true)
			{
				return fail(
					403,
					{
						error: ENSURE_DISABLED,
					},
				);
			}
			// Tree writes refresh the cache through the public API, so they need its key too.
			const adapter = ctx.apiKey ? ctx.internalAdapter?.() : undefined;
			if (!adapter)
			{
				return notConfigured();
			}
			const dateId = dayDateId(input.dateId);
			if (dateId === undefined)
			{
				return fail(
					400,
					{
						error: INVALID_DATE_ID,
					},
				);
			}
			const stopAt = levelParam(input.level);
			if (stopAt === undefined)
			{
				return fail(
					400,
					{
						error: INVALID_LEVEL,
					},
				);
			}
			try
			{
				return ok(
					toJson(
						await adapter.ensureCalendarDay(
							dateId,
							{
								stopAt,
								createChild: input.createChild !== "false",
							},
						),
					),
				);
			}
			catch (error)
			{
				if (error instanceof CalendarRootMissing)
				{
					return fail(
						409,
						{
							error: error.message,
						},
					);
				}
				throw error;
			}
		},
	},
);

export const calendarOps =
{
	"calendar.day": calendarDay,
	"calendar.days": calendarDays,
	"calendar.dots": calendarDots,
	"calendar.ensure": calendarEnsure,
	"calendar.layoutGet": calendarLayoutGet,
	"calendar.layoutPreview": calendarLayoutPreview,
	"calendar.layoutPut": calendarLayoutPut,
	"calendar.layoutUndo": calendarLayoutUndo,
	"calendar.settingsGet": calendarSettingsGet,
	"calendar.settingsPut": calendarSettingsPut,
};
