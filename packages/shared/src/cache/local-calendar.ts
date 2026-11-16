/**
 * The `📆 Calendar` of a standalone account, which has no workflowy.com behind it: Today's day nodes and Calendar
 * Layout written straight into the local tables through {@link LocalTreeWriter}, with the deterministic ids the
 * account's entropy key gives (as upstream gives them).
 */

import {and, eq} from "drizzle-orm";
import {nodeContent} from "../db/schema.js";
import {FAR_FUTURE_DATE, temporalTimestampJustBefore} from "../temporal/constants.js";
import {calendarLayoutUndoWrites} from "../internal/calendar-layout-undo.js";
import {calendarLayoutWrites} from "../internal/calendar-layout-apply.js";
import {planCalendarLayout} from "../internal/calendar-layout.js";
import type {CalendarLayoutLevels} from "../internal/calendar-layout.js";
import {calendarChainSpecs} from "../internal/calendar-chain.js";
import type {CalendarChainSpec} from "../internal/calendar-chain.js";
import {CalendarRootMissing, calendarInsertIndex, parseDateId} from "../internal/calendar-day.js";
import type {CalendarLevel} from "../internal/calendar-day.js";
import {calendarRootId} from "../internal/calendar-ids.js";
import type {AppliedCalendarLayout, CalendarLayoutSnapshot, EnsuredCalendarDay} from "../internal/adapter.js";
import type {NewTree} from "../internal/ops.js";
import type {AppDatabase} from "../db/types.js";
import {CALENDAR_ROOT_NAME, findTaggedCalendarRoot} from "./calendar-lookup.js";
import
{
	assertLayoutWritesUnder,
	endLayoutApplied,
	layoutAppliedAt,
	recordLayoutApplied,
} from "./calendar-layout-applies.js";
import {readNodeInternalMetadata} from "./internal-metadata.js";
import {LocalAccount} from "./local-account.js";
import {LocalTreeWriter, currentChildIds} from "./local-tree-writer.js";
import type {LocalTreeWriterOptions} from "./local-tree-writer.js";
import {readSubtreeAt} from "./subtree-history.js";
import {newSystemTimestamp} from "./system-time.js";

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a calendar reads root metadata and the entropy key, and names a new calendar root. */
export type CalendarAccount = Pick<LocalAccount, "getEntropyKey" | "getRootMeta" | "setRootMetaValues">;

export interface LocalCalendarOptions extends LocalTreeWriterOptions
{
	/**
	 * The account state: a standalone account's local tables by default. A mirror passes its internal adapter, since
	 * account-level state still writes through to workflowy.com there.
	 */
	account?: CalendarAccount;
	/**
	 * Whether a missing calendar root is created (the default). A mirror passes false: its root lives on workflowy.com,
	 * so a missing local one means a stale cache, and creating it would fork a second root.
	 */
	createRoot?: boolean;
}

export class LocalCalendar
{
	private readonly account: CalendarAccount;
	private readonly writer: LocalTreeWriter;
	private readonly generateId: () => string;
	private readonly createRoot: boolean;

	constructor(
		private readonly db: AppDatabase,
		options: LocalCalendarOptions = {},
	)
	{
		this.account = options.account ?? new LocalAccount(db);
		this.writer = new LocalTreeWriter(db, options);
		this.generateId = options.generateId ?? (() => crypto.randomUUID());
		this.createRoot = options.createRoot ?? true;
	}

