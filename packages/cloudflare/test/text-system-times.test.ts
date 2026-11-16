import Database from "better-sqlite3";
import {describe, expect, it} from "vite-plus/test";
import {createWithMicrosecondSystemTimes} from "../src/text-system-times";

/** The slice of a Durable Object's SqlStorage the upgrade uses, over an in-memory better-sqlite3 database. */
function sqlStorage(db: Database.Database): SqlStorage
{
	const exec = (query: string, ...bindings: unknown[]) =>
	{
		const statement = bindings.length === 0 && query.trim().includes(";\n") ? undefined : db.prepare(query);
		if (statement === undefined)
		{
			db.exec(query);
			return [];
		}
		if (statement.reader)
		{
			return statement.all(...bindings) as Record<string, unknown>[];
		}
		statement.run(...bindings);
		return [];
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double for the two calls the upgrade makes
	return {
		exec: (query: string, ...bindings: unknown[]) =>
		{
			const rows = exec(query, ...bindings);
			return {
				toArray: () => rows,
			};
		},
	} as unknown as SqlStorage;
}

const DDL = `
CREATE TABLE IF NOT EXISTS job_state (
	phase TEXT NOT NULL,
	scanned_to INTEGER NOT NULL,
	system_from INTEGER NOT NULL,
	system_to INTEGER NOT NULL,
	PRIMARY KEY (system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS job_state_system_to_idx ON job_state (system_to);
CREATE INDEX IF NOT EXISTS job_state_closed_at_idx ON job_state (system_to) WHERE system_to < 9007199254740991;
`;

describe("createWithMicrosecondSystemTimes", () =>
{
	it("recreates a table left from text system times with integer microsecond columns, converting its rows and indexes", () =>
	{
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE job_state (
				phase TEXT NOT NULL,
				scanned_to TEXT NOT NULL,
				system_from TEXT NOT NULL,
				system_to TEXT NOT NULL,
				PRIMARY KEY (system_from)
			);
			CREATE UNIQUE INDEX job_state_system_to_idx ON job_state (system_to);
			CREATE INDEX job_state_closed_at_idx ON job_state (system_to) WHERE system_to < '9999-12-31 23:59:59';
			INSERT INTO job_state VALUES
				('backfilling', '2026-02-01 00:00:04.000', '2026-02-01 00:00:05.123', '2026-02-01 00:00:06.000'),
				('ready', '2026-02-01 00:00:05.500', '2026-02-01 00:00:06.000', '9999-12-31 23:59:59');
		`);

		createWithMicrosecondSystemTimes(
			sqlStorage(db),
			DDL,
			["job_state"],
			new Set(["scanned_to", "system_from", "system_to"]),
		);

		expect(
			{
				rows: db
					.prepare(
						"SELECT phase, scanned_to, system_from, system_to, typeof(system_from) AS fromType FROM job_state ORDER BY system_from",
					)
					.all(),
				schema: db
					.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
					.all()
					.map((row) =>
						Object.values(row as Record<string, string>).map((text) => text.replaceAll(/\s+/gu, " ")),
					),
			},
		).toStrictEqual(
			{
				rows: [
					{
						phase: "backfilling",
						scanned_to: 1_769_904_004_000_000,
						system_from: 1_769_904_005_123_000,
						system_to: 1_769_904_006_000_000,
						fromType: "integer",
					},
					{
						phase: "ready",
						scanned_to: 1_769_904_005_500_000,
						system_from: 1_769_904_006_000_000,
						system_to: Number.MAX_SAFE_INTEGER,
						fromType: "integer",
					},
				],
				schema: [
					[
						"job_state",
						"CREATE TABLE job_state ( phase TEXT NOT NULL, scanned_to INTEGER NOT NULL, system_from INTEGER NOT NULL, system_to INTEGER NOT NULL, PRIMARY KEY (system_from) )",
					],
					[
						"job_state_closed_at_idx",
						"CREATE INDEX job_state_closed_at_idx ON job_state (system_to) WHERE system_to < 9007199254740991",
					],
					["job_state_system_to_idx", "CREATE UNIQUE INDEX job_state_system_to_idx ON job_state (system_to)"],
				],
			},
		);
		db.close();
	});

	it("leaves a table already on integer system times as it is", () =>
	{
		const db = new Database(":memory:");
		db.exec(DDL);
		db.prepare("INSERT INTO job_state VALUES ('ready', 1, 2, 9007199254740991)").run();

		createWithMicrosecondSystemTimes(
			sqlStorage(db),
			DDL,
			["job_state"],
			new Set(["scanned_to", "system_from", "system_to"]),
		);

		expect(db.prepare("SELECT * FROM job_state").all()).toStrictEqual([
			{
				phase: "ready",
				scanned_to: 1,
				system_from: 2,
				system_to: Number.MAX_SAFE_INTEGER,
			},
		]);
		db.close();
	});
});
