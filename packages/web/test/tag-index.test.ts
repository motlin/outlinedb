import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {nodeTreeHost} from "../src/server/node-host.js";
import {bindTreeHost} from "../src/server/tree-snapshot.js";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {CacheService, ensureNodeTags} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {itemTags} from "@outlinedb/shared/tags";
import type {TaggedText} from "@outlinedb/shared/tags";
import {eq, sql} from "drizzle-orm";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {mergeFallback, rankCounts} from "../src/server/ops/tag-index.js";
import type {TagCount} from "../src/server/ops/tag-index.js";
import {httpAppFor} from "./http-app-for.js";

/**
 * The tag counts the server computed in JS before node_tags: every item's distinct tags, counted once per item in
 * the order given, keeping each tag's first-seen casing. The reference the SQL autocomplete must match.
 */
function jsCounts(rows: Iterable<TaggedText>): Map<string, TagCount>
{
	const counts = new Map<string, TagCount>();
	for (const row of rows)
	{
		for (const [lower, tag] of itemTags(row))
		{
			const entry = counts.get(lower);
			counts.set(
				lower,
				entry
					?
						{
							tag: entry.tag,
							count: entry.count + 1,
						}
					:
						{
							tag,
							count: 1,
						},
			);
		}
	}
	return counts;
}

function rankTags(
	rows: Iterable<TaggedText>,
	options:
	{
		prefix: string;
		limit: number;
	},
): TagCount[]
{
	return rankCounts(jsCounts(rows), options);
}

const FIXTURE_NAMES = [
	"Alpha #taZebra item",
	"Beta #taZebra #taApple",
	"Gamma #taApple @taPerson",
	"Delta #TaZebra upper, #ta:sub:key end",
	"Numbers #123 #1234 #12a",
	"Edge (#taParen) #taDot. foo#taNo",
	"Bold <b>#taBold</b> tag",
	"Type here",
];

const FIXTURE_ROWS = FIXTURE_NAMES.map((name) => (
{
	name,
	note: null,
}));

function asPairs(tags: TagCount[]): string[]
{
	return tags.map(({tag, count}) => `${tag}:${count}`);
}

describe("rankTags in code blocks", () =>
{
	it("leaves a code block's tags out of the counts", () =>
	{
		expect(
			asPairs(
				rankTags(
					[
						{
							name: "#a",
							note: null,
							layoutMode: "code-block",
						},
						{
							name: "#b",
							note: null,
						},
					],
					{
						prefix: "#",
						limit: 8,
					},
				),
			),
		).toStrictEqual(["#b:1"]);
	});
});

describe("rankTags", () =>
{
	it("ranks every tag by count, then non-digit before digit, then plain string order, capped at the limit", () =>
	{
		expect(
			asPairs(
				rankTags(
					FIXTURE_ROWS,
					{
						prefix: "#",
						limit: 8,
					},
				),
			),
		).toStrictEqual([
			"#taZebra:3",
			"#taApple:2",
			"#ta:sub:key:1",
			"#taBold:1",
			"#taDot:1",
			"#taParen:1",
			"#1234:1",
			"#12a:1",
		]);
	});

	it("matches the prefix case-insensitively", () =>
	{
		expect(
			asPairs(
				rankTags(
					FIXTURE_ROWS,
					{
						prefix: "#taA",
						limit: 8,
					},
				),
			),
		).toStrictEqual(["#taApple:2"]);
		expect(
			asPairs(
				rankTags(
					FIXTURE_ROWS,
					{
						prefix: "#TA",
						limit: 8,
					},
				),
			),
		).toStrictEqual(["#taZebra:3", "#taApple:2", "#ta:sub:key:1", "#taBold:1", "#taDot:1", "#taParen:1"]);
	});

	it("counts tags in notes and skips #use-template tags", () =>
	{
		const rows = [
			{
				name: "One",
				note: "#taNote and #use-template:x",
			},
			{
				name: "Two #taNote",
				note: null,
			},
		];

		expect(
			rankTags(
				rows,
				{
					prefix: "#",
					limit: 8,
				},
			),
		).toStrictEqual([
			{
				tag: "#taNote",
				count: 2,
			},
		]);
	});
});

