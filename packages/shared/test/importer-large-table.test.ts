import {applyRows, runUnitOfWork} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {describe, expect, it} from "vite-plus/test";
import {buildTestDb} from "./helpers/round-trip-helpers.js";

/** More current rows than V8 accepts as spread call arguments. */
const ROW_COUNT = 250_000;

describe("applyRows on a large table", () => {
	it("merges against more current rows than fit in one call's argument list", () => {
		const {database, sqlite} = buildTestDb();
		const insert = sqlite.prepare(
			"INSERT INTO node_content (id, name, note, parent_id, system_from, system_to) VALUES (?, ?, NULL, NULL, ?, ?)",
		);
		const rows = Array.from({length: ROW_COUNT}, (_, index) => ({id: `node-${index}`, name: `Node ${index}`}));
		sqlite.transaction(() => {
			for (const row of rows) {
				insert.run(row.id, row.name, "2026-10-01 00:00:00", FAR_FUTURE_DATE);
			}
		})();

		const result = runUnitOfWork(
			database,
			(unitOfWork) =>
				applyRows(unitOfWork, {nodeContent: rows.map((row) => ({...row, note: null, parentId: null}))}),
			{systemTime: "2026-10-28 00:00:00", startedAt: Date.now()},
		);

		expect(result).toStrictEqual({nodeContent: {inserted: 0, phasedOut: 0, unchanged: ROW_COUNT}});
	});
});
