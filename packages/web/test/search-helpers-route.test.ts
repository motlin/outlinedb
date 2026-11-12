import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {nodeTreeHost} from "../src/server/node-host.js";
import {bindTreeHost} from "../src/server/tree-snapshot.js";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import {nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {SO_ROWS} from "../../shared/test/helpers/search-so-fixture.js";
import {collectHelperTags} from "../src/server/helper-tags.js";
import {loadHelperTags} from "../src/server/ops/search.js";

const SO_TEXT = SO_ROWS.map((item) => (
{
	name: item.nameHtml,
	note: item.noteHtml,
}));

function row(name: string, note: string | null = null)
{
	return {
		name,
		note,
	};
}

describe("collectHelperTags", () =>
{
	it("lists the #tags and @tags of the SO fixture", () =>
	{
		expect(collectHelperTags(SO_TEXT)).toStrictEqual(
			{
				hashTags: ["#soTag"],
				atTags: ["@soPerson"],
			},
		);
	});

	it("orders by count descending, then case-insensitive alphabetical", () =>
	{
		expect(collectHelperTags([...SO_TEXT, row("Again #soTag"), row("Last #zeta")])).toStrictEqual(
			{
				hashTags: ["#soTag", "#zeta"],
				atTags: ["@soPerson"],
			},
		);
		expect(collectHelperTags([row("#beta #Alpha @b @A")])).toStrictEqual(
			{
				hashTags: ["#Alpha", "#beta"],
				atTags: ["@A", "@b"],
			},
		);
	});

	it("keeps the casing of the first occurrence and counts case-insensitively", () =>
	{
		expect(
			collectHelperTags([row("#Zeta"), row("#zeta"), row("#zeta"), row("#alpha"), row("#alpha")]),
		).toStrictEqual(
			{
				hashTags: ["#Zeta", "#alpha"],
				atTags: [],
			},
		);
	});

	it("reads tags from notes and plain text, ignoring markup, URLs and null text", () =>
	{
		expect(
			collectHelperTags([
				row("<b>#bold</b> text", "note @noter"),
				row("see https://example.com/#anchor", null),
				row("", null),
			]),
		).toStrictEqual(
			{
				hashTags: ["#bold"],
				atTags: ["@noter"],
			},
		);
	});

	it("limits each list to 1000 tags", () =>
	{
		const rows = Array.from(
			{
				length: 1001,
			},
			(_, index) => row(`#t${String(index).padStart(4, "0")}`),
		);
		const {hashTags} = collectHelperTags(rows);
		expect(
			{
				length: hashTags.length,
				last: hashTags.at(-1),
			},
		).toStrictEqual(
			{
				length: 1000,
				last: "#t0999",
			},
		);
	});
});

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

/*
 * root #rootTag
 *   a #inside
 *     a1 @deep
 *   deleted #gone (no longer live)
 * other #outside
 */
const TREE: [id: string, parentId: string | null, name: string][] = [
	["root", null, "Root #rootTag"],
	["a", "root", "Alpha #inside"],
	["a1", "a", "Alpha child @deep"],
	["other", null, "Other #outside"],
];

const open: DatabaseConstructor.Database[] = [];
afterEach(() =>
{
	for (const sqlite of open.splice(0))
	{
		sqlite.close();
	}
});

function setup()
{
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
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
			migrationsFolder,
		},
	);
	for (const [id, parentId, name] of TREE)
	{
		db.insert(nodeContent)
			.values(
				{
					id,
					name,
					note: null,
					parentId,
					systemFrom: SEEDED_AT,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	}
	db.insert(nodeContent)
		.values(
			{
				id: "deleted",
				name: "Gone #gone",
				note: null,
				parentId: "root",
				systemFrom: SEEDED_AT,
				systemTo: SEEDED_AT,
			},
		)
		.run();
	return db;
}

describe("loadHelperTags", () =>
{
	it("lists the tags of live descendants of the root, excluding the root", () =>
	{
		expect(loadHelperTags(setup(), "root")).toStrictEqual(
			{
				hashTags: ["#inside"],
				atTags: ["@deep"],
			},
		);
	});

	it("lists the whole tree when rootId is empty", () =>
	{
		expect(loadHelperTags(setup(), "")).toStrictEqual(
			{
				hashTags: ["#inside", "#outside", "#rootTag"],
				atTags: ["@deep"],
			},
		);
	});
});