describe("mergeFallback", () =>
{
	it("fills from the fallback list with tags not already listed", () =>
	{
		expect(
			mergeFallback(
				[
					{
						tag: "#a",
						count: 2,
					},
				],
				[
					{
						tag: "#a",
						count: 5,
					},
					{
						tag: "#b",
						count: 1,
					},
				],
				8,
			),
		).toStrictEqual([
			{
				tag: "#a",
				count: 2,
			},
			{
				tag: "#b",
				count: 1,
			},
		]);
	});

	it("stops at the limit", () =>
	{
		expect(
			mergeFallback(
				[
					{
						tag: "#a",
						count: 2,
					},
				],
				[
					{
						tag: "#b",
						count: 5,
					},
					{
						tag: "#c",
						count: 1,
					},
				],
				2,
			),
		).toStrictEqual([
			{
				tag: "#a",
				count: 2,
			},
			{
				tag: "#b",
				count: 5,
			},
		]);
	});
});

/*
 * root ("TA root #taRoot")
 *   one per FIXTURE_NAMES entry
 * outside ("Outside #taOutside #taZebra")
 * deleted ("Deleted #taGone", no longer live)
 */
function setupDb()
{
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	bindTreeHost(db, nodeTreeHost(sqlite));
	migrate(
		db,
		{
			migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations"),
		},
	);
	const seededAt = "2026-01-01 00:00:00.000";
	const rows:
	{
		id: string;
		parentId: string | null;
		name: string;
		systemTo?: string;
	}[] = [
		{
			id: "root",
			parentId: null,
			name: "TA root #taRoot",
		},
		...FIXTURE_NAMES.map((name, index) => (
		{
			id: `child-${index}`,
			parentId: "root",
			name,
		})),
		{
			id: "outside",
			parentId: null,
			name: "Outside #taOutside #taZebra",
		},
		{
			id: "deleted",
			parentId: "root",
			name: "Deleted #taGone",
			systemTo: "2026-02-01 00:00:00.000",
		},
	];
	for (const {id, parentId, name, systemTo = FAR_FUTURE_DATE} of rows)
	{
		db.insert(nodeContent)
			.values(
				{
					id,
					name,
					note: null,
					parentId,
					systemFrom: seededAt,
					systemTo,
				},
			)
			.run();
	}
	ensureNodeTags(db);
	return db;
}

function setup(db = setupDb())
{
	const ctx =
	{
		db,
		cacheService: new CacheService(db),
	} as unknown as ServerContext;
	return httpAppFor(ctx);
}

async function getTags(app: ReturnType<typeof httpAppFor>, query: string): Promise<string[]>
{
	const response = await app.fetch(new Request(`http://x/api/v1/tags/autocomplete?${query}`));
	if (response.status !== 200)
	{
		throw new Error(await response.text());
	}
	const body = (await response.json()) as
	{
		tags: TagCount[];
	};
	return asPairs(body.tags);
}

describe("GET /api/v1/tags/autocomplete", () =>
{
	it("ranks the zoomed subtree including the root's own text, without fallback", async () =>
	{
		await expect(getTags(setup(), "root=root&prefix=%23&limit=8&fallback=0")).resolves.toStrictEqual([
			"#taZebra:3",
			"#taApple:2",
			"#ta:sub:key:1",
			"#taBold:1",
			"#taDot:1",
			"#taParen:1",
			"#taRoot:1",
			"#1234:1",
		]);
	});

	it("fills from the whole tree when the subtree has fewer than the limit", async () =>
	{
		await expect(getTags(setup(), "root=root&prefix=%23taZ&limit=8")).resolves.toStrictEqual(["#taZebra:3"]);
		await expect(getTags(setup(), "root=child-0&prefix=%23ta&limit=3")).resolves.toStrictEqual([
			"#taZebra:1",
			"#taApple:2",
			"#ta:sub:key:1",
		]);
	});

	it("ranks the whole live tree at Home", async () =>
	{
		await expect(getTags(setup(), "prefix=%23taO")).resolves.toStrictEqual(["#taOutside:1"]);
		await expect(getTags(setup(), "prefix=%23taZ")).resolves.toStrictEqual(["#taZebra:4"]);
		await expect(getTags(setup(), "prefix=%23taG")).resolves.toStrictEqual([]);
	});
});

