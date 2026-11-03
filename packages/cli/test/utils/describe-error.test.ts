import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {describeError} from "../../src/utils/describe-error.js";

describe("describeError", () => {
	it("appends the SQLite error a DrizzleError wraps", () => {
		const database = drizzle(new DatabaseConstructor(":memory:"));
		database.run(sql`CREATE TABLE t (id TEXT, system_to TEXT, UNIQUE (id, system_to))`);
		database.run(sql`INSERT INTO t VALUES ('a', 'x'), ('a', 'y')`);

		let caught: unknown;
		try {
			database.run(sql`UPDATE t SET system_to = ${"x"} WHERE system_to = ${"y"}`);
		} catch (error) {
			caught = error;
		}

		expect(describeError(caught)).toBe(
			"DrizzleError: Failed to run the query 'UPDATE t SET system_to = ? WHERE system_to = ?'\n" +
				"  caused by SqliteError [SQLITE_CONSTRAINT_UNIQUE]: UNIQUE constraint failed: t.id, t.system_to",
		);
	});

	it("walks every level of a cause chain", () => {
		const error = new Error("outer", {cause: new TypeError("middle", {cause: "root"})});

		expect(describeError(error)).toBe("Error: outer\n  caused by TypeError: middle\n  caused by root");
	});

	it("renders a non-error value as a string", () => {
		expect(describeError("plain")).toBe("plain");
	});
});
