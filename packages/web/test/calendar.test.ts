import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {calendarNodeId, CalendarRootMissing} from "@outlinedb/shared/internal";
import type {WorkflowyInternalAdapter, CalendarLayoutSnapshot, LayoutTimings} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {findCalendarDay, findCalendarDays, findTaggedCalendarRoot} from "../src/server/calendar-day.js";
import type {ServerContext, AppEnv} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {Hono} from "hono";
import type {FoundDatesResponse, CalendarLayout} from "../src/node-types.js";
import {z} from "zod";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {layoutAppliedMessage, layoutPreviewMessage, layoutWarningLevels} from "../src/client/calendar-layout-model.js";
import {CalendarLayoutView} from "../src/client/components/calendar-layout-view.js";
import {stripPickerSelection} from "../src/client/components/calendar-picker-settings.js";
import
{
	attachDragScroll,
	attachOutsideDismiss,
	calendarPageDate,
	monthCellTarget,
	runStripDrop,
	scrollDelta,
	scrollStripOnMount,
	stripAutoscrollSpeed,
	stripDropTarget,
	stripNav,
	stripPage,
} from "../src/client/calendar-strip-model.js";
import type {StripDropCell, StripLevel} from "../src/client/calendar-strip-model.js";
import type {MoveToToast} from "../src/client/move-to.js";
import type {CalendarTarget} from "../src/client/today.js";
import type {BlockMove} from "../src/client/tree-ops.js";
import {CalendarStripView} from "../src/client/components/calendar-strip-view.js";
import type {CalendarStripViewProps} from "../src/client/components/calendar-strip-view.js";

