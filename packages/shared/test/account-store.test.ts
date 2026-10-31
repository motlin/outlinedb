import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {readAccountState, writeAccountState} from "../src/cache/account-seed.js";
import {
	parseAccountState,
	readAccountRows,
	readAccountSnapshot,
	readImportTime,
	readWorkflowyEpoch,
	seedAccount,
	writeAccountSnapshot,
} from "../src/cache/account-store.js";
import {replaceExpansion} from "../src/cache/expansion-store.js";
import type {AccountSnapshot} from "../src/cache/account-store.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import * as schema from "../src/db/schema.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");

function snapshot(rootMetadata: Record<string, unknown>, settings: Record<string, unknown> = {}): AccountSnapshot {
	return {account: {userId: 1, dateJoinedSec: 1_324_752_241}, rootMetadata, settings, visibleFeatures: []};
}

describe("account store", () => {
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});
	function database() {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		return db;
	}
	function write(db: ReturnType<typeof database>, value: AccountSnapshot) {
		runUnitOfWork(db, (unitOfWork) => {
			writeAccountSnapshot(unitOfWork, value);
		});
	}

	it("reads nothing before any account import", () => {
		expect(readAccountSnapshot(database())).toBeUndefined();
	});

	it("reads the Workflowy epoch from the live account row's join date", () => {
		const db = database();
		const before = readWorkflowyEpoch(db);
		write(db, snapshot({}));
		expect({before, after: readWorkflowyEpoch(db)}).toStrictEqual({before: undefined, after: 1_324_752_241});
	});

	it("seeds only the account row, which a later full account write replaces", () => {
		const db = database();
		runUnitOfWork(db, (unitOfWork) => {
			seedAccount(unitOfWork, {userId: 0, dateJoinedSec: 1_324_752_241});
		});
		const seeded = readAccountRows(db);
		write(db, {...snapshot({}), account: {userId: 107, dateJoinedSec: 1_324_752_241, fullName: "Alice Smith"}});
		expect({seeded: seeded.account, written: readAccountRows(db).account}).toStrictEqual({
			seeded: [
				{
					userId: 0,
					fullName: null,
					dateJoinedSec: 1_324_752_241,
					entropyKey: null,
					username: null,
					email: null,
				},
			],
			written: [
				{
					userId: 107,
					fullName: "Alice Smith",
					dateJoinedSec: 1_324_752_241,
					entropyKey: null,
					username: null,
					email: null,
				},
			],
		});
	});

	it("round-trips the stars with an order, one star_order row per entry, unordered stars kept", () => {
		const db = database();
		const starring = {
			locations: {n1: "None", "n2_q ": "None", n3: "None"},
			order: "None/n2/q ,None/n1/",
		};

		write(db, snapshot({starring}));

		expect({
			starring: readAccountSnapshot(db)?.rootMetadata.starring,
			order: readAccountRows(db).starOrder,
		}).toStrictEqual({
			starring,
			order: [
				{position: 0, entry: "None/n2/q "},
				{position: 1, entry: "None/n1/"},
			],
		});
	});

	it("round-trips the stars without an order, leaving the order absent", () => {
		const db = database();

		write(db, snapshot({starring: {locations: {n1: "None"}}}));

		expect({
			starring: readAccountSnapshot(db)?.rootMetadata.starring,
			order: readAccountRows(db).starOrder,
		}).toStrictEqual({starring: {locations: {n1: "None"}}, order: []});
	});

	it("re-versions only the rows a write changes", () => {
		const db = database();
		write(db, snapshot({color: {tags: {"#a": 1, "#b": 2}}, dateFormat: "YYYY"}));

		write(db, snapshot({color: {tags: {"#a": 1, "#b": 3}}, dateFormat: "YYYY"}));

		const tags = db
			.select({
				tag: schema.tagColors.tag,
				colorIndex: schema.tagColors.colorIndex,
				systemTo: schema.tagColors.systemTo,
			})
			.from(schema.tagColors)
			.orderBy(schema.tagColors.tag, schema.tagColors.systemFrom)
			.all()
			.map((row) => [row.tag, row.colorIndex, row.systemTo === "9999-12-31 23:59:59"]);
		expect({
			tags,
			preferenceVersions: db.select().from(schema.rootPreferences).all().length,
		}).toStrictEqual({
			tags: [
				["#a", 1, true],
				["#b", 2, false],
				["#b", 3, true],
			],
			preferenceVersions: 1,
		});
	});

	it("stores flags as 0/1 whether upstream sends booleans or yes/no, and reads them back as booleans", () => {
		const db = database();

		write(db, snapshot({}, {show_completed: "yes", ignore_loom: "no", backup_to_dropbox: true}));

		expect({
			row: readAccountRows(db).accountSettings.map(({showCompleted, ignoreLoom, backupToDropbox}) => ({
				showCompleted,
				ignoreLoom,
				backupToDropbox,
			})),
			settings: readAccountSnapshot(db)?.settings,
		}).toStrictEqual({
			row: [{showCompleted: 1, ignoreLoom: 0, backupToDropbox: 1}],
			settings: {show_completed: true, ignore_loom: false, backup_to_dropbox: true},
		});
	});

	it("seeds another database from the account state sent as JSON, expansion included", () => {
		const source = database();
		write(
			source,
			snapshot({starring: {locations: {n1: "None"}, order: "None/n1/"}, dateFormat: "YYYY"}, {theme: "dark"}),
		);
		runUnitOfWork(source, (unitOfWork) => {
			replaceExpansion(unitOfWork, ["bbbbbbbb", "aaaaaaaa"], 1000);
		});
		const target = database();

		const wire = JSON.stringify(readAccountState(source));
		const state = parseAccountState(JSON.parse(wire));
		if (state === undefined) {
			throw new Error("the state did not parse");
		}
		runUnitOfWork(target, (unitOfWork) => {
			writeAccountState(unitOfWork, state, 5_000_000);
		});

		expect({
			snapshot: readAccountSnapshot(target),
			state: readAccountState(target),
			fetchedAt: readImportTime(target, "account"),
		}).toStrictEqual({
			snapshot: readAccountSnapshot(source),
			state: readAccountState(source),
			fetchedAt: 5_000_000,
		});
	});

	it("rejects an account state with an unknown table, an unknown or temporal column, or a mistyped value", () => {
		const db = database();
		write(db, snapshot({}));
		const wire = JSON.stringify(readAccountState(db));
		const valid = JSON.parse(wire) as {rows: Record<string, unknown[]>};
		const withRows = (name: string, rows: unknown[]) => ({...valid, rows: {...valid.rows, [name]: rows}});

		expect([
			parseAccountState(valid) !== undefined,
			parseAccountState({...valid, rows: {...valid.rows, bogus: []}}),
			parseAccountState(withRows("tagColors", [{tag: "#a", colorIndex: 1, extra: 1}])),
			parseAccountState(withRows("tagColors", [{tag: "#a", colorIndex: 1, systemFrom: "x"}])),
			parseAccountState(withRows("tagColors", [{tag: "#a", colorIndex: "1"}])),
			parseAccountState(withRows("tagColors", [{tag: "#a"}])),
			parseAccountState({...valid, expandedKeys: [1]}),
		]).toStrictEqual([true, undefined, undefined, undefined, undefined, undefined, undefined]);
	});
});
