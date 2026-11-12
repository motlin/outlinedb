import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {z} from "zod";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {calendarNodeId} from "@outlinedb/shared/internal";
import type {CalendarLayoutSnapshot, LayoutTimings, WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

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
			calls.push(`applyCalendarLayout ${JSON.stringify(levels)} ${rootId} ${snapshot?.root.id ?? "no snapshot"}`);
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
				calls: ['applyCalendarLayout {"year":true} sandbox-cal sandbox-cal', "undoCalendarLayout sandbox-cal"],
				logged: [
					"calendar layout: applying under root sandbox-cal",
					"calendar layout: 3 writes under root sandbox-cal (plan;dur=1.3, push;dur=20.0)",
					"calendar layout: undoing under root sandbox-cal",
				],
			},
		);
	});
});