describe("calendar day", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const KEY = "k";
	const D1017 = calendarNodeId(KEY, "day", 20_261_017);
	const D1005_ELSEWHERE = calendarNodeId(KEY, "day", 20_261_005);
	const W0906 = calendarNodeId(KEY, "week", 20_260_906, 2026);

	function time(year: number, month: number, day: number): string
	{
		return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
	}

	/** [id, parent, name, metadata?]: a 📆 Calendar root with legacy, metadata-tagged and deterministic days, and month-level entries that mention a date. */
	const TREE: [string, string | null, string, Record<string, unknown>?][] = [
		[
			"cal",
			null,
			"📆 Calendar",
			{
				calendar:
				{
					root: true,
					levels:
					{
						year: true,
						month: true,
						day: true,
					},
				},
			},
		],
		["other", null, "Other"],
		[D1005_ELSEWHERE, "other", time(2026, 10, 5)],
		[
			"y2026",
			"cal",
			"2026",
			{
				calendar:
				{
					level: "year",
					value: "2026",
					timestamp: 0,
					dateId: 20_260_000,
				},
			},
		],
		[
			"m09",
			"y2026",
			"9",
			{
				calendar:
				{
					level: "month",
					value: "9",
					timestamp: 0,
					dateId: 20_260_900,
				},
			},
		],
		["d0902", "m09", time(2026, 9, 2)],
		[
			"d0930",
			"m09",
			"Sept 30",
			{
				calendar:
				{
					level: "day",
					value: "30",
					timestamp: 0,
					dateId: 20_260_930,
				},
			},
		],
		[W0906, "m09", "Week 37"],
		[
			"m10",
			"y2026",
			"10",
			{
				calendar:
				{
					level: "month",
					value: "10",
					timestamp: 0,
					dateId: 20_261_000,
				},
			},
		],
		[
			"a-entry-1001",
			"m10",
			'<time startYear="2026" startMonth="10" startDay="1" startHour="9">Oct 1 at 9am</time> Standup',
		],
		["b-kickoff-1001", "m10", `Kickoff ${time(2026, 10, 1)}`],
		["d1001", "m10", time(2026, 10, 1)],
		[
			D1017,
			"m10",
			"Today",
			{
				calendar:
				{
					level: "day",
					value: "17",
					timestamp: 0,
					dateId: 20_261_017,
				},
			},
		],
		[
			"w1011",
			"m10",
			"Week 42",
			{
				calendar:
				{
					level: "week",
					value: "42",
					timestamp: 0,
					dateId: 20_261_011,
				},
			},
		],
		[
			"z01",
			"y2026",
			"1",
			{
				calendar:
				{
					level: "month",
					value: "1",
					timestamp: 0,
					dateId: 20_260_100,
				},
			},
		],
		["u0115", "z01", time(2026, 1, 15)],
		[
			"nested",
			"u0115",
			"link",
			{
				calendar:
				{
					level: "day",
					value: "15",
					timestamp: 0,
					dateId: 20_260_115,
				},
			},
		],
	];

	/** [id, priority, kind]: today's children, inserted out of priority order; the references root and the deleted child sort first. */
	const D1017_CHILDREN: [string, number, "live" | "referencesRoot" | "deleted"][] = [
		["second", 3, "live"],
		["refs", 0, "referencesRoot"],
		["deleted", 1, "deleted"],
		["first", 2, "live"],
	];

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	function setup(
		onStatement: (sql: string) => void = () =>
		{
		},
		{
			taggedRoot = true,
		}:
		{
			taggedRoot?: boolean;
		} = {},
	)
	{
		const sqlite = new DatabaseConstructor(
			":memory:",
			{
				verbose: (sql) =>
				{
					onStatement(String(sql));
				},
			},
		);
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		for (const [id, parentId, name, metadata] of TREE)
		{
			db.insert(schema.nodeContent)
				.values(
					{
						id,
						name,
						parentId,
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			if (metadata !== undefined && (taggedRoot || id !== "cal"))
			{
				storeInternalMetadata(db, new Map([[id, metadata]]));
			}
		}
		for (const [id, priority, kind] of D1017_CHILDREN)
		{
			const systemTo = kind === "deleted" ? "2026-02-01" : FAR_FUTURE_DATE;
			db.insert(schema.nodeContent)
				.values(
					{
						id,
						name: id,
						parentId: D1017,
						systemFrom: "2026-01-01",
						systemTo,
					},
				)
				.run();
			db.insert(schema.nodeMetadata)
				.values(
					{
						nodeId: id,
						priority,
						systemFrom: "2026-01-01",
						systemTo,
					},
				)
				.run();
			if (kind === "referencesRoot")
			{
				db.insert(schema.referencesRoots)
					.values(
						{
							nodeId: id,
							systemFrom: "2026-01-01",
							systemTo,
						},
					)
					.run();
			}
		}
		return {
			db,
			cache: new CacheService(db),
		};
	}

	describe("findCalendarDay", () =>
	{
		it("walks the root's direct children by calendar metadata, as upstream does", () =>
		{
			const deps =
			{
				...setup(),
				entropyKey: KEY,
			};

			expect(
				[20_261_017, 20_260_930, 20_261_001, 20_260_902, 20_261_005, 20_260_115].map((dateId) =>
					findCalendarDay(deps, dateId),
				),
			).toStrictEqual([D1017, "d0930", null, null, null, null]);
		});

		it("keeps the lenient deterministic-id, metadata and name lookup when the root is untagged", () =>
		{
			const deps =
			{
				...setup(
					undefined,
					{
						taggedRoot: false,
					},
				),
				entropyKey: KEY,
			};

			expect(
				[20_261_017, 20_260_930, 20_261_001, 20_260_902, 20_261_005].map((dateId) =>
					findCalendarDay(deps, dateId),
				),
			).toStrictEqual([D1017, "d0930", "d1001", "d0902", null]);
		});

		it("finds the month or year node holding a day by its calendar metadata", () =>
		{
			const deps =
			{
				...setup(),
				entropyKey: KEY,
			};

			expect([
				findCalendarDay(deps, 20_261_017, "month"),
				findCalendarDay(deps, 20_260_902, "month"),
				findCalendarDay(deps, 20_261_017, "year"),
				findCalendarDay(deps, 20_271_017, "year"),
			]).toStrictEqual(["m10", "m09", "y2026", null]);
		});

		it("finds the week holding a day by calendar metadata, its start per weekStartDay", () =>
		{
			const deps =
			{
				...setup(),
				entropyKey: KEY,
			};

			expect([
				findCalendarDay(deps, 20_260_909, "week"),
				findCalendarDay(deps, 20_261_015, "week"),
				findCalendarDay(
					{
						...deps,
						weekStartDay: 1,
					},
					20_261_015,
					"week",
				),
				findCalendarDay(deps, 20_261_020, "week"),
			]).toStrictEqual([null, "w1011", null, null]);
		});

		it("skips the deterministic id without an entropy key and still walks names when the root is untagged", () =>
		{
			const deps = setup(
				undefined,
				{
					taggedRoot: false,
				},
			);

			expect([20_261_017, 20_261_001].map((dateId) => findCalendarDay(deps, dateId))).toStrictEqual([
				D1017,
				"d1001",
			]);
		});

		/** A second, untagged calendar root `alt` holding a tagged 2026 > 10 > 17, and root metadata `calendar.rootId` naming `pointer`. */
		function withPointer(pointer: string)
		{
			const deps = setup();
			const alt: [string, string | null, string, Record<string, unknown>?][] = [
				["alt", null, "Alt Calendar"],
				[
					"alt-y",
					"alt",
					"2026",
					{
						calendar:
						{
							level: "year",
							value: "2026",
							timestamp: 0,
							dateId: 20_260_000,
						},
					},
				],
				[
					"alt-m",
					"alt-y",
					"10",
					{
						calendar:
						{
							level: "month",
							value: "10",
							timestamp: 0,
							dateId: 20_261_000,
						},
					},
				],
				[
					"alt-d",
					"alt-m",
					"17",
					{
						calendar:
						{
							level: "day",
							value: "17",
							timestamp: 0,
							dateId: 20_261_017,
						},
					},
				],
			];
			for (const [id, parentId, name, metadata] of alt)
			{
				deps.db
					.insert(schema.nodeContent)
					.values(
						{
							id,
							name,
							parentId,
							systemFrom: "2026-01-01",
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
				if (metadata !== undefined)
				{
					storeInternalMetadata(deps.db, new Map([[id, metadata]]));
				}
			}
			deps.db
				.insert(schema.rootPreferences)
				.values(
					{
						userId: "1",
						calendarRootId: pointer,
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			return {
				...deps,
				entropyKey: KEY,
			};
		}

		it("finds the root through root metadata calendar.rootId when it names a live node, like upstream's Calendar.find", () =>
		{
			const deps = withPointer("alt");

			expect(
				{
					root: findTaggedCalendarRoot(deps),
					day: findCalendarDay(deps, 20_261_017),
					days: findCalendarDays(deps, [20_261_017]),
				},
			).toStrictEqual(
				{
					root: "alt",
					day: "alt-d",
					days: new Map([[20_261_017, "alt-d"]]),
				},
			);
		});

		it("falls back to the calendar.root-tagged node when calendar.rootId names no live node", () =>
		{
			const deps = withPointer("gone");

			expect(
				{
					root: findTaggedCalendarRoot(deps),
					day: findCalendarDay(deps, 20_261_017),
				},
			).toStrictEqual(
				{
					root: "cal",
					day: D1017,
				},
			);
		});
	});

	describe("findCalendarDays", () =>
	{
		const SEPT_OCT = Array.from(
			{
				length: 61,
			},
			(_, index) => (index < 30 ? 20_260_901 + index : 20_261_001 + index - 30),
		);

		it("finds each day as findCalendarDay does, only the upstream-visible ones", () =>
		{
			const deps =
			{
				...setup(),
				entropyKey: KEY,
			};
			const expected = new Map(
				SEPT_OCT.flatMap((dateId) =>
				{
					const id = findCalendarDay(deps, dateId);
					return id === null ? [] : [[dateId, id] as const];
				}),
			);

			expect(findCalendarDays(deps, SEPT_OCT)).toStrictEqual(expected);
			expect(expected).toStrictEqual(
				new Map([
					[20_260_930, "d0930"],
					[20_261_017, D1017],
				]),
			);
		});

		it("also dots name-only days when the root is untagged", () =>
		{
			const deps =
			{
				...setup(
					undefined,
					{
						taggedRoot: false,
					},
				),
				entropyKey: KEY,
			};

			expect(findCalendarDays(deps, SEPT_OCT)).toStrictEqual(
				new Map([
					[20_260_902, "d0902"],
					[20_260_930, "d0930"],
					[20_261_001, "d1001"],
					[20_261_017, D1017],
				]),
			);
		});

		it("scans the calendar metadata table unkeyed once for the root, not per day", () =>
		{
			const scans: string[] = [];
			const deps =
			{
				...setup((sql) =>
				{
					scans.push(sql);
				}),
				entropyKey: KEY,
			};
			scans.length = 0;

			findCalendarDays(deps, SEPT_OCT);

			expect(scans.filter(isCalendarScan)).toHaveLength(1);
		});
	});

	describe("GET /api/v1/calendar/day/:dateId", () =>
	{
		function app(entropyKey: string | undefined, taggedRoot = true)
		{
			const {db, cache} = setup(
				undefined,
				{
					taggedRoot,
				},
			);
			const adapter =
			{
				getEntropyKey: async () => Promise.resolve(entropyKey),
				getRootMeta: async () => Promise.resolve(undefined),
			};
			const ctx =
			{
				db,
				cacheService: cache,
				internalAdapter: () =>
					entropyKey === undefined ? undefined : (adapter as unknown as WorkflowyInternalAdapter),
			} as unknown as ServerContext;
			const hono = httpAppFor(ctx);
			return async (dateId: string, query = "") =>
			{
				const res = await hono.fetch(new Request(`http://x/api/v1/calendar/day/${dateId}${query}`));
				return {
					status: res.status,
					body: (await res.json()) as unknown,
				};
			};
		}

		it("answers the day's id and first live, non-references-root child, using the account entropy key when the internal API is configured", async () =>
		{
			const get = app(KEY);

			await expect(Promise.all([get("20261017"), get("20261005"), get("20260230")])).resolves.toStrictEqual([
				{
					status: 200,
					body:
					{
						id: D1017,
						firstChildId: "first",
					},
				},
				{
					status: 404,
					body:
					{
						error: "Calendar day not found",
					},
				},
				{
					status: 400,
					body:
					{
						error: "dateId must be a YYYYMMDD calendar day",
					},
				},
			]);
		});

		it("falls back to metadata and names without the internal API", async () =>
		{
			const get = app(undefined, false);

			await expect(Promise.all([get("20261001"), get("20260930")])).resolves.toStrictEqual([
				{
					status: 200,
					body:
					{
						id: "d1001",
						firstChildId: null,
					},
				},
				{
					status: 200,
					body:
					{
						id: "d0930",
						firstChildId: null,
					},
				},
			]);
		});

		it("answers 404 for a name-only day once the root is tagged", async () =>
		{
			const get = app(KEY);

			await expect(get("20261001")).resolves.toStrictEqual(
				{
					status: 404,
					body:
					{
						error: "Calendar day not found",
					},
				},
			);
		});

		it("answers the week, month or year node holding the day for ?level=, and rejects other levels", async () =>
		{
			const get = app(KEY);

			await expect(
				Promise.all([
					get("20260902", "?level=month"),
					get("20260902", "?level=year"),
					get("20261015", "?level=week"),
					get("20260902", "?level=hour"),
				]),
			).resolves.toStrictEqual([
				{
					status: 200,
					body:
					{
						id: "m09",
						firstChildId: "d0902",
					},
				},
				{
					status: 200,
					body:
					{
						id: "y2026",
						firstChildId: "m09",
					},
				},
				{
					status: 200,
					body:
					{
						id: "w1011",
						firstChildId: null,
					},
				},
				{
					status: 400,
					body:
					{
						error: "level must be day, week, month or year",
					},
				},
			]);
		});
	});

	/** A query that reads calendar_metadata without naming node ids: a scan by root, level or dateId, not a lookup by id. */
	function isCalendarScan(sql: string): boolean
	{
		return (
			sql.includes('from "calendar_metadata"') &&
			!sql.includes('"calendar_metadata"."node_id" IN (SELECT value FROM json_each(')
		);
	}
});

describe("calendar days route", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
	const KEY = "k";
	const D0928 = calendarNodeId(KEY, "day", 20_260_928);

	function time(year: number, month: number, day: number): string
	{
		return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
	}

	/** [id, parent, name, note?]: September 2026 days with and without journal content. */
	const TREE: [string, string | null, string, string?][] = [
		["cal", null, "📆 Calendar"],
		["y2026", "cal", "2026"],
		["m09", "y2026", "09"],
		["d0927", "m09", time(2026, 9, 27)],
		["d0927-empty", "d0927", ""],
		[D0928, "m09", "Mon, Sep 28"],
		["d0928-a", D0928, ""],
		["d0928-b", D0928, ""],
		["d0929", "m09", time(2026, 9, 29)],
		["d0929-a", "d0929", "Lunch with @Alice"],
		["d0930", "m09", time(2026, 9, 30)],
		["d0930-a", "d0930", "", "Notes only"],
		["d0926", "m09", time(2026, 9, 26)],
		["m10", "y2026", "10"],
		["d1001", "m10", time(2026, 10, 1)],
		["d1001-a", "d1001", "October entry"],
	];

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	function app(
		onStatement: (sql: string) => void = () =>
		{
		},
	)
	{
		const sqlite = new DatabaseConstructor(
			":memory:",
			{
				verbose: (sql) =>
				{
					onStatement(String(sql));
				},
			},
		);
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		for (const [id, parentId, name, note] of TREE)
		{
			db.insert(schema.nodeContent)
				.values(
					{
						id,
						name,
						note: note ?? null,
						parentId,
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		const adapter =
		{
			getEntropyKey: async () => Promise.resolve(KEY),
		};
		const ctx =
		{
			db,
			cacheService: new CacheService(db),
			internalAdapter: () => adapter as unknown as WorkflowyInternalAdapter,
		} as unknown as ServerContext;
		const hono = httpAppFor(ctx);
		return async (query: string, path = "days") =>
		{
			const res = await hono.fetch(new Request(`http://x/api/v1/calendar/${path}?${query}`));
			return {
				status: res.status,
				body: (await res.json()) as unknown,
			};
		};
	}

	describe("GET /api/v1/calendar/days", () =>
	{
		it("lists the month's days with two or more children or a first child with a name or note", async () =>
		{
			const get = app();

			await expect(
				Promise.all([get("year=2026&month=9"), get("year=2026&month=10"), get("year=2026&month=11")]),
			).resolves.toStrictEqual([
				{
					status: 200,
					body:
					{
						days: [28, 29, 30],
					},
				},
				{
					status: 200,
					body:
					{
						days: [1],
					},
				},
				{
					status: 200,
					body:
					{
						days: [],
					},
				},
			]);
		});

		it("scans the metadata table a fixed number of times per month, not once or twice per day", async () =>
		{
			const scans: string[] = [];
			const get = app((sql) =>
			{
				scans.push(sql);
			});
			scans.length = 0;

			await expect(get("year=2026&month=10&found=1")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						days: [1],
					},
				},
			);
			// Only root lookups (the settings, the days, the Found Dates' calendar info; a node role with stored metadata needs none); the strict walk reads children by id, not by scanning.
			expect(scans.filter(isCalendarScan)).toHaveLength(5);
		});

		it("rejects a missing or out-of-range year or month", async () =>
		{
			const get = app();

			await expect(
				Promise.all([get("year=2026"), get("year=2026&month=13"), get("year=abc&month=9")]),
			).resolves.toStrictEqual(
				Array.from(
					{
						length: 3,
					},
					() => (
					{
						status: 400,
						body:
						{
							error: "year and month must be a calendar year and a 1-12 month",
						},
					}),
				),
			);
		});
	});

	describe("GET /api/v1/calendar/dots", () =>
	{
		it("lists the dateIds in [from, to] whose day has journal content, across months", async () =>
		{
			const get = app();

			await expect(
				Promise.all([get("from=20260926&to=20261002", "dots"), get("from=20261002&to=20261002", "dots")]),
			).resolves.toStrictEqual([
				{
					status: 200,
					body:
					{
						dateIds: [20_260_928, 20_260_929, 20_260_930, 20_261_001],
					},
				},
				{
					status: 200,
					body:
					{
						dateIds: [],
					},
				},
			]);
		});

		it("scans the metadata table a fixed number of times per month in the range, not per day", async () =>
		{
			const scans: string[] = [];
			const get = app((sql) =>
			{
				scans.push(sql);
			});
			scans.length = 0;

			await expect(get("from=20260901&to=20261031", "dots")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						dateIds: [20_260_928, 20_260_929, 20_260_930, 20_261_001],
					},
				},
			);
			expect(scans.filter(isCalendarScan)).toHaveLength(3);
		});

		it("rejects a missing, invalid, reversed or over-long range", async () =>
		{
			const get = app();

			await expect(
				Promise.all([
					get("from=20260926", "dots"),
					get("from=20260230&to=20260301", "dots"),
					get("from=20261002&to=20260926", "dots"),
					get("from=20260101&to=20270101", "dots"),
				]),
			).resolves.toStrictEqual(
				Array.from(
					{
						length: 4,
					},
					() => (
					{
						status: 400,
						body:
						{
							error: "from and to must be YYYYMMDD days at most 100 days apart, from first",
						},
					}),
				),
			);
		});
	});

	/** A query that reads calendar_metadata without naming node ids: a scan by root, level or dateId, not a lookup by id. */
	function isCalendarScan(sql: string): boolean
	{
		return (
			sql.includes('from "calendar_metadata"') &&
			!sql.includes('"calendar_metadata"."node_id" IN (SELECT value FROM json_each(')
		);
	}
});

describe("calendar found", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function time(year: number, month: number, day: number): string
	{
		return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
	}

	const RANGE =
		'<time startYear="2026" endYear="2026" startMonth="9" endMonth="10" startDay="29" endDay="1">Sep 29 - Oct 1</time>';

	/** A range that neither starts nor ends in 2026 but covers all of it. */
	const SPANNING =
		'<time startYear="2025" endYear="2027" startMonth="12" endMonth="1" startDay="20" endDay="5">Dec 20 - Jan 5</time>';

	/**
	 * [id, parent, name, note?, priority]: the Sep 30 day page and nodes elsewhere that name a date.
	 */
	const TREE: [string, string | null, string, string | null, number][] = [
		["cal", null, "📆 Calendar", null, 0],
		["y2026", "cal", "2026", null, 0],
		["m09", "y2026", "09", null, 0],
		["d0929", "m09", time(2026, 9, 29), null, 0],
		["d0930", "m09", time(2026, 9, 30), null, 1],
		["inside", "d0930", `Lunch ${time(2026, 9, 30)}`, null, 0],
		["beside", "m09", `Standup ${time(2026, 9, 30)}`, null, 2],
		["projects", null, "Projects", null, 1],
		["alpha", "projects", "Alpha", null, 0],
		["due", "alpha", `Ship ${time(2026, 9, 30)}`, null, 1],
		["noted", "alpha", "Review", `Before ${time(2026, 9, 30)}`, 0],
		["trip", "projects", `Trip ${RANGE}`, null, 1],
		["later", "projects", `Later ${time(2026, 10, 5)}`, null, 2],
		["lastyear", "projects", `Old ${time(2025, 9, 30)}`, null, 3],
		["mirror", "projects", "", null, 4],
		["sabbatical", "projects", `Sabbatical ${SPANNING}`, null, 5],
		["top", null, `Top ${time(2026, 9, 30)}`, null, 2],
	];

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	function setup(rootMetadata?: Record<string, unknown>)
	{
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		const cacheService = new CacheService(db);
		for (const [id, parentId, name, note, priority] of TREE)
		{
			cacheService.insertNode(
				{
					id,
					name,
					note,
					parent_id: parentId,
					priority,
					createdAt: 1,
					modifiedAt: 1,
				},
				parentId,
			);
		}
		cacheService.insertMirror("due", "mirror");
		if (rootMetadata !== undefined)
		{
			storeInternalMetadata(
				db,
				new Map([
					[
						"cal",
						{
							calendar: rootMetadata,
						},
					],
				]),
			);
		}
		const ctx =
		{
			db,
			cacheService,
		} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) =>
		{
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const get = async (id: string) =>
		{
			const res = await app.fetch(new Request(`http://x/api/v1/nodes/${id}/found-dates`));
			const body = (await res.json()) as Partial<FoundDatesResponse>;
			return {
				status: res.status,
				items: (body.items ?? []).map(({node, crumbs}) => (
				{
					id: node.id,
					isMirror: node.isMirror,
					originalNodeId: node.originalNodeId,
					crumbs: crumbs.map((crumb) => crumb.id),
				})),
			};
		};
		return Object.assign(
			get,
			{
				/** The raw Found Dates GET body and the outline view POST body for `rootId`. */
				raw: async (rootId: string) =>
				{
					const foundDates: unknown = await (
						await app.fetch(new Request(`http://x/api/v1/nodes/${rootId}/found-dates`))
					).json();
					const view = (await (
						await app.fetch(
							new Request(
								"http://x/api/v1/nodes/view",
								{
									method: "POST",
									headers:
									{
										"Content-Type": "application/json",
									},
									body: JSON.stringify(
										{
											rootId,
											expandedIds: [],
											limit: 50,
											showCompleted: false,
										},
									),
								},
							),
						)
					).json()) as Record<string, unknown>;
					return {
						foundDates,
						view,
					};
				},
			},
		);
	}

	const found = (id: string, crumbs: string[]) => (
	{
		id,
		isMirror: true,
		originalNodeId: id,
		crumbs,
	});

	describe("GET /api/v1/nodes/:id/found-dates", () =>
	{
		it("lists nodes outside the day whose name or note has a <time> covering it, in tree order, as mirrors with crumbs", async () =>
		{
			const get = setup();

			await expect(get("d0930")).resolves.toStrictEqual(
				{
					status: 200,
					items: [
						found("beside", ["cal", "y2026", "m09"]),
						found("noted", ["projects", "alpha"]),
						found("due", ["projects", "alpha"]),
						found("trip", ["projects"]),
						found("sabbatical", ["projects"]),
						found("top", []),
					],
				},
			);
		});

		it("counts a range for every day it covers", async () =>
		{
			const get = setup();

			const {items} = await get("d0929");

			expect(items.map(({id}) => id)).toStrictEqual(["trip", "sabbatical"]);
		});

		it("lists nothing for a node that is not a day", async () =>
		{
			const get = setup();

			await expect(get("alpha")).resolves.toStrictEqual(
				{
					status: 200,
					items: [],
				},
			);
		});

		it("lists nothing when the calendar root turns Found Dates off", async () =>
		{
			const get = setup(
				{
					root: true,
					found_dates: false,
				},
			);

			await expect(get("d0930")).resolves.toStrictEqual(
				{
					status: 200,
					items: [],
				},
			);
		});

		it("answers 404 for an unknown node", async () =>
		{
			const get = setup();

			await expect(get("nope")).resolves.toMatchObject(
				{
					status: 404,
				},
			);
		});
	});

	describe("POST /api/v1/nodes/view Found Dates", () =>
	{
		it("carries a day page's Found Dates, so they swap in with the view", async () =>
		{
			const {foundDates, view} = await setup().raw("d0930");

			expect(view.foundDates).toStrictEqual(foundDates);
		});

		it("carries no Found Dates for a node that is not a day", async () =>
		{
			const {view} = await setup().raw("alpha");

			expect(Object.keys(view)).toStrictEqual(["lists"]);
		});
	});
});

describe("calendar layout route", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function time(year: number, month: number, day: number): string
	{
		return `<time startYear="${year}" startMonth="${month}" startDay="${day}">x</time>`;
	}

	/** [id, parent, name] in sibling order: one month of the calendar plus a dated note outside it. */
	const TREE: [string, string | null, string][] = [
		["cal", null, "📆 Calendar"],
		["y2026", "cal", "2026"],
		["m09", "y2026", "09"],
		["d0910", "m09", time(2026, 9, 10)],
		["entry", "d0910", "Journal entry"],
		["notes", "cal", "Notes"],
		["call", "notes", `Call ${time(2026, 9, 11)}`],
	];

	const METADATA: Record<string, Record<string, unknown>> =
	{
		cal:
		{
			calendar:
			{
				root: true,
				levels:
				{
					year: true,
					month: true,
					day: true,
				},
			},
		},
		y2026:
		{
			calendar:
			{
				level: "year",
				value: "2026",
				timestamp: 1,
				dateId: 20_260_000,
			},
		},
		m09:
		{
			calendar:
			{
				level: "month",
				value: "9",
				timestamp: 1,
				dateId: 20_260_900,
			},
		},
		d0910:
		{
			calendar:
			{
				level: "day",
				value: "10",
				timestamp: 1,
				dateId: 20_260_910,
			},
		},
	};

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	function app({
		names = {},
		extra = [],
		rootTagged = true,
		layoutEnabled,
	}:
	{
		names?: Record<string, string>;
		/** More [id, parent, name] nodes after {@link TREE}, with no internal metadata. */
		extra?: [string, string | null, string][];
		rootTagged?: boolean;
		/** `ctx.calendarLayoutEnabled`; undefined leaves the route's default (on). */
		layoutEnabled?: boolean;
	} = {})
	{
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		for (const [id, parentId, name] of [...TREE, ...extra])
		{
			db.insert(schema.nodeContent)
				.values(
					{
						id,
						name: names[id] ?? name,
						parentId,
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		for (const [nodeId, metadata] of Object.entries(METADATA))
		{
			if (nodeId !== "cal" || rootTagged)
			{
				storeInternalMetadata(db, new Map([[nodeId, metadata]]));
			}
		}
		const calls: string[] = [];
		const fake =
		{
			getEntropyKey: async () => Promise.resolve("k"),
			getRootMeta: async (path: string[]) =>
			{
				calls.push(`getRootMeta ${path.join(".")}`);
				return Promise.resolve(path[0] === "dateFormat" ? "YYYY-MM-DD ddd" : undefined);
			},
			applyCalendarLayout: async (
				levels: unknown,
				{
					rootId,
					loadSnapshot,
					timings,
				}:
				{
					rootId: string;
					loadSnapshot: () => CalendarLayoutSnapshot | undefined;
					timings?: LayoutTimings;
				},
			) =>
			{
				const snapshot = loadSnapshot();
				calls.push(
					`applyCalendarLayout ${JSON.stringify(levels)} ${rootId} ${snapshot?.root.id ?? "no snapshot"}`,
				);
				if (timings !== undefined)
				{
					timings.plan = 1.25;
					timings.push = 20;
				}
				return Promise.resolve(
					{
						rootId: snapshot?.root.id ?? "?",
						writes: 3,
					},
				);
			},
			undoCalendarLayout: async (rootId: string) =>
			{
				calls.push(`undoCalendarLayout ${rootId}`);
				return Promise.resolve(
					undoes++ === 0
						?
							{
								rootId: "cal",
								writes: 3,
							}
						: undefined,
				);
			},
		};
		let undoes = 0;
		const ctx =
		{
			db,
			cacheService: new CacheService(db),
			apiKey: "key",
			calendarLayoutEnabled: layoutEnabled,
			internalAdapter: () => fake as unknown as WorkflowyInternalAdapter,
		} as unknown as ServerContext;
		const hono = httpAppFor(ctx);
		const request = async (path: string, init?: RequestInit) =>
		{
			const res = await hono.fetch(new Request(`http://x/api/v1/calendar/${path}`, init));
			return {
				status: res.status,
				body: (await res.json()) as unknown,
			};
		};
		const preview = async (body: unknown) =>
			request(
				"layout/preview",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
		const send = async (method: string, path: string, body?: unknown) =>
			request(
				path,
				{
					method,
					headers:
					{
						"content-type": "application/json",
					},
					...(body === undefined
						? {}
						:
							{
								body: JSON.stringify(body),
							}),
				},
			);
		return {
			request,
			preview,
			send,
			calls,
			hono,
		};
	}

	describe("GET /api/v1/calendar/layout", () =>
	{
		it("returns the root's levels, the levels with custom text, and whether Update Layout must confirm", async () =>
		{
			const {request} = app();
			await expect(request("layout")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						levels:
						{
							year: true,
							month: true,
							day: true,
						},
						customLevels: [],
						needsConfirm: true,
						applyEnabled: true,
					},
				},
			);
		});

		it("flags a month renamed away from the date format's name", async () =>
		{
			const {request} = app(
				{
					names:
					{
						m09: "September plans",
					},
				},
			);
			await expect(request("layout")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						levels:
						{
							year: true,
							month: true,
							day: true,
						},
						customLevels: ["month"],
						needsConfirm: true,
						applyEnabled: true,
					},
				},
			);
		});

		it("is 409 when the calendar root's internal metadata is not cached", async () =>
		{
			const {request} = app(
				{
					rootTagged: false,
				},
			);
			await expect(request("layout")).resolves.toStrictEqual(
				{
					status: 409,
					body:
					{
						error: "The 📆 Calendar root's internal metadata is not cached",
					},
				},
			);
		});
	});

	describe("POST /api/v1/calendar/layout/preview", () =>
	{
		it("plans the restructure without writing anything", async () =>
		{
			const {preview, calls} = app();
			await expect(
				preview(
					{
						levels:
						{
							year: true,
							month: false,
							week: false,
						},
					},
				),
			).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						steps: [
							{
								op: "set-calendar",
								id: "call",
								calendar:
								{
									level: "day",
									value: "11",
									timestamp: new Date(2026, 8, 11).getTime(),
									dateId: 20_260_911,
								},
							},
							{
								op: "set-levels",
								id: "cal",
								levels:
								{
									year: true,
									day: true,
								},
							},
							{
								op: "move",
								id: "d0910",
								parentId: "y2026",
								index: 0,
								from:
								{
									parentId: "m09",
									index: 0,
								},
							},
							{
								op: "move",
								id: "call",
								parentId: "y2026",
								index: 1,
								from:
								{
									parentId: "notes",
									index: 0,
								},
							},
							{
								op: "delete",
								id: "m09",
								from:
								{
									parentId: "y2026",
									index: 2,
								},
							},
						],
					},
				},
			);
			expect(calls).toStrictEqual(["getRootMeta weekStartDay", "getRootMeta dateFormat"]);
		});

		it("plans under an explicit root with random ids for new level nodes, not the account's deterministic ones", async () =>
		{
			const {preview} = app();
			const {status, body} = await preview(
				{
					levels:
					{
						year: true,
						month: true,
					},
					rootId: "notes",
				},
			);
			const steps = z
				.object(
					{
						steps: z.array(
							z
								.object(
									{
										op: z.string(),
										id: z.string(),
									},
								)
								.loose(),
						),
					},
				)
				.parse(body).steps;
			const created = steps.filter((step) => step.op === "create").map((step) => step.id);
			expect(
				{
					status,
					ops: steps.map((step) => `${step.op} ${step.op === "create" ? "" : step.id}`),
					deterministic: created.filter(
						(id) =>
							id === calendarNodeId("k", "year", 20_260_000) ||
							id === calendarNodeId("k", "month", 20_260_900),
					),
				},
			).toStrictEqual(
				{
					status: 200,
					ops: ["set-calendar call", "set-levels notes", "create ", "create ", "move call"],
					deterministic: [],
				},
			);
		});

		it("leaves a day-named node without calendar metadata where it is, as applying does", async () =>
		{
			// Applying reads metadata from the internal API, where a day-named node inside a month is no day unless tagged.
			const {preview} = app(
				{
					extra: [["sept8", "m09", time(2026, 9, 8)]],
				},
			);
			await expect(
				preview(
					{
						levels:
						{
							year: true,
							month: true,
							day: true,
						},
					},
				),
			).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						steps: [
							{
								op: "set-calendar",
								id: "call",
								calendar:
								{
									level: "day",
									value: "11",
									timestamp: new Date(2026, 8, 11).getTime(),
									dateId: 20_260_911,
								},
							},
							{
								op: "set-levels",
								id: "cal",
								levels:
								{
									year: true,
									month: true,
									day: true,
								},
							},
							{
								op: "move",
								id: "call",
								parentId: "m09",
								index: 1,
								from:
								{
									parentId: "notes",
									index: 0,
								},
							},
						],
					},
				},
			);
		});

		it("plans week levels and is 400 for a malformed body", async () =>
		{
			const {preview} = app();
			const week = await preview(
				{
					levels:
					{
						year: true,
						week: true,
					},
				},
			);
			const steps = (
				week.body as
				{
					steps:
					{
						op: string;
					}[];
				}
			).steps;
			expect(
				{
					week: [week.status, steps.find((step) => step.op === "set-levels")],
					malformed: await preview(
						{
							levels: "year",
						},
					),
				},
			).toStrictEqual(
				{
					week: [
						200,
						{
							op: "set-levels",
							id: "cal",
							levels:
							{
								year: true,
								week: true,
								day: true,
							},
						},
					],
					malformed:
					{
						status: 400,
						body:
						{
							error: "levels must be an object of year, month, week and day booleans",
						},
					},
				},
			);
		});
	});

	describe("PUT /api/v1/calendar/layout and POST /api/v1/calendar/layout/undo", () =>
	{
		it("are 403 when CALENDAR_LAYOUT_ENABLED=false turns applying off, and write nothing", async () =>
		{
			const {request, send, calls} = app(
				{
					layoutEnabled: false,
				},
			);
			const disabled =
			{
				status: 403,
				body:
				{
					error: "Applying calendar layouts is disabled (CALENDAR_LAYOUT_ENABLED)",
				},
			};
			expect(
				{
					applyEnabled: (
						(await request("layout")).body as
						{
							applyEnabled: boolean;
						}
					).applyEnabled,
					put: await send(
						"PUT",
						"layout",
						{
							levels:
							{
								year: true,
							},
						},
					),
					undo: await send("POST", "layout/undo"),
					calls,
				},
			).toStrictEqual(
				{
					applyEnabled: false,
					put: disabled,
					undo: disabled,
					calls: ["getRootMeta dateFormat"],
				},
			);
		});

		it("applies the levels by default (to an explicit root when given), reports enabled, and undoes once", async () =>
		{
			const {request, send, calls} = app(
				{
					extra: [["sandbox-cal", null, "📆 Calendar copy"]],
				},
			);
			expect(
				{
					layout: await request("layout"),
					tagged: await send(
						"PUT",
						"layout",
						{
							levels:
							{
								year: true,
								month: false,
							},
						},
					),
					sandbox: await send(
						"PUT",
						"layout",
						{
							levels:
							{
								year: true,
							},
							rootId: "sandbox-cal",
						},
					),
					week: await send(
						"PUT",
						"layout",
						{
							levels:
							{
								week: true,
							},
						},
					),
					bad: await send(
						"PUT",
						"layout",
						{
							levels:
							{
								year: true,
							},
							rootId: 7,
						},
					),
					undo: await send("POST", "layout/undo"),
					nothing: await send("POST", "layout/undo"),
					calls,
				},
			).toStrictEqual(
				{
					layout:
					{
						status: 200,
						body:
						{
							levels:
							{
								year: true,
								month: true,
								day: true,
							},
							customLevels: [],
							needsConfirm: true,
							applyEnabled: true,
						},
					},
					tagged:
					{
						status: 200,
						body:
						{
							rootId: "cal",
							writes: 3,
						},
					},
					sandbox:
					{
						status: 200,
						body:
						{
							rootId: "sandbox-cal",
							writes: 3,
						},
					},
					week:
					{
						status: 200,
						body:
						{
							rootId: "cal",
							writes: 3,
						},
					},
					bad:
					{
						status: 400,
						body:
						{
							error: "levels must be an object of year, month, week and day booleans",
						},
					},
					undo:
					{
						status: 200,
						body:
						{
							rootId: "cal",
							writes: 3,
						},
					},
					nothing:
					{
						status: 409,
						body:
						{
							error: "There is no calendar layout to undo",
						},
					},
					calls: [
						"getRootMeta dateFormat",
						'applyCalendarLayout {"year":true,"month":false} cal cal',
						'applyCalendarLayout {"year":true} sandbox-cal sandbox-cal',
						'applyCalendarLayout {"week":true} cal cal',
						"undoCalendarLayout cal",
						"undoCalendarLayout cal",
					],
				},
			);
		});

		it("reports the apply's phase timings in a Server-Timing header", async () =>
		{
			const {hono} = app();
			const res = await hono.fetch(
				new Request(
					"http://x/api/v1/calendar/layout",
					{
						method: "PUT",
						headers:
						{
							"content-type": "application/json",
						},
						body: JSON.stringify(
							{
								levels:
								{
									year: true,
								},
							},
						),
					},
				),
			);
			expect(
				{
					status: res.status,
					timing: res.headers.get("server-timing"),
				},
			).toStrictEqual(
				{
					status: 200,
					timing: "plan;dur=1.3, push;dur=20.0",
				},
			);
		});
		it("rejects a rootId it cannot resolve to a cached node, or no tagged root, without calling the adapter", async () =>
		{
			const untagged = app(
				{
					rootTagged: false,
				},
			);
			const {send, calls} = app();
			const missing =
			{
				status: 409,
				body:
				{
					error: "No calendar root is cached for this layout",
				},
			};
			expect(
				{
					unknown: await send(
						"PUT",
						"layout",
						{
							levels:
							{
								year: true,
							},
							rootId: "nope",
						},
					),
					untagged: await untagged.send(
						"PUT",
						"layout",
						{
							levels:
							{
								year: true,
							},
						},
					),
					undoUnknown: await send(
						"POST",
						"layout/undo",
						{
							rootId: "nope",
						},
					),
					undoUntagged: await untagged.send("POST", "layout/undo"),
					calls: [...calls, ...untagged.calls],
				},
			).toStrictEqual(
				{
					unknown: missing,
					untagged: missing,
					undoUnknown: missing,
					undoUntagged: missing,
					calls: [],
				},
			);
		});

		it("passes an explicit rootId to undo and logs the resolved root of each write", async () =>
		{
			const {send, calls} = app(
				{
					extra: [["sandbox-cal", null, "📆 Calendar copy"]],
				},
			);
			const logged: unknown[] = [];
			const info = vi.spyOn(console, "info").mockImplementation((message: unknown) =>
			{
				logged.push(message);
			});
			try
			{
				await send(
					"PUT",
					"layout",
					{
						levels:
						{
							year: true,
						},
						rootId: "sandbox-cal",
					},
				);
				await send(
					"POST",
					"layout/undo",
					{
						rootId: "sandbox-cal",
					},
				);
			}
			finally
			{
				info.mockRestore();
			}
			expect(
				{
					calls,
					logged,
				},
			).toStrictEqual(
				{
					calls: [
						'applyCalendarLayout {"year":true} sandbox-cal sandbox-cal',
						"undoCalendarLayout sandbox-cal",
					],
					logged: [
						"calendar layout: applying under root sandbox-cal",
						"calendar layout: 3 writes under root sandbox-cal (plan;dur=1.3, push;dur=20.0)",
						"calendar layout: undoing under root sandbox-cal",
					],
				},
			);
		});
	});
});