	/**
	 * Find or create the day node for a `YYYYMMDD` dateId as upstream's Today (`C9`) does: for each level the root
	 * shows, down to `stopAt`, a child whose calendar metadata (or deterministic id) matches is reused; else the
	 * deterministic node is moved back when it lives elsewhere, or created with the levels below it at the
	 * timestamp-sorted slot. With `createChild` a new or empty final node gets one empty child. A missing calendar root
	 * is created at the end of Home and named by root metadata `calendar.rootId`, unless `createRoot` is off.
	 */
	async ensureCalendarDay(
		dateId: number,
		{
			stopAt = "day",
			createChild = true,
		}:
		{
			stopAt?: CalendarLevel;
			createChild?: boolean;
		} = {},
	): Promise<EnsuredCalendarDay>
	{
		const date = parseDateId(dateId);
		if (date === undefined)
		{
			throw new RangeError(`${dateId} is not a YYYYMMDD date`);
		}
		const entropyKey = await this.account.getEntropyKey();
		const rootId = await this.ensureRoot(entropyKey);
		const dateFormat = await this.account.getRootMeta(["dateFormat"]);
		const weekStartDay = await this.account.getRootMeta(["weekStartDay"]);
		const levels = this.calendarOf(rootId)?.levels;
		const specs = calendarChainSpecs(
			date,
			{
				shown: isRecord(levels) ? levels : undefined,
				stopAt,
				dateFormat: typeof dateFormat === "string" ? dateFormat : "",
				weekStartDay: typeof weekStartDay === "number" ? weekStartDay : 0,
				entropyKey,
			},
		);
		const created: string[] = [];
		let parentId = rootId;
		for (let position = 0; position < specs.length; position += 1)
		{
			const spec = specs[position];
			if (spec === undefined)
			{
				break;
			}
			const children = currentChildIds(this.db, parentId);
			const found = children.find((child) =>
			{
				const calendar = this.levelOf(child);
				return child === spec.id || (calendar?.level === spec.level && calendar.dateId === spec.levelDateId);
			});
			if (found !== undefined)
			{
				parentId = found;
				continue;
			}
			const index = calendarInsertIndex(
				children.map((child) => this.levelOf(child)),
				spec.level,
				spec.levelDateId,
			);
			if (spec.id !== undefined && this.isLive(spec.id))
			{
				this.writer.moveTo(
					{
						ids: [spec.id],
						parentId,
						index,
					},
				);
				parentId = spec.id;
				continue;
			}
			// This level and each deeper one whose deterministic node is not elsewhere are created together.
			let end = position + 1;
			while (end < specs.length && !this.isLive(specs[end]?.id))
			{
				end += 1;
			}
			const chain = specs.slice(position, end).map((link) => this.toCreate(link));
			const childId = end === specs.length && createChild ? this.generateId() : undefined;
			this.writer.createTreesAt(
				{
					parentId,
					index,
					trees: [nestChain(chain, childId)],
				},
			);
			created.push(...chain.map((node) => node.id), ...(childId === undefined ? [] : [childId]));
			parentId = chain.at(-1)?.id ?? parentId;
			if (end === specs.length)
			{
				return {
					dayId: parentId,
					firstChildId: childId ?? null,
					created,
				};
			}
			position = end - 1;
		}
		let firstChildId = currentChildIds(this.db, parentId)[0] ?? null;
		if (firstChildId === null && createChild)
		{
			firstChildId = this.generateId();
			this.writer.createAt(
				{
					parentId,
					index: 0,
					id: firstChildId,
					name: "",
				},
			);
			created.push(firstChildId);
		}
		return {
			dayId: parentId,
			firstChildId,
			created,
		};
	}

	/**
	 * Restructure the calendar under `rootId` to show `levels` the way upstream's Update Layout does (`JX4`), planned
	 * from `loadSnapshot` and written in one unit of work, refused when a write would land outside `rootId`. A root tagged `calendar.root` gets the account's
	 * deterministic ids for new level nodes; any other root (a sandbox copy) gets random ones. The system time just
	 * before the writes is recorded for {@link undoCalendarLayout}.
	 */
	async applyCalendarLayout(
		levels: CalendarLayoutLevels,
		{
			rootId,
			loadSnapshot,
		}:
		{
			rootId: string;
			loadSnapshot: () => CalendarLayoutSnapshot | undefined;
		},
	): Promise<AppliedCalendarLayout>
	{
		const snapshot = loadSnapshot();
		if (snapshot === undefined)
		{
			throw new CalendarRootMissing();
		}
		if (snapshot.root.id !== rootId)
		{
			throw new Error(`calendar layout: planned root ${snapshot.root.id} is not the requested root ${rootId}`);
		}
		const dateFormat = await this.account.getRootMeta(["dateFormat"]);
		const weekStartDay = await this.account.getRootMeta(["weekStartDay"]);
		const entropyKey = this.calendarOf(rootId)?.root === true ? await this.account.getEntropyKey() : undefined;
		const steps = planCalendarLayout(
			snapshot.root,
			levels,
			{
				...(snapshot.levels === undefined
					? {}
					:
						{
							currentLevels: snapshot.levels,
						}),
				dateFormat: typeof dateFormat === "string" ? dateFormat : "",
				...(typeof weekStartDay === "number"
					?
						{
							weekStartDay,
						}
					: {}),
				...(entropyKey === undefined
					? {}
					:
						{
							entropyKey,
						}),
				generateId: this.generateId,
			},
		);
		for (const step of steps)
		{
			if (step.op === "create" && this.isLive(step.id))
			{
				throw new Error(`calendar layout: new level node ${step.id} already exists outside the calendar`);
			}
		}
		const ids = new Set(steps.map((step) => step.id));
		const {writes} = calendarLayoutWrites(
			steps,
			new Map([...ids].map((id) => [id, readNodeInternalMetadata(this.db, id)])),
		);
		assertLayoutWritesUnder(this.db, rootId, writes);
		if (writes.length > 0)
		{
			const appliedAt = newSystemTimestamp();
			this.writer.applyLayoutWrites(writes);
			recordLayoutApplied(this.db, rootId, appliedAt);
		}
		return {
			rootId,
			writes: writes.length,
		};
	}

