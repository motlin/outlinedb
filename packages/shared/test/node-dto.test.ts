import {NodeReader} from "@outlinedb/shared/cache";
import {describe, expect, it} from "vite-plus/test";
import {buildTestDb, bulkImportWithWatermarkGuard, loadFixtureBackup} from "./helpers/round-trip-helpers.js";

/**
 * Phase 4d: snapshot test for the canonical `Node` DTO.
 *
 * `NodeReader` is the single construction site for the canonical `Node` type
 * (`packages/shared/src/types/node.ts`). This test imports a known fixture
 * node and snapshots `NodeReader.getById`'s output. Any unintentional change
 * to the canonical shape — a renamed field, a dropped field, a changed
 * defaulting rule — makes the snapshot diverge and forces the developer to
 * explicitly run `vitest -u` to accept it. It does not prevent the shape from
 * evolving; it makes the evolution a deliberate, reviewed act rather than a
 * silent drift.
 *
 * Everything runs in a single Vitest process against an in-memory SQLite
 * database, building on the Phase 4a infrastructure (`buildTestDb`).
 */
describe("canonical Node DTO snapshot", () => {
	it("matches the snapshotted shape for a known fixture node", () => {
		const {database, sqlite} = buildTestDb();
		const importedAt = new Date("2026-05-22T10:00:00Z");

		const imported = bulkImportWithWatermarkGuard(database, loadFixtureBackup("small-backup"), importedAt);
		expect(imported.skipped).toBe(false);

		const reader = new NodeReader(database);
		// The "Ship Phase 4" node carries every populated field: name, note,
		// created/modified/completed timestamps, a non-zero priority, and a
		// parent id — making it the most informative shape to snapshot.
		const node = reader.getById("33333333-3333-3333-3333-333333333333");
		if (node === null) {
			throw new Error("NodeReader returned null for the fixture node");
		}

		expect(node).toMatchSnapshot();

		sqlite.close();
	});
});