describe("calendar layout view", () =>
{
	function render(layout: CalendarLayout): string
	{
		return renderToStaticMarkup(
			createElement(
				CalendarLayoutView,
				{
					layout,
					onCancel: () =>
					{
					},
					onUpdate: () =>
					{
					},
				},
			),
		);
	}

	/** Each checkbox's label and whether it shows checked. */
	function checkboxes(html: string): [string, boolean][]
	{
		return [
			...html.matchAll(
				/<div class="flex gap-m"><span class="inline-flex relative w-l h-l"><svg[^>]*data-prefix="(fad|fal)"[^>]*>.*?<\/svg><input type="checkbox" class="sr-only peer" name="calendar-layout-[a-z]+"( checked="")?\/><\/span>([^<]*)<\/div>/gu,
			),
		].map((m) => [m[3], m[1] === "fad" && Boolean(m[2])]);
	}

	describe("CalendarLayoutView (upstream P10)", () =>
	{
		it("renders the header, the two notes, a checkbox per level above day, and Cancel / Update Layout", () =>
		{
			const html = render(
				{
					levels:
					{
						year: true,
						month: true,
						day: true,
					},
					customLevels: [],
					needsConfirm: false,
					applyEnabled: true,
				},
			);
			expect(
				{
					shell: html.startsWith(
						'<div class="flex flex-col gap-xs p-ml text-primary desktop:w-[220px]" data-calendar-layout="true">',
					),
					title: /<header class="flex justify-between gap-l items-center"><h1 class="font-medium">([^<]*)<\/h1>/u.exec(
						html,
					)?.[1],
					dateFormatIcon: html.includes('data-icon="calendar-lines-pen"'),
					notes: [
						...html.matchAll(/<p class="text-tertiary text-s leading-xs (mb-xs|mb-m)">([^<]*)<\/p>/gu),
					].map((m) => [m[1], m[2]]),
					checkboxes: checkboxes(html),
					warning: html.includes("border-warning"),
					buttons: [
						...html.matchAll(
							/<button tabindex="0" class="([^"]*)"><span class="">([^<]*)<\/span><\/button>/gu,
						),
					].map((m) => [m[1], m[2]]),
				},
			).toStrictEqual(
				{
					shell: true,
					title: "Calendar Layout",
					dateFormatIcon: true,
					notes: [
						["mb-xs", "Choose which calendar levels are shown."],
						["mb-m", "Note: Bullets with date tags will be automatically organized."],
					],
					checkboxes: [
						["Year", true],
						["Month", true],
						["Week", false],
					],
					warning: false,
					buttons: [
						[" hover:no-underline button secondary", "Cancel"],
						[" hover:no-underline button primary", "Update Layout"],
					],
				},
			);
		});

		it("warns that the custom text of an unchecked level will be deleted", () =>
		{
			const html = render(
				{
					levels:
					{
						year: true,
						day: true,
					},
					customLevels: ["year", "month"],
					needsConfirm: false,
					applyEnabled: true,
				},
			);
			expect(
				/<span class="mt-s flex gap-m text-s px-m py-s border-2 border-solid border-warning rounded-s leading-s"><svg[^>]*data-icon="triangle-exclamation"[^>]*>.*?<\/svg><p>(.*?)<\/p><\/span>/u.exec(
					html,
				)?.[1],
			).toBe(
				"Some <strong>Month</strong> nodes include custom text or notes that will be deleted if turned off.",
			);
		});

		it("lists the custom levels that are turned off, in level order", () =>
		{
			expect([
				layoutWarningLevels(
					["year", "month"],
					{
						year: false,
						month: false,
					},
				),
				layoutWarningLevels(
					["month"],
					{
						year: false,
						month: true,
					},
				),
			]).toStrictEqual([["year", "month"], []]);
		});

		it("summarizes a preview's steps for the not-yet-enabled Update Layout", () =>
		{
			expect([
				layoutPreviewMessage([
					{
						op: "set-calendar",
					},
					{
						op: "set-levels",
					},
					{
						op: "create",
					},
					{
						op: "move",
					},
					{
						op: "move",
					},
					{
						op: "delete",
					},
				]),
				layoutPreviewMessage([
					{
						op: "set-levels",
					},
				]),
			]).toStrictEqual([
				"Calendar Layout would move 2 nodes, create 1, delete 1 and retag 1. Applying layouts is not enabled yet.",
				"Calendar Layout would move 0 nodes, create 0, delete 0 and retag 0. Applying layouts is not enabled yet.",
			]);
		});

		it("reports an applied layout, or that it was already in place", () =>
		{
			expect([layoutAppliedMessage(5), layoutAppliedMessage(1), layoutAppliedMessage(0)]).toStrictEqual([
				"Calendar layout updated (5 changes).",
				"Calendar layout updated (1 change).",
				"Calendar layout already up to date.",
			]);
		});
	});
});

