import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {upstreamExpansionKey} from "@outlinedb/shared/workflowy";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode
{
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		completed: completedAt !== undefined,
		...(completedAt === undefined
			? {}
			:
				{
					completedAt,
				}),
	};
}

/** Home holds Alpha>{A1>{A1a}, A2 (completed)>{A2a}} and Beta>{B1}. */
/** `accountExpanded`: the account's expanded ids the internal API holds; undefined leaves it unconfigured. */
function setup(accountExpanded?: readonly string[])
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
	cacheService.insertNode(apiNode("Alpha", null, 0), null);
	cacheService.insertNode(apiNode("Beta", null, 1), null);
	cacheService.insertNode(apiNode("A1", "Alpha", 0), "Alpha");
	cacheService.insertNode(apiNode("A2", "Alpha", 1, 300), "Alpha");
	cacheService.insertNode(apiNode("A1a", "A1", 0), "A1");
	cacheService.insertNode(apiNode("A2a", "A2", 0), "A2");
	cacheService.insertNode(apiNode("B1", "Beta", 0), "Beta");
	// The account's expansion lives in `expanded_nodes` under upstream's keys, which the internal API tests ids against.
	for (const key of new Set(accountExpanded?.map(upstreamExpansionKey)))
	{
		sqlite
			.prepare("INSERT INTO expanded_nodes (short_key, system_from, system_to) VALUES (?, ?, ?)")
			.run(key, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	}
	const adapter =
		accountExpanded === undefined
			? undefined
			:
				{
					expansionTest: () => (id: string) =>
						accountExpanded.map(upstreamExpansionKey).includes(upstreamExpansionKey(id)),
				};
	const ctx =
	{
		db,
		cacheService,
		internalAdapter: () => adapter,
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const post = async (body: unknown) =>
	{
		const res = await app.fetch(
			new Request(
				"http://x/api/v1/nodes/view",
				{
					method: "POST",
					headers:
					{
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			),
		);
		return {
			status: res.status,
			body: await res.json(),
		};
	};
	/** Make `mirrorId` (a new child of `parentId`) a mirror of `originalId`. */
	const mirror = (mirrorId: string, parentId: string, originalId: string) =>
	{
		cacheService.insertNode(apiNode(mirrorId, parentId, 9), parentId);
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	};
	/** Add `id` under `parentId`; without metadata its priority and creation time read as 0. */
	const add = (
		id: string,
		parentId: string,
		priority: number,
		{completedAt, metadata = true} = {} as
		{
			completedAt?: number;
			metadata?: boolean;
		},
	) =>
	{
		cacheService.insertNode(apiNode(id, parentId, priority, completedAt), parentId);
		if (!metadata)
		{
			sqlite.prepare("DELETE FROM node_metadata WHERE node_id = ?").run(id);
		}
	};
	/** Make `id` (a new child of `targetId`) `targetId`'s references root. */
	const referencesRoot = (id: string, targetId: string) =>
	{
		cacheService.insertNode(apiNode(id, targetId, 99), targetId);
		sqlite
			.prepare("INSERT INTO references_roots (node_id, system_from, system_to) VALUES (?, ?, ?)")
			.run(id, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	};
	return {
		post,
		mirror,
		add,
		referencesRoot,
	};
}

interface ListBody
{
	parentId: string | null;
	nodes:
	{
		id: string;
	}[];
	backlinks: unknown;
}

/** Each list as [parentId, child ids, backlinks]. */
function lists(body: {lists: ListBody[]}): [string | null, string[], unknown][]
{
	return body.lists.map((list) => [list.parentId, list.nodes.map((node) => node.id), list.backlinks]);
}

const NO_BACKLINKS =
{
	rootId: null,
	items: [],
};

/**
 * A Backlinks section item as the view sends it: the item row (named after its source, priority 9 from `mirror`)
 * carrying its source's text, completion and child flags. A crumb given as a string is a node named after its id.
 */
function backlinkItem(
	id: string,
	rootId: string,
	sourceId: string,
	{
		completedAt = null,
		children = false,
		crumbs,
	}:
	{
		completedAt?: number | null;
		children?: boolean;
		crumbs: (
			| string
			|
			  {
					id: string;
					name: string;
			  }
		)[];
	},
)
{
	return {
		node:
		{
			id,
			parent_id: rootId,
			name: sourceId,
			note: null,
			priority: 9,
			data:
			{
				layoutMode: null,
			},
			numberedStart: null,
			createdAt: 100,
			modifiedAt: 200,
			completedAt,
			hasChildren: children,
			hasUncompletedChildren: children,
			isMirror: true,
			hasMirrors: false,
			originalNodeId: sourceId,
			attachment: null,
			defaultToBottom: false,
			calendar: null,
			table: null,
		},
		sourceId,
		crumbs: crumbs.map((crumb) =>
			typeof crumb === "string"
				?
					{
						id: crumb,
						name: crumb,
					}
				: crumb,
		),
	};
}

describe("POST /api/v1/nodes/view", () =>
{
	it("lists the root's and every expanded rendered row's children depth-first, with their Backlinks", async () =>
	{
		const {post} = setup();

		const {status, body} = await post(
			{
				rootId: null,
				expandedIds: ["Alpha", "A1", "A2", "Beta"],
				limit: 100,
				showCompleted: false,
			},
		);

		expect(
			{
				status,
				lists: lists(body),
			},
		).toStrictEqual(
			{
				status: 200,
				lists: [
					[null, ["Alpha", "Beta"], null],
					["Alpha", ["A1", "A2"], NO_BACKLINKS],
					["A1", ["A1a"], NO_BACKLINKS],
					["Beta", ["B1"], NO_BACKLINKS],
				],
			},
		);
	});

	it("descends into a completed expanded row when completed rows show", async () =>
	{
		const {post} = setup();

		const {body} = await post(
			{
				rootId: "Alpha",
				expandedIds: ["A2"],
				limit: 100,
				showCompleted: true,
			},
		);

		expect(lists(body)).toStrictEqual([
			["Alpha", ["A1", "A2"], NO_BACKLINKS],
			["A2", ["A2a"], NO_BACKLINKS],
		]);
	});

	it("stops descending once the row budget is spent", async () =>
	{
		const {post} = setup();

		const {body} = await post(
			{
				rootId: null,
				expandedIds: ["Alpha", "A1", "Beta"],
				limit: 3,
				showCompleted: false,
			},
		);

		expect(lists(body)).toStrictEqual([
			[null, ["Alpha", "Beta"], null],
			["Alpha", ["A1", "A2"], NO_BACKLINKS],
			["A1", ["A1a"], NO_BACKLINKS],
		]);
	});

	it("lists an expanded mirror's original's children under the mirror's id", async () =>
	{
		const {post, mirror} = setup();
		mirror("M", "Beta", "Alpha");

		const {body} = await post(
			{
				rootId: "Beta",
				expandedIds: ["M"],
				limit: 100,
				showCompleted: false,
			},
		);

		expect(lists(body)).toStrictEqual([
			["Beta", ["B1", "M"], NO_BACKLINKS],
			["M", ["A1", "A2"], NO_BACKLINKS],
		]);
	});

	it("sends each list once and stops at a mirror inside its own original", async () =>
	{
		const {post, mirror} = setup();
		mirror("Mmmm", "A1", "Alpha");

		const {body} = await post(
			{
				rootId: null,
				expandedIds: ["Alpha", "A1", "Mmmm"],
				limit: 200,
				showCompleted: false,
			},
		);

		expect(lists(body)).toStrictEqual([
			[null, ["Alpha", "Beta"], null],
			["Alpha", ["A1", "A2"], NO_BACKLINKS],
			["A1", ["A1a", "Mmmm"], NO_BACKLINKS],
			["Mmmm", ["A1", "A2"], NO_BACKLINKS],
		]);
	});

	it("orders siblings by priority then creation time and spends the budget in that order", async () =>
	{
		const {post, add} = setup();
		add("Neg", "Beta", -5);
		add("Huge", "Beta", 2 ** 40);
		add("H1", "Huge", 0);
		add(
			"NoMeta",
			"Beta",
			3,
			{
				metadata: false,
			},
		);

		const {body} = await post(
			{
				rootId: "Beta",
				expandedIds: ["Huge", "B1"],
				limit: 3,
				showCompleted: false,
			},
		);

		expect(lists(body)).toStrictEqual([
			["Beta", ["Neg", "NoMeta", "B1", "Huge"], NO_BACKLINKS],
			["B1", [], NO_BACKLINKS],
		]);
	});

	it("neither counts nor expands a hidden completed row", async () =>
	{
		const {post, add} = setup();
		add(
			"A0",
			"Alpha",
			-1,
			{
				completedAt: 300,
			},
		);
		add("A0a", "A0", 0);

		const {body} = await post(
			{
				rootId: "Alpha",
				expandedIds: ["A0", "A1"],
				limit: 1,
				showCompleted: false,
			},
		);

		expect(lists(body)).toStrictEqual([
			["Alpha", ["A0", "A1", "A2"], NO_BACKLINKS],
			["A1", ["A1a"], NO_BACKLINKS],
		]);
	});

	it("expands a row inside a mirror by its instance key, not its own id", async () =>
	{
		const {post, mirror} = setup();
		mirror("M", "Beta", "Alpha");

		const [instance, plain] = await Promise.all([
			post(
				{
					rootId: "Beta",
					expandedIds: ["M", "virtual_A1_M_M"],
					limit: 100,
					showCompleted: false,
				},
			),
			post(
				{
					rootId: "Beta",
					expandedIds: ["M", "A1"],
					limit: 100,
					showCompleted: false,
				},
			),
		]);

		expect(
			{
				instance: lists(instance.body),
				plain: lists(plain.body),
			},
		).toStrictEqual(
			{
				instance: [
					["Beta", ["B1", "M"], NO_BACKLINKS],
					["M", ["A1", "A2"], NO_BACKLINKS],
					["A1", ["A1a"], NO_BACKLINKS],
				],
				plain: [
					["Beta", ["B1", "M"], NO_BACKLINKS],
					["M", ["A1", "A2"], NO_BACKLINKS],
				],
			},
		);
	});

	it("expands the account's expanded rows for null expandedIds, returning those the view reached", async () =>
	{
		const {post} = setup(["Alpha", "A1", "A2", "Beta", "Elsewhere"]);

		const {body} = await post(
			{
				rootId: null,
				expandedIds: null,
				limit: 100,
				showCompleted: false,
			},
		);

		expect(
			{
				lists: lists(body),
				expandedIds: body.expandedIds,
			},
		).toStrictEqual(
			{
				lists: [
					[null, ["Alpha", "Beta"], null],
					["Alpha", ["A1", "A2"], NO_BACKLINKS],
					["A1", ["A1a"], NO_BACKLINKS],
					["Beta", ["B1"], NO_BACKLINKS],
				],
				expandedIds: ["Alpha", "Beta", "A1", "A2"],
			},
		);
	});

	it("expands nothing for null expandedIds without the internal API", async () =>
	{
		const {post} = setup();

		const {body} = await post(
			{
				rootId: null,
				expandedIds: null,
				limit: 100,
				showCompleted: false,
			},
		);

		expect(
			{
				lists: lists(body),
				expandedIds: body.expandedIds,
			},
		).toStrictEqual(
			{
				lists: [[null, ["Alpha", "Beta"], null]],
				expandedIds: [],
			},
		);
	});

	it("sends each listed parent's whole Backlinks section", async () =>
	{
		const {post, mirror, add, referencesRoot} = setup();
		add("D1", "B1", 0);
		add("D2", "D1", 0);
		add("D3", "D2", 0);
		add(
			"Cmp",
			"Beta",
			5,
			{
				completedAt: 300,
			},
		);
		// Alpha: a deep source, a completed source, and an item whose source is not cached.
		referencesRoot("RA", "Alpha");
		mirror("IA1", "RA", "D3");
		mirror("IA2", "RA", "Cmp");
		mirror("IA3", "RA", "Nope");
		// Beta's references root holds a plain row too, the source of A1's only backlink: its crumbs show the label.
		referencesRoot("RB", "Beta");
		mirror("IB", "RB", "D2");
		add("Nested", "RB", 0);
		referencesRoot("RA1", "A1");
		mirror("IX", "RA1", "Nested");
		// B1's section is empty.
		referencesRoot("RB1", "B1");
		mirror("M", "Beta", "Alpha");

		const {body} = await post(
			{
				rootId: null,
				expandedIds: ["Alpha", "A1", "Beta", "B1", "M"],
				limit: 100,
				showCompleted: true,
			},
		);

		const alpha =
		{
			rootId: "RA",
			items: [
				backlinkItem(
					"IA1",
					"RA",
					"D3",
					{
						crumbs: ["Beta", "B1", "D1", "D2"],
					},
				),
				backlinkItem(
					"IA2",
					"RA",
					"Cmp",
					{
						completedAt: 300,
						crumbs: ["Beta"],
					},
				),
			],
		};
		expect(body.lists.map((list: ListBody) => [list.parentId, list.backlinks])).toStrictEqual([
			[null, null],
			["Alpha", alpha],
			[
				"A1",
				{
					rootId: "RA1",
					items: [
						backlinkItem(
							"IX",
							"RA1",
							"Nested",
							{
								crumbs: [
									"Beta",
									{
										id: "RB",
										name: "1 Backlink",
									},
								],
							},
						),
					],
				},
			],
			[
				"Beta",
				{
					rootId: "RB",
					items: [
						backlinkItem(
							"IB",
							"RB",
							"D2",
							{
								children: true,
								crumbs: ["Beta", "B1", "D1"],
							},
						),
					],
				},
			],
			[
				"B1",
				{
					rootId: "RB1",
					items: [],
				},
			],
			["M", alpha],
		]);
	});

	it("answers 404 for an unresolvable short root id and 400 for a malformed body", async () =>
	{
		const {post} = setup();

		await expect(
			Promise.all([
				post(
					{
						rootId: "0123456789ab",
						expandedIds: [],
						limit: 10,
						showCompleted: false,
					},
				),
				post(
					{
						rootId: null,
						expandedIds: "Alpha",
						limit: 10,
						showCompleted: false,
					},
				),
			]),
		).resolves.toStrictEqual([
			{
				status: 404,
				body:
				{
					error: "Node not found",
				},
			},
			{
				status: 400,
				body:
				{
					error: "body must be {rootId, expandedIds, limit, showCompleted}",
				},
			},
		]);
	});
});

/** Durable Object SQLite rejects a statement with more than 100 bound parameters. */
const DURABLE_OBJECT_PARAMETER_CAP = 100;

/**
 * Home holds `Root`, which holds `width` rows `P000..`, each the top of a chain `depth` rows deep. Every row is
 * expanded. With `backlinks`, every row also has a references root holding one backlink item from its own source
 * row under Home's `Sources > Group`. Statements past the Durable Object's bound-parameter cap fail the way workerd
 * does, and every prepared statement during a request is counted.
 */
function wideSetup(width: number, depth: number, {backlinks = false, sourceDepth = 2} = {})
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
	cacheService.insertNode(apiNode("Root", null, 0), null);
	cacheService.insertNode(apiNode("Sources", null, 1), null);
	cacheService.insertNode(apiNode("Group", "Sources", 0), "Sources");
	// Every source sits `sourceDepth` levels under Home: Sources > Group > Group-2 > ...
	let sourceParent = "Group";
	for (let level = 2; level < sourceDepth; level += 1)
	{
		cacheService.insertNode(apiNode(`Group-${level}`, sourceParent, 0), sourceParent);
		sourceParent = `Group-${level}`;
	}
	const live = ["2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE];
	/** Give `target` a references root holding a backlink item from a new source row. */
	const backlinkTo = (target: string) =>
	{
		cacheService.insertNode(apiNode(`S-${target}`, sourceParent, 0), sourceParent);
		cacheService.insertNode(apiNode(`R-${target}`, target, 99), target);
		cacheService.insertNode(apiNode(`I-${target}`, `R-${target}`, 0), `R-${target}`);
		sqlite
			.prepare("INSERT INTO references_roots (node_id, system_from, system_to) VALUES (?, ?, ?)")
			.run(`R-${target}`, ...live);
		sqlite
			.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
			.run(`I-${target}`, `S-${target}`, ...live);
	};
	const expandedIds = ["Root"];
	for (let index = 0; index < width; index += 1)
	{
		let parentId = "Root";
		for (let level = 0; level < depth; level += 1)
		{
			const id = `P${String(index).padStart(3, "0")}-${level}`;
			cacheService.insertNode(apiNode(id, parentId, level === 0 ? index : 0), parentId);
			expandedIds.push(id);
			if (backlinks)
			{
				backlinkTo(id);
			}
			parentId = id;
		}
	}
	let statements = 0;
	const prepare = sqlite.prepare.bind(sqlite);
	sqlite.prepare = (source: string) =>
	{
		statements += 1;
		const parameters = source.match(/\?/gu)?.length ?? 0;
		if (parameters > DURABLE_OBJECT_PARAMETER_CAP)
		{
			throw new Error(`too many SQL variables: ${parameters}`);
		}
		return prepare(source);
	};
	const ctx =
	{
		db,
		cacheService,
		internalAdapter: () =>
		{
		},
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) =>
	{
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	const view = async () =>
	{
		statements = 0;
		const res = await app.fetch(
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
							rootId: "Root",
							expandedIds,
							limit: 100_000,
							showCompleted: false,
						},
					),
				},
			),
		);
		// A failed view answers {error} without lists.
		const {lists: viewLists = []} = (await res.json()) as
		{
			lists?: ListBody[];
		};
		return {
			status: res.status,
			lists: viewLists,
			listCount: viewLists.length,
			statements,
		};
	};
	return {
		view,
	};
}

describe("POST /api/v1/nodes/view deep fetch", () =>
{
	it("reads a level of more expanded parents than a Durable Object statement may bind", async () =>
	{
		const {view} = wideSetup(150, 2);

		const {status, listCount} = await view();

		expect(
			{
				status,
				listCount,
			},
		).toStrictEqual(
			{
				status: 200,
				listCount: 1 + 150 * 2,
			},
		);
	});

	it("reads the whole tree in one statement however wide or deep the view", async () =>
	{
		const narrow = await wideSetup(3, 2).view();
		const wide = await wideSetup(150, 2).view();
		const deep = await wideSetup(20, 6).view();

		expect(
			{
				narrow: narrow.statements,
				wide: wide.statements,
				deep: deep.statements,
			},
		).toStrictEqual(
			{
				narrow: 1,
				wide: 1,
				deep: 1,
			},
		);
	});

	it("reads every expanded row's Backlinks section in one more statement however many rows have one or how deep their sources sit", async () =>
	{
		const narrow = await wideSetup(
			3,
			2,
			{
				backlinks: true,
			},
		).view();
		const wide = await wideSetup(
			150,
			2,
			{
				backlinks: true,
			},
		).view();
		const deepSources = await wideSetup(
			3,
			2,
			{
				backlinks: true,
				sourceDepth: 8,
			},
		).view();

		expect(
			{
				statements: [narrow.statements, wide.statements, deepSources.statements],
				last: wide.lists.at(-1),
			},
		).toStrictEqual(
			{
				statements: [2, 2, 2],
				last:
				{
					parentId: "P149-1",
					nodes: [],
					backlinks:
					{
						rootId: "R-P149-1",
						items: [
							{
								node: expect.objectContaining(
									{
										id: "I-P149-1",
										isMirror: true,
										originalNodeId: "S-P149-1",
									},
								),
								sourceId: "S-P149-1",
								crumbs: [
									{
										id: "Sources",
										name: "Sources",
									},
									{
										id: "Group",
										name: "Group",
									},
								],
							},
						],
					},
				},
			},
		);
	});
});