	/**
	 * Undo the last {@link applyCalendarLayout} under `rootId` in one unit of work, from temporal history: the subtree
	 * as of just before the layout, compared with the subtree now. Undefined when no layout there is waiting to be
	 * undone; once used, the applied layout is phased out.
	 */
	async undoCalendarLayout(rootId: string): Promise<AppliedCalendarLayout | undefined>
	{
		const appliedAt = layoutAppliedAt(this.db, rootId);
		if (appliedAt === undefined)
		{
			return Promise.resolve(undefined);
		}
		const before = readSubtreeAt(this.db, rootId, temporalTimestampJustBefore(appliedAt));
		const now = readSubtreeAt(this.db, rootId);
		const writes = calendarLayoutUndoWrites(rootId, before, now, (id) => this.isLive(id));
		assertLayoutWritesUnder(this.db, rootId, writes);
		if (writes.length > 0)
		{
			this.writer.applyLayoutWrites(writes);
		}
		endLayoutApplied(this.db, rootId);
		return Promise.resolve(
			{
				rootId,
				writes: writes.length,
			},
		);
	}

	/**
	 * Upstream's `Calendar.ensure`: the root root metadata `calendar.rootId` names, else the `calendar.root`-tagged
	 * node; else a new `📆 Calendar` at the end of Home with id `uuidv5("calendar-root")`, which `calendar.rootId` then
	 * names.
	 */
	private async ensureRoot(entropyKey: string | undefined): Promise<string>
	{
		const found = findTaggedCalendarRoot(
			{
				db: this.db,
			},
		);
		if (found !== undefined)
		{
			return found;
		}
		if (!this.createRoot)
		{
			throw new CalendarRootMissing();
		}
		const {ids} = this.writer.createTreesAt(
			{
				parentId: null,
				trees: [
					{
						id: entropyKey === undefined ? this.generateId() : calendarRootId(entropyKey),
						name: CALENDAR_ROOT_NAME,
						metadata:
						{
							restorableUniqueNode: true,
							calendar:
							{
								root: true,
							},
						},
					},
				],
			},
		);
		const [id] = ids;
		if (id === undefined)
		{
			throw new Error("Creating the calendar root produced no id");
		}
		await this.account.setRootMetaValues([
			{
				path: ["calendar", "rootId"],
				value: id,
			},
		]);
		return id;
	}

	private toCreate({id, name, metadata}: CalendarChainSpec): Required<Pick<NewTree, "id" | "name" | "metadata">>
	{
		return {
			id: id ?? this.generateId(),
			name,
			metadata,
		};
	}

	/** A node's stored `calendar` metadata, if any. */
	private calendarOf(id: string): Record<string, unknown> | undefined
	{
		const {calendar} = readNodeInternalMetadata(this.db, id);
		return isRecord(calendar) ? calendar : undefined;
	}

	/** A node's calendar level and dateId, if it has both. */
	private levelOf(id: string):
		|
		  {
				level: string;
				dateId: number;
		  }
		| undefined
	{
		const calendar = this.calendarOf(id);
		return typeof calendar?.level === "string" && typeof calendar.dateId === "number"
			?
				{
					level: calendar.level,
					dateId: calendar.dateId,
				}
			: undefined;
	}

	private isLive(id: string | undefined): boolean
	{
		return (
			id !== undefined &&
			this.db
				.select(
					{
						id: nodeContent.id,
					},
				)
				.from(nodeContent)
				.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
				.get() !== undefined
		);
	}
}

/** `chain` with each node nesting the next, and an empty `childId` under the last one. */
function nestChain(chain: Required<Pick<NewTree, "id" | "name" | "metadata">>[], childId: string | undefined): NewTree
{
	const leaf: NewTree[] =
		childId === undefined
			? []
			: [
					{
						id: childId,
						name: "",
					},
				];
	const [top] = chain.reduceRight<NewTree[]>(
		(children, node) => [
			{
				...node,
				children,
			},
		],
		leaf,
	);
	if (top === undefined)
	{
		throw new Error("An empty calendar chain");
	}
	return top;
}