describe("calendar picker selection", () =>
{
	describe("stripPickerSelection", () =>
	{
		const page = new Date(2026, 9, 21);

		it("keeps the page day for an empty or blank term", () =>
		{
			expect([stripPickerSelection("", page, []), stripPickerSelection("  ", page, [])]).toStrictEqual([
				[page],
				[page],
			]);
		});

		it("previews the parsed date, and clears the selection for an unparseable term", () =>
		{
			expect([
				stripPickerSelection("oct 19", page, [new Date(2027, 9, 19)]),
				stripPickerSelection("zzzz", page, []),
			]).toStrictEqual([[new Date(2027, 9, 19)], []]);
		});
	});
});

describe("calendar route", () =>
{
	const NOT_CONFIGURED =
		"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";
	const ENSURED =
	{
		dayId: "day",
		firstChildId: "child",
		created: ["month", "day", "child"],
	};

	function setup(
		options:
		{
			configured?: boolean;
			enabled?: boolean;
			ensure?: WorkflowyInternalAdapter["ensureCalendarDay"];
		} = {},
	)
	{
		const configured = options.configured ?? true;
		const adapter =
		{
			ensureCalendarDay: vi.fn<WorkflowyInternalAdapter["ensureCalendarDay"]>(
				options.ensure ?? (async () => Promise.resolve(ENSURED)),
			),
		};
		const ctx =
		{
			apiKey: configured ? "key" : undefined,
			calendarEnsureEnabled: options.enabled ?? true,
			internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
		} as unknown as ServerContext;
		const app = httpAppFor(ctx);
		const ensure = async (dateId: string, query = "") =>
		{
			const res = await app.fetch(
				new Request(
					`http://x/api/v1/calendar/day/${dateId}/ensure${query}`,
					{
						method: "POST",
					},
				),
			);
			return {
				status: res.status,
				body: (await res.json()) as unknown,
			};
		};
		return {
			adapter,
			ensure,
		};
	}

	describe("POST /api/v1/calendar/day/:dateId/ensure", () =>
	{
		it("ensures the day through the adapter and returns its ids", async () =>
		{
			const {adapter, ensure} = setup();

			const response = await ensure("20261017");

			expect(
				{
					response,
					calls: adapter.ensureCalendarDay.mock.calls,
				},
			).toStrictEqual(
				{
					response:
					{
						status: 200,
						body: ENSURED,
					},
					calls: [
						[
							20_261_017,
							{
								stopAt: "day",
								createChild: true,
							},
						],
					],
				},
			);
		});

		it("passes ?level= as the level to stop at and ?createChild=false through", async () =>
		{
			const {adapter, ensure} = setup();

			const responses = [
				await ensure("20261001", "?level=month&createChild=false"),
				await ensure("20261001", "?level=year"),
				await ensure("20261001", "?level=week"),
				await ensure("20261001", "?level=hour"),
			];

			expect(
				{
					statuses: responses.map(({status}) => status),
					calls: adapter.ensureCalendarDay.mock.calls,
				},
			).toStrictEqual(
				{
					statuses: [200, 200, 200, 400],
					calls: [
						[
							20_261_001,
							{
								stopAt: "month",
								createChild: false,
							},
						],
						[
							20_261_001,
							{
								stopAt: "year",
								createChild: true,
							},
						],
						[
							20_261_001,
							{
								stopAt: "week",
								createChild: true,
							},
						],
					],
				},
			);
		});

		it("rejects a dateId that is not a real YYYYMMDD day", async () =>
		{
			const {adapter, ensure} = setup();

			const responses = [await ensure("20260230"), await ensure("2026-10-17"), await ensure("202610170")];

			expect(
				{
					responses,
					calls: adapter.ensureCalendarDay.mock.calls,
				},
			).toStrictEqual(
				{
					responses: Array.from(
						{
							length: 3,
						},
						() => (
						{
							status: 400,
							body:
							{
								error: "dateId must be a YYYYMMDD calendar day",
							},
						}),
					),
					calls: [],
				},
			);
		});

		it("answers 409 when no calendar root is cached", async () =>
		{
			const {ensure} = setup(
				{
					ensure: async () => Promise.reject(new CalendarRootMissing()),
				},
			);

			await expect(ensure("20261017")).resolves.toStrictEqual(
				{
					status: 409,
					body:
					{
						error: new CalendarRootMissing().message,
					},
				},
			);
		});

		it("answers 403 without calling the adapter while ensure is disabled", async () =>
		{
			const {adapter, ensure} = setup(
				{
					enabled: false,
				},
			);

			const response = await ensure("20261017");

			expect(
				{
					response,
					calls: adapter.ensureCalendarDay.mock.calls,
				},
			).toStrictEqual(
				{
					response:
					{
						status: 403,
						body:
						{
							error: "Calendar day ensure is disabled (CALENDAR_ENSURE_ENABLED=false)",
						},
					},
					calls: [],
				},
			);
		});

		it("answers 503 without the internal API", async () =>
		{
			const {ensure} = setup(
				{
					configured: false,
				},
			);

			await expect(ensure("20261017")).resolves.toStrictEqual(
				{
					status: 503,
					body:
					{
						error: NOT_CONFIGURED,
					},
				},
			);
		});
	});
});