describe("GET /api/v1/tags/autocomplete and code blocks", () =>
{
	it("counts no tag from a code-block row, in the subtree or the whole tree", async () =>
	{
		const db = setupDb();
		const at = "2026-01-02 00:00:00.000";
		db.insert(nodeContent)
			.values(
				{
					id: "code",
					name: "#taCodeOnly #taZebra",
					note: null,
					parentId: "root",
					systemFrom: at,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		db.insert(nodeMetadata)
			.values(
				{
					nodeId: "code",
					layoutMode: "code-block",
					systemFrom: at,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		db.run(sql`DELETE FROM node_tags`);
		ensureNodeTags(db);
		expect([
			await getTags(setup(db), "prefix=%23taC"),
			await getTags(setup(db), "root=root&prefix=%23taC&fallback=0"),
			await getTags(setup(db), "prefix=%23taZ"),
		]).toStrictEqual([[], [], ["#taZebra:4"]]);
	});
});

describe("GET /api/v1/tags/autocomplete with the edited item's live text", () =>
{
	it("counts the edited item's live name instead of its saved one, as upstream's per-keystroke tag counts do", async () =>
	{
		const live = new URLSearchParams(
			{
				root: "root",
				prefix: "#taZ",
				fallback: "0",
				item: "child-0",
				name: "Alpha #taZoo",
			},
		);
		await expect(getTags(setup(), live.toString())).resolves.toStrictEqual(["#taZebra:2", "#taZoo:1"]);
	});

	it("counts the edited item's live note alongside its saved name", async () =>
	{
		const live = new URLSearchParams(
			{
				prefix: "#taZ",
				item: "child-0",
				note: "#taZoo",
			},
		);
		await expect(getTags(setup(), live.toString())).resolves.toStrictEqual(["#taZebra:4", "#taZoo:1"]);
	});

	it("swaps a saved tag for the in-progress one the live name has instead", async () =>
	{
		const live = new URLSearchParams(
			{
				prefix: "#taA",
				item: "child-1",
				name: "Beta #taZebra #taA",
			},
		);
		await expect(getTags(setup(), live.toString())).resolves.toStrictEqual(["#taA:1", "#taApple:1"]);
	});
});

describe("GET /api/v1/tags/autocomplete over node_tags", () =>
{
	/** Live rows in rowid order with their layout mode, the order the JS whole-tree count read them in. */
	function liveRows(db: ReturnType<typeof setupDb>, ids?: Set<string>): TaggedText[]
	{
		return db
			.select(
				{
					id: nodeContent.id,
					name: nodeContent.name,
					note: nodeContent.note,
					layoutMode: nodeMetadata.layoutMode,
				},
			)
			.from(nodeContent)
			.leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodeContent.id))
			.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
			.orderBy(sql`${nodeContent}.rowid`)
			.all()
			.filter((row) => ids === undefined || ids.has(row.id));
	}

	it("matches the JS counts at Home and zoomed, with code-block and #use-template tags", async () =>
	{
		const db = setupDb();
		const at = "2026-01-02 00:00:00.000";
		const extra = [
			{
				id: "code",
				name: "#taCode #taZebra",
				parentId: "root",
			},
			{
				id: "template",
				name: "Uses #use-template:daily #taApple",
				parentId: "root",
			},
			{
				id: "casing",
				name: "#TAAPPLE again",
				parentId: "outside",
			},
		];
		for (const {id, name, parentId} of extra)
		{
			db.insert(nodeContent)
				.values(
					{
						id,
						name,
						note: null,
						parentId,
						systemFrom: at,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		db.insert(nodeMetadata)
			.values(
				{
					nodeId: "code",
					layoutMode: "code-block",
					systemFrom: at,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
		db.run(sql`DELETE FROM node_tags`);
		ensureNodeTags(db);
		const app = setup(db);
		const all =
		{
			prefix: "#",
			limit: 100,
		};
		const subtree = new Set(["root", "code", "template", ...FIXTURE_NAMES.map((_, index) => `child-${index}`)]);
		const pairs = (rows: TaggedText[]) => asPairs(rankTags(rows, all));

		expect(
			{
				home: await getTags(app, "prefix=%23&limit=100"),
				zoomed: await getTags(app, "root=root&prefix=%23&limit=100&fallback=0"),
			},
		).toStrictEqual(
			{
				home: pairs(liveRows(db)),
				zoomed: pairs(liveRows(db, subtree)),
			},
		);
	});

	it("drops a tag from node_tags and the counts when an edit removes it", async () =>
	{
		const db = setupDb();
		const cache = new CacheService(db);
		const app = setup(db);
		const before = await getTags(app, "prefix=%23taO");

		cache.insertNode(
			{
				id: "outside",
				name: "Outside #taZebra",
				note: null,
				parent_id: null,
				priority: 1,
				createdAt: 1,
				modifiedAt: 1,
			},
			null,
		);

		expect(
			{
				before,
				after: await getTags(app, "prefix=%23taO"),
				rows: db.all(sql`SELECT tag FROM node_tags WHERE node_id = 'outside' ORDER BY tag`),
			},
		).toStrictEqual(
			{
				before: ["#taOutside:1"],
				after: [],
				rows: [
					{
						tag: "#taZebra",
					},
				],
			},
		);
	});
});
