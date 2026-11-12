import {describe, expect, it, vi} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(
	id: string,
	parentId: string | null,
	priority: number,
	extra: Partial<WorkflowyNode> = {},
): WorkflowyNode
{
	return {
		id,
		name: id.toLowerCase(),
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		...extra,
	};
}

/** Home holds P and O; O (completed, note "n") holds C (with G) and E, a mirror of X; X holds Y. */
function setup(expanded: string[] = [], mode: "mirror" | "standalone" = "mirror")
{
	const sqlite = new DatabaseConstructor(":memory:");
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
	cacheService.insertNode(apiNode("P", null, 0), null);
	cacheService.insertNode(
		apiNode(
			"O",
			null,
			1,
			{
				note: "n",
				completed: true,
				completedAt: 5,
			},
		),
		null,
	);
	cacheService.insertNode(apiNode("X", null, 2), null);
	cacheService.insertNode(apiNode("Y", "X", 0), "X");
	cacheService.insertNode(apiNode("C", "O", 0), "O");
	cacheService.insertNode(apiNode("G", "C", 0), "C");
	cacheService.insertNode(apiNode("E", "O", 1), "O");
	cacheService.insertNode(apiNode("M", "P", 0), "P");
	const link = sqlite.prepare(
		"INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)",
	);
	link.run("E", "X", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	link.run("M", "O", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	const createTreesAt = vi.fn<WorkflowyInternalAdapter["createTreesAt"]>(async (input) =>
		Promise.resolve(
			{
				ids: input.trees.map((tree) => tree.id ?? ""),
			},
		),
	);
	const setExpanded = vi.fn<WorkflowyInternalAdapter["setExpanded"]>(async () => Promise.resolve());
	const expansionTest = vi.fn<WorkflowyInternalAdapter["expansionTest"]>(() => (id: string) => expanded.includes(id));
	const ctx =
	{
		db,
		cacheService,
		mode,
		apiKey: mode === "standalone" ? undefined : "test-key",
		internalAuth: {},
		internalAdapter: () =>
			(
			{
				createTreesAt,
				setExpanded,
				expansionTest,
			}) as unknown as WorkflowyInternalAdapter,
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const post = async (body: unknown) =>
		app.fetch(
			new Request(
				"http://x/api/v1/nodes/duplicate",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
			),
		);
	return {
		createTreesAt,
		setExpanded,
		post,
		cacheService,
	};
}

const anyId = expect.any(String) as string;

describe("POST /api/v1/nodes/duplicate", () =>
{
	it("deep-copies each item to consecutive slots with one bulk create: note, completion, children, and child mirrors stay mirrors", async () =>
	{
		const {createTreesAt, post} = setup();

		const res = await post(
			{
				ids: ["O", "P"],
				parent_id: "P",
				index: 2,
			},
		);

		const call = createTreesAt.mock.calls[0]?.[0];
		expect(
			{
				status: res.status,
				call,
				ids: (
					(await res.json()) as
					{
						ids: string[];
					}
				).ids,
			},
		).toStrictEqual(
			{
				status: 201,
				call:
				{
					parentId: "P",
					index: 2,
					trees: [
						{
							id: anyId,
							name: "o",
							note: "n",
							completed: true,
							children: [
								{
									id: anyId,
									name: "c",
									children: [
										{
											id: anyId,
											name: "g",
										},
									],
								},
								{
									id: anyId,
									name: "",
									metadata:
									{
										mirror:
										{
											originalId: "X",
											isMirrorRoot: true,
										},
									},
								},
							],
						},
						{
							id: anyId,
							name: "p",
							children: [
								{
									id: anyId,
									name: "",
									metadata:
									{
										mirror:
										{
											originalId: "O",
											isMirrorRoot: true,
										},
									},
								},
							],
						},
					],
				},
				ids: call.trees.map((tree) => tree.id),
			},
		);
	});

	it("duplicates a mirror from its original and opens copies whose source rows are expanded", async () =>
	{
		const {createTreesAt, setExpanded, post} = setup(["M", "C"]);

		await post(
			{
				ids: ["M"],
				parent_id: null,
				index: 0,
			},
		);

		const [tree] = createTreesAt.mock.calls[0]?.[0].trees ?? [];
		expect(
			{
				name: tree.name,
				parent: createTreesAt.mock.calls[0]?.[0].parentId,
				opened: setExpanded.mock.calls,
			},
		).toStrictEqual(
			{
				name: "o",
				parent: "home",
				opened: [
					[
						{
							[tree.id ?? ""]: true,
							[tree.children?.[0]?.id ?? ""]: true,
						},
					],
				],
			},
		);
	});

	it("rejects an empty id list and an unknown id without writing", async () =>
	{
		const {createTreesAt, post} = setup();

		const empty = await post(
			{
				ids: [],
				parent_id: "P",
				index: 0,
			},
		);
		const unknown = await post(
			{
				ids: ["nope"],
				parent_id: "P",
				index: 0,
			},
		);

		expect(
			{
				empty: empty.status,
				unknown: unknown.status,
				calls: createTreesAt.mock.calls.length,
			},
		).toStrictEqual(
			{
				empty: 400,
				unknown: 404,
				calls: 0,
			},
		);
	});

	it("deep-copies into the local tables in a standalone context, with no adapter", async () =>
	{
		const {createTreesAt, post, cacheService} = setup([], "standalone");
		const shape = (parentId: string | null): unknown[] =>
			cacheService.getChildren(parentId).map((node) => (
			{
				name: node.name,
				note: node.note,
				completed: node.completedAt !== null,
				mirrorOf: cacheService.getMirrorOriginal(node.id) ?? null,
				children: shape(node.id),
			}));

		const res = await post(
			{
				ids: ["O"],
				parent_id: "P",
				index: 0,
			},
		);
		const {ids} = (await res.json()) as
		{
			ids: string[];
		};

		expect(
			{
				status: res.status,
				copy: shape("P")[0],
				first: ids[0] === cacheService.getChildren("P")[0]?.id,
				calls: createTreesAt.mock.calls.length,
			},
		).toStrictEqual(
			{
				status: 201,
				copy:
				{
					name: "o",
					note: "n",
					completed: true,
					mirrorOf: null,
					children: [
						{
							name: "c",
							note: null,
							completed: false,
							mirrorOf: null,
							children: [
								{
									name: "g",
									note: null,
									completed: false,
									mirrorOf: null,
									children: [],
								},
							],
						},
						{
							name: "x",
							note: null,
							completed: false,
							mirrorOf: "X",
							children: [],
						},
					],
				},
				first: true,
				calls: 0,
			},
		);
	});
});