describe("calendar settings route", () =>
{
	interface MetadataChange
	{
		path: string[];
		value: unknown;
	}

	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function time(year: number, month: number, day: number, end?: [number, number, number]): string
	{
		const endAttrs = end === undefined ? "" : ` endYear="${end[0]}" endMonth="${end[1]}" endDay="${end[2]}"`;
		return `<time startYear="${year}" startMonth="${month}" startDay="${day}"${endAttrs}>x</time>`;
	}

	/** [id, parent, name, note?]: September 2026 day nodes plus dated items elsewhere. */
	const TREE: [string, string | null, string, string?][] = [
		["cal", null, "📆 Calendar"],
		["y2026", "cal", "2026"],
		["m09", "y2026", "09"],
		["d0910", "m09", time(2026, 9, 10)],
		["d0910-a", "d0910", "Journal entry"],
		["d0911", "m09", time(2026, 9, 11)],
		["d0911-empty", "d0911", ""],
		["d0912", "m09", time(2026, 9, 12)],
		["d0913", "m09", time(2026, 9, 13)],
		["d0914", "m09", time(2026, 9, 14)],
		["work", null, "Work"],
		["task", "work", `Ship it ${time(2026, 9, 11)}`],
		["trip", "work", "Trip", time(2026, 9, 12, [2026, 9, 13])],
		["other-month", "work", `Later ${time(2026, 10, 14)}`],
		["undated-day", "work", `No node that day ${time(2026, 9, 20)}`],
	];

	const ROOT_METADATA =
	{
		calendar:
		{
			root: true,
			levels:
			{
				day: true,
				month: true,
				year: true,
			},
			found_dates: true,
		},
	};

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	interface SetupOptions
	{
		rootMetadata?: Record<string, unknown> | null;
		adapter?: boolean;
	}

	function app({rootMetadata = ROOT_METADATA, adapter = true}: SetupOptions = {})
	{
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		for (const [id, parentId, name, note] of TREE)
		{
			db.insert(schema.nodeContent)
				.values(
					{
						id,
						name,
						note: note ?? null,
						parentId,
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		const tag = (id: string, level: string, value: string, dateId: number) =>
		{
			storeInternalMetadata(
				db,
				new Map([
					[
						id,
						{
							calendar:
							{
								level,
								value,
								timestamp: 0,
								dateId,
							},
						},
					],
				]),
			);
		};
		tag("y2026", "year", "2026", 20_260_000);
		tag("m09", "month", "9", 20_260_900);
		for (const day of [10, 11, 12, 13, 14])
		{
			tag(`d09${day}`, "day", String(day), 20_260_900 + day);
		}
		const writeRoot = (metadata: Record<string, unknown>) =>
		{
			storeInternalMetadata(db, new Map([["cal", metadata]]));
		};
		if (rootMetadata !== null)
		{
			writeRoot(rootMetadata);
		}
		const writes:
		{
			id: string;
			changes: MetadataChange[];
		}[] = [];
		const fake =
		{
			getEntropyKey: async () => Promise.resolve("k"),
			setNodeMetaValues: async (id: string, changes: MetadataChange[]) =>
			{
				writes.push(
					{
						id,
						changes,
					},
				);
				const calendar =
				{
					...(rootMetadata?.calendar as Record<string, unknown>),
				};
				for (const {path, value} of changes)
				{
					calendar[path[1] ?? ""] = value;
				}
				rootMetadata =
				{
					...rootMetadata,
					calendar,
				};
				writeRoot(rootMetadata);
				return Promise.resolve();
			},
		};
		const ctx =
		{
			db,
			cacheService: new CacheService(db),
			apiKey: "key",
			internalAdapter: () => (adapter ? (fake as unknown as WorkflowyInternalAdapter) : undefined),
		} as unknown as ServerContext;
		const hono = httpAppFor(ctx);
		const request = async (path: string, init?: RequestInit) =>
		{
			const res = await hono.fetch(new Request(`http://x/api/v1/calendar/${path}`, init));
			return {
				status: res.status,
				body: (await res.json()) as unknown,
			};
		};
		const put = async (body: unknown) =>
			request(
				"settings",
				{
					method: "PUT",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
		return {
			request,
			put,
			writes,
		};
	}

	describe("GET /api/v1/calendar/settings", () =>
	{
		it("reads the root's found_dates and day_prefix, defaulting each to true", async () =>
		{
			const unset = app();
			const off = app(
				{
					rootMetadata:
					{
						calendar:
						{
							root: true,
							found_dates: false,
							day_prefix: false,
						},
					},
				},
			);
			const none = app(
				{
					rootMetadata: null,
				},
			);

			await expect(
				Promise.all([unset.request("settings"), off.request("settings"), none.request("settings")]),
			).resolves.toStrictEqual([
				{
					status: 200,
					body:
					{
						foundDates: true,
						dayPrefix: true,
					},
				},
				{
					status: 200,
					body:
					{
						foundDates: false,
						dayPrefix: false,
					},
				},
				{
					status: 200,
					body:
					{
						foundDates: true,
						dayPrefix: true,
					},
				},
			]);
		});
	});

	describe("PUT /api/v1/calendar/settings", () =>
	{
		it("writes each given setting to the root's calendar metadata in one edit and returns the new settings", async () =>
		{
			const {put, writes} = app();

			const result = await put(
				{
					dayPrefix: false,
					foundDates: false,
				},
			);

			expect(
				{
					result,
					writes,
				},
			).toStrictEqual(
				{
					result:
					{
						status: 200,
						body:
						{
							foundDates: false,
							dayPrefix: false,
						},
					},
					writes: [
						{
							id: "cal",
							changes: [
								{
									path: ["calendar", "found_dates"],
									value: false,
								},
								{
									path: ["calendar", "day_prefix"],
									value: false,
								},
							],
						},
					],
				},
			);
		});

		it("rejects a body without a boolean setting", async () =>
		{
			const {put, writes} = app();

			const results = await Promise.all([
				put({}),
				put(
					{
						dayPrefix: "no",
					},
				),
				put(
					{
						foundDates: 1,
					},
				),
			]);

			expect(
				{
					results,
					writes,
				},
			).toStrictEqual(
				{
					results: Array.from(
						{
							length: 3,
						},
						() => (
						{
							status: 400,
							body:
							{
								error: "foundDates and dayPrefix must be booleans, and at least one is required",
							},
						}),
					),
					writes: [],
				},
			);
		});

		it("refuses to write when the root has no cached internal calendar metadata, which the patch would clobber", async () =>
		{
			const {put, writes} = app(
				{
					rootMetadata: null,
				},
			);

			const result = await put(
				{
					dayPrefix: false,
				},
			);

			expect(
				{
					result,
					writes,
				},
			).toStrictEqual(
				{
					result:
					{
						status: 409,
						body:
						{
							error: "The 📆 Calendar root's internal metadata is not cached",
						},
					},
					writes: [],
				},
			);
		});

		it("needs the internal API", async () =>
		{
			const {put} = app(
				{
					adapter: false,
				},
			);

			await expect(
				put(
					{
						dayPrefix: false,
					},
				),
			).resolves.toStrictEqual(
				{
					status: 503,
					body:
					{
						error: expect.any(String) as unknown,
					},
				},
			);
		});
	});

	describe("GET /api/v1/calendar/days?found=1", () =>
	{
		it("adds existing days covered by a dated item elsewhere, ranges included", async () =>
		{
			const {request} = app();

			await expect(
				Promise.all([request("days?year=2026&month=9"), request("days?year=2026&month=9&found=1")]),
			).resolves.toStrictEqual([
				{
					status: 200,
					body:
					{
						days: [10],
					},
				},
				{
					status: 200,
					body:
					{
						days: [10, 11, 12, 13],
					},
				},
			]);
		});

		it("drops found-only days when the root turns Found Dates off", async () =>
		{
			const {request} = app(
				{
					rootMetadata:
					{
						calendar:
						{
							root: true,
							found_dates: false,
						},
					},
				},
			);

			await expect(request("days?year=2026&month=9&found=1")).resolves.toStrictEqual(
				{
					status: 200,
					body:
					{
						days: [10],
					},
				},
			);
		});
	});
});

describe("calendar strip", () =>
{
	const NOW = new Date(2026, 9, 2, 10, 0);
	const SEPARATOR = '<div class="h-[22px] border-l border-solid border-secondary"></div>';

	function render(props: Partial<CalendarStripViewProps> = {}): string
	{
		return renderToStaticMarkup(
			createElement(
				CalendarStripView,
				{
					level: "day",
					date: new Date(2026, 8, 30),
					now: NOW,
					weekStartDay: 0,
					dots: new Set<number>(),
					onNavigate: () =>
					{
					},
					...props,
				},
			),
		);
	}

	/** Each `[data-ts]` cell: its timestamp, label text, card class tokens and card text. */
	function cells(html: string)
	{
		return [
			...html.matchAll(
				/<div data-ts="(\d+)" class="[^"]*"><div class="h-\[18px\] flex items-start justify-center">(?:<span class="text-2xs uppercase">([^<]*)<\/span>)?<\/div><div class="([^"]*)"(?: data-strip-drop="\w+")?>(.*?)<\/div><\/div>(?=<div data-ts|<div class="flex-shrink-0"|<div><div|<\/div><\/div><\/div>$)/gu,
			),
		].map((m) => (
		{
			ts: Number(m[1]),
			label: m.at(2) ?? null,
			card: m[3].split(/\s+/u).filter(Boolean),
			text: m[4].replaceAll(/<[^>]*>/gu, ""),
			dot: /opacity-1/u.test(m[4]),
		}));
	}

	describe("CalendarStripView", () =>
	{
		it("renders upstream's day page strip: 31 day cells from the zoomed date, a separator, then 12 month cells", () =>
		{
			const html = render(
				{
					dots: new Set([20_260_930, 20_261_005]),
				},
			);
			const all = cells(html);
			const days = all.slice(0, 31);
			const months = all.slice(31);

			expect(
				{
					outer: html.startsWith(
						'<div class="flex items-center pb-l"><div class="desktop:-ml-[1px] mobile:-ml-[7px] mr-s">',
					),
					count: all.length,
					first: days[0],
					second:
					{
						label: days[1]?.label,
						text: days[1]?.text,
					},
					today: days[2]?.card,
					dotted: days.filter((day) => day.dot).map((day) => day.text),
					lastDay: days[30]?.text,
					separator: html.includes(SEPARATOR),
					months: months.map((month) => [month.label, month.text]),
					monthCard: months[0]?.card,
					icons: [...html.matchAll(/data-icon="([^"]*)"/gu)].map((m) => m[1]).slice(0, 3),
				},
			).toStrictEqual(
				{
					outer: true,
					count: 43,
					first:
					{
						ts: new Date(2026, 8, 30).getTime(),
						label: "Sep",
						card: [
							"!bg-secondary",
							"hover:!bg-tertiary",
							"w-[28px]",
							"mobile:w-[32px]",
							"h-[38px]",
							"mobile:h-[44px]",
							"py-2xs",
							"box-border",
							"rounded-s",
							"flex",
							"flex-col",
							"justify-center",
							"items-center",
							"cursor-pointer",
							"transition-transform",
						],
						text: "We30",
						dot: true,
					},
					second:
					{
						label: "Oct",
						text: "Th1",
					},
					today: [
						"bg-tertiary",
						"hover:bg-quaternary",
						"w-[28px]",
						"mobile:w-[32px]",
						"h-[38px]",
						"mobile:h-[44px]",
						"py-2xs",
						"box-border",
						"rounded-s",
						"flex",
						"flex-col",
						"justify-center",
						"items-center",
						"cursor-pointer",
						"transition-transform",
					],
					dotted: ["We30", "Mo5"],
					lastDay: "Fr30",
					separator: true,
					months: [
						["2026", "Oct"],
						[null, "Nov"],
						[null, "Dec"],
						["2027", "Jan"],
						[null, "Feb"],
						[null, "Mar"],
						[null, "Apr"],
						[null, "May"],
						[null, "Jun"],
						[null, "Jul"],
						[null, "Aug"],
						[null, "Sep"],
					],
					monthCard: [
						"bg-primary",
						"hover:bg-secondary",
						"box-border",
						"rounded-s",
						"px-s",
						"min-w-[28px]",
						"mobile:min-w-[32px]",
						"h-[38px]",
						"mobile:h-[44px]",
						"flex",
						"justify-center",
						"items-center",
						"cursor-pointer",
						"transition-transform",
					],
					icons: ["chevron-left", "calendar-days", "chevron-right"],
				},
			);
		});

		it("prepends a Today card and its separator when the strip starts after today", () =>
		{
			const html = render(
				{
					date: new Date(2026, 9, 10),
					todayDot: true,
				},
			);
			const [today, first] = cells(html);

			expect(
				{
					today,
					first: first.ts,
					separatorAfterToday: html.includes(
						`</div></div></div><div class="flex-shrink-0"><div class="h-[18px] flex items-center"></div><div class="h-[38px] mobile:h-[44px] flex justify-center items-center">${SEPARATOR}`,
					),
				},
			).toStrictEqual(
				{
					today:
					{
						ts: new Date(2026, 9, 2).getTime(),
						label: "Today",
						card: [
							"bg-tertiary",
							"hover:bg-quaternary",
							"w-[28px]",
							"mobile:w-[32px]",
							"h-[38px]",
							"mobile:h-[44px]",
							"py-2xs",
							"box-border",
							"rounded-s",
							"flex",
							"flex-col",
							"justify-center",
							"items-center",
							"cursor-pointer",
							"transition-transform",
						],
						text: "Fr2",
						dot: true,
					},
					first: new Date(2026, 9, 10).getTime(),
					separatorAfterToday: true,
				},
			);
		});

		it("shows only the year's twelve months, without a separator, on a year page", () =>
		{
			const html = render(
				{
					level: "year",
					date: new Date(2026, 0, 1),
				},
			);

			expect(
				{
					months: cells(html).map((cell) => [cell.label, cell.text]),
					separator: html.includes(SEPARATOR),
				},
			).toStrictEqual(
				{
					months: [
						["2026", "Jan"],
						[null, "Feb"],
						[null, "Mar"],
						[null, "Apr"],
						[null, "May"],
						[null, "Jun"],
						[null, "Jul"],
						[null, "Aug"],
						[null, "Sep"],
						[null, "Oct"],
						[null, "Nov"],
						[null, "Dec"],
					],
					separator: false,
				},
			);
		});
	});

	describe("calendar strip navigation", () =>
	{
		it("gives the arrows upstream's tooltips and the adjacent page at the zoomed level", () =>
		{
			expect([
				stripNav("day", new Date(2026, 8, 30), NOW, 0),
				stripNav("day", new Date(2026, 9, 1), NOW, 0),
				stripNav("month", new Date(2026, 9, 1), NOW, 0),
				stripNav("week", new Date(2026, 9, 11), NOW, 0),
			]).toStrictEqual([
				{
					prev:
					{
						tooltip: "Previous day",
						target:
						{
							date: new Date(2026, 8, 29),
							level: "day",
						},
					},
					next:
					{
						tooltip: "Next day",
						target:
						{
							date: new Date(2026, 9, 1),
							level: "day",
						},
					},
				},
				{
					prev:
					{
						tooltip: "Previous day",
						target:
						{
							date: new Date(2026, 8, 30),
							level: "day",
						},
					},
					next:
					{
						tooltip: "Today",
						target:
						{
							date: new Date(2026, 9, 2),
							level: "day",
						},
					},
				},
				{
					prev:
					{
						tooltip: "Previous month",
						target:
						{
							date: new Date(2026, 8, 1),
							level: "month",
						},
					},
					next:
					{
						tooltip: "Next month",
						target:
						{
							date: new Date(2026, 10, 1),
							level: "month",
						},
					},
				},
				{
					prev:
					{
						tooltip: "Previous week",
						target:
						{
							date: new Date(2026, 9, 4),
							level: "week",
						},
					},
					next:
					{
						tooltip: "Next week",
						target:
						{
							date: new Date(2026, 9, 18),
							level: "week",
						},
					},
				},
			]);
		});

		it("sends a month cell to that month node on month and year pages, else to its first day", () =>
		{
			const nov = new Date(2026, 10, 1);
			expect([
				monthCellTarget("day", nov),
				monthCellTarget("month", nov),
				monthCellTarget("year", nov),
				monthCellTarget("week", nov),
			]).toStrictEqual([
				{
					date: nov,
				},
				{
					date: nov,
					level: "month",
					createChild: false,
				},
				{
					date: nov,
					level: "month",
					createChild: false,
				},
				{
					date: nov,
					level: "month",
					createChild: false,
				},
			]);
		});

		it("reads a page's date from its day, month or year dateId", () =>
		{
			expect([
				calendarPageDate(20_260_930),
				calendarPageDate(20_261_000),
				calendarPageDate(20_260_000),
			]).toStrictEqual([new Date(2026, 8, 30), new Date(2026, 9, 1), new Date(2026, 0, 1)]);
		});

		it("shows a strip on day, week, month and year pages only, starting at the page's first day", () =>
		{
			expect([
				stripPage(
					{
						level: "week",
						dateId: 20_261_011,
					},
				),
				stripPage(
					{
						level: "month",
						dateId: 20_261_000,
					},
				),
				stripPage(
					{
						level: "root",
						dateId: null,
					},
				),
				stripPage(
					{
						level: "day",
						dateId: null,
					},
				),
				stripPage(undefined),
			]).toStrictEqual([
				{
					level: "week",
					date: new Date(2026, 9, 11),
				},
				{
					level: "month",
					date: new Date(2026, 9, 1),
				},
				null,
				null,
				null,
			]);
		});

		it("scrolls by the offset of the cell from the scroller's left edge", () =>
		{
			const cell =
			{
				getBoundingClientRect: () => (
				{
					left: 340,
				}),
			};
			const scroller =
			{
				getBoundingClientRect: () => (
				{
					left: 100,
				}),
				querySelector: (selector: string) => (selector === '[data-ts="5"]' ? cell : null),
			};
			expect([scrollDelta(scroller, 5), scrollDelta(scroller, 6)]).toStrictEqual([240, null]);
		});
	});

	/** A strip scroller at viewport x 100 whose `[data-ts]` cells sit at the given content offsets. */
	function stripScroller(offsets: Partial<Record<number, number>>, scrollLeft = 0)
	{
		const scroller =
		{
			scrollLeft,
			getBoundingClientRect: () => (
			{
				left: 100,
			}),
			querySelector: (selector: string) =>
			{
				const ts = Number(/data-ts="(\d+)"/u.exec(selector)?.[1]);
				const offset = offsets[ts];
				return offset === undefined
					? null
					:
						{
							getBoundingClientRect: () => (
							{
								left: 100 + offset - scroller.scrollLeft,
							}),
						};
			},
		};
		return scroller;
	}

	describe("scrollStripOnMount", () =>
	{
		it("puts a month page's own first day at the left edge wherever the scroller starts", () =>
		{
			const month = stripScroller(
				{
					1: 0,
					11: 400,
				},
				400,
			);
			scrollStripOnMount(
				month,
				{
					level: "month",
					pageTs: 1,
					todayTs: 99,
				},
			);
			const day = stripScroller(
				{
					5: 240,
				},
				30,
			);
			scrollStripOnMount(
				day,
				{
					level: "day",
					pageTs: 5,
					todayTs: 99,
				},
			);
			const missing = stripScroller({}, 70);
			scrollStripOnMount(
				missing,
				{
					level: "week",
					pageTs: 5,
					todayTs: 99,
				},
			);
			expect([month.scrollLeft, day.scrollLeft, missing.scrollLeft]).toStrictEqual([0, 240, 0]);
		});

		it("scrolls a year page home, then to today's cell when the strip has one", () =>
		{
			const year = stripScroller(
				{
					1: 0,
					9: 400,
				},
				400,
			);
			scrollStripOnMount(
				year,
				{
					level: "year",
					pageTs: 1,
					todayTs: 99,
				},
			);
			const withToday = stripScroller(
				{
					1: 0,
					99: 300,
				},
				50,
			);
			scrollStripOnMount(
				withToday,
				{
					level: "year",
					pageTs: 1,
					todayTs: 99,
				},
			);
			expect([year.scrollLeft, withToday.scrollLeft]).toStrictEqual([0, 300]);
		});
	});

	class FakeScroller extends EventTarget
	{
		scrollLeft = 50;
		style =
		{
			cursor: "",
		};
	}

	function mouse(type: string, clientX: number, button = 0): Event
	{
		return Object.assign(
			new Event(
				type,
				{
					cancelable: true,
				},
			),
			{
				clientX,
				button,
			},
		);
	}

	describe("attachDragScroll", () =>
	{
		it("scrolls with a left-button drag past 4px, shows grabbing, and swallows the one click that follows", () =>
		{
			const scroller = new FakeScroller();
			const doc = new EventTarget();
			attachDragScroll(scroller, doc);

			scroller.dispatchEvent(mouse("mousedown", 100));
			doc.dispatchEvent(mouse("mousemove", 97));
			const small =
			{
				scrollLeft: scroller.scrollLeft,
				cursor: scroller.style.cursor,
			};
			doc.dispatchEvent(mouse("mousemove", 90));
			const dragging =
			{
				scrollLeft: scroller.scrollLeft,
				cursor: scroller.style.cursor,
			};
			doc.dispatchEvent(mouse("mouseup", 90));
			const swallowed = mouse("click", 90);
			scroller.dispatchEvent(swallowed);
			const next = mouse("click", 90);
			scroller.dispatchEvent(next);

			expect(
				{
					small,
					dragging,
					cursorAfter: scroller.style.cursor,
					swallowed: swallowed.defaultPrevented,
					next: next.defaultPrevented,
				},
			).toStrictEqual(
				{
					small:
					{
						scrollLeft: 50,
						cursor: "",
					},
					dragging:
					{
						scrollLeft: 60,
						cursor: "grabbing",
					},
					cursorAfter: "",
					swallowed: true,
					next: false,
				},
			);
		});

		it("leaves plain clicks and other buttons alone, and detaches on cleanup", () =>
		{
			const scroller = new FakeScroller();
			const doc = new EventTarget();
			const detach = attachDragScroll(scroller, doc);

			scroller.dispatchEvent(mouse("mousedown", 100));
			doc.dispatchEvent(mouse("mouseup", 100));
			const plain = mouse("click", 100);
			scroller.dispatchEvent(plain);
			scroller.dispatchEvent(mouse("mousedown", 100, 2));
			doc.dispatchEvent(mouse("mousemove", 50));
			const rightDrag = scroller.scrollLeft;
			doc.dispatchEvent(mouse("mouseup", 50));
			detach();
			scroller.dispatchEvent(mouse("mousedown", 100));
			doc.dispatchEvent(mouse("mousemove", 50));

			expect(
				{
					plain: plain.defaultPrevented,
					rightDrag,
					detached: scroller.scrollLeft,
				},
			).toStrictEqual(
				{
					plain: false,
					rightDrag: 50,
					detached: 50,
				},
			);
		});
	});

	describe("attachOutsideDismiss", () =>
	{
		function pointerDownOn(target: EventTarget): Event
		{
			const event = new Event("pointerdown");
			Object.defineProperty(
				event,
				"target",
				{
					value: target,
				},
			);
			return event;
		}

		it("dismisses on a pointerdown outside the popup and its button, and detaches on cleanup", () =>
		{
			const doc = new EventTarget();
			const popup = new EventTarget();
			const button = new EventTarget();
			const outside = new EventTarget();
			const dismissals: string[] = [];
			let current = "";
			const detach = attachOutsideDismiss(
				doc,
				(target) => target === popup || target === button,
				() =>
				{
					dismissals.push(current);
				},
			);

			for (const [name, target] of [
				["popup", popup],
				["button", button],
				["outside", outside],
			] as const)
			{
				current = name;
				doc.dispatchEvent(pointerDownOn(target));
			}
			detach();
			current = "after detach";
			doc.dispatchEvent(pointerDownOn(outside));

			expect(dismissals).toStrictEqual(["outside"]);
		});
	});

	describe("strip drag-and-drop", () =>
	{
		const RECT =
		{
			left: 100,
			right: 500,
		};

		it("autoscrolls 2-10px per frame within 80px of either edge, and not in the middle", () =>
		{
			expect([
				stripAutoscrollSpeed(100, RECT),
				stripAutoscrollSpeed(140, RECT),
				stripAutoscrollSpeed(180, RECT),
				stripAutoscrollSpeed(300, RECT),
				stripAutoscrollSpeed(420, RECT),
				stripAutoscrollSpeed(460, RECT),
				stripAutoscrollSpeed(500, RECT),
				stripAutoscrollSpeed(40, RECT),
			]).toStrictEqual([-10, -6, 0, 0, 0, 6, 10, -10]);
		});

		it("drops on a day cell into that day, and on a month cell into that month on month and year pages, else its 1st", () =>
		{
			const day = new Date(2026, 9, 5).getTime();
			const month = new Date(2026, 10, 1).getTime();
			expect([
				stripDropTarget(
					"day",
					{
						kind: "day",
						ts: day,
					},
				),
				stripDropTarget(
					"month",
					{
						kind: "day",
						ts: day,
					},
				),
				stripDropTarget(
					"day",
					{
						kind: "month",
						ts: month,
					},
				),
				stripDropTarget(
					"month",
					{
						kind: "month",
						ts: month,
					},
				),
				stripDropTarget(
					"year",
					{
						kind: "month",
						ts: month,
					},
				),
			]).toStrictEqual([
				{
					date: new Date(day),
					level: "day",
					createChild: false,
				},
				{
					date: new Date(day),
					level: "day",
					createChild: false,
				},
				{
					date: new Date(month),
					level: "day",
					createChild: false,
				},
				{
					date: new Date(month),
					level: "month",
					createChild: false,
				},
				{
					date: new Date(month),
					level: "month",
					createChild: false,
				},
			]);
		});

		interface DropRecord
		{
			ensured: CalendarTarget[];
			moves: BlockMove[][];
			toasts: MoveToToast[];
			cleared: number;
			views: string[];
			undos: number;
		}

		interface DropInput
		{
			level?: StripLevel;
			cell?: StripDropCell;
			items?: string[];
			ensured?:
			{
				id: string;
				childCount: number;
			} | null;
		}

		async function drop({
			level = "day",
			cell =
			{
				kind: "day",
				ts: new Date(2026, 9, 5).getTime(),
			},
			items = ["a", "b"],
			ensured =
			{
				id: "day-5",
				childCount: 3,
			},
		}: DropInput = {}): Promise<
			DropRecord &
			{
				moved: boolean;
			}
		>
		{
			const record: DropRecord =
			{
				ensured: [],
				moves: [],
				toasts: [],
				cleared: 0,
				views: [],
				undos: 0,
			};
			const moved = await runStripDrop(
				{
					items,
					level,
					cell,
					dayName: (date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} day`,
					ensure: async (target) =>
					{
						record.ensured.push(target);
						return Promise.resolve(ensured);
					},
					clearSelection: () =>
					{
						record.cleared++;
					},
					moveNodes: (moves) =>
					{
						record.moves.push(moves);
					},
					showToast: (toast) =>
					{
						record.toasts.push(toast);
					},
					view: (id) =>
					{
						record.views.push(id);
					},
					undo: () =>
					{
						record.undos++;
					},
				},
			);
			for (const action of record.toasts[0]?.actions ?? [])
			{
				action.run();
			}
			return {
				...record,
				moved,
			};
		}

		it("moves the dragged items to the end of the ensured day, clears the selection, and toasts View and Undo", async () =>
		{
			const result = await drop();
			expect(
				{
					...result,
					toasts: result.toasts.map(({text, timeout, actions}) => (
					{
						text,
						timeout,
						actions: actions.map(({label, shortcut}) => (
						{
							label,
							shortcut,
						})),
					})),
				},
			).toStrictEqual(
				{
					moved: true,
					ensured: [
						{
							date: new Date(2026, 9, 5),
							level: "day",
							createChild: false,
						},
					],
					moves: [
						[
							{
								ids: ["a", "b"],
								parentId: "day-5",
								index: 3,
							},
						],
					],
					cleared: 1,
					toasts: [
						{
							text: "moved to '2026-10-5 day'",
							timeout: 5000,
							actions: [
								{
									label: "View",
									shortcut: "shift+return",
								},
								{
									label: "Undo",
									shortcut: undefined,
								},
							],
						},
					],
					views: ["day-5"],
					undos: 1,
				},
			);
		});

		it("names a month node `Oct 2026` in the toast", async () =>
		{
			const result = await drop(
				{
					level: "year",
					cell:
					{
						kind: "month",
						ts: new Date(2026, 9, 1).getTime(),
					},
					ensured:
					{
						id: "oct",
						childCount: 0,
					},
				},
			);
			expect(
				{
					moves: result.moves,
					text: result.toasts.map((toast) => toast.text),
				},
			).toStrictEqual(
				{
					moves: [
						[
							{
								ids: ["a", "b"],
								parentId: "oct",
								index: 0,
							},
						],
					],
					text: ["Moved to Oct 2026"],
				},
			);
		});

		it("moves nothing when the page cannot be found or created, or when it is one of the dragged items", async () =>
		{
			const missing = await drop(
				{
					ensured: null,
				},
			);
			const self = await drop(
				{
					items: ["day-5"],
				},
			);
			expect(
				[missing, self].map(({moved, moves, cleared, toasts}) => (
				{
					moved,
					moves,
					cleared,
					toasts,
				})),
			).toStrictEqual([
				{
					moved: false,
					moves: [],
					cleared: 0,
					toasts: [],
				},
				{
					moved: false,
					moves: [],
					cleared: 0,
					toasts: [
						{
							text: "Can't move to '2026-10-5 day'",
							timeout: 5000,
							actions: [],
							type: "failure",
						},
					],
				},
			]);
		});

		it("marks day and month cards as drop targets and highlights the hovered one", () =>
		{
			const day = new Date(2026, 8, 30).getTime();
			const html = render(
				{
					level: "day",
					dragging: true,
					dropHoverKey: `day:${day}`,
				},
			);
			const all = cells(html);
			const hovered = all.find((cell) => cell.ts === day);
			const firstMonth = all.find((cell) => cell.card.includes("px-s"));
			expect(
				{
					dayDrops: (html.match(/data-strip-drop="day"/gu) ?? []).length,
					monthDrops: (html.match(/data-strip-drop="month"/gu) ?? []).length,
					hovered: ["bg-tertiary", "border", "border-solid", "border-strong"].every((c) =>
						hovered?.card.includes(c),
					),
					hoveredPlain: hovered?.card.includes("!bg-secondary"),
					monthWhileDragging: ["bg-secondary", "hover:bg-tertiary"].every((c) =>
						firstMonth?.card.includes(c),
					),
				},
			).toStrictEqual(
				{
					dayDrops: 31,
					monthDrops: 12,
					hovered: true,
					hoveredPlain: false,
					monthWhileDragging: true,
				},
			);
		});
	});
});
