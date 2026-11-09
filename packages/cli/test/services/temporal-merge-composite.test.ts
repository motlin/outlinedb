import {beforeEach, afterEach, describe, expect, it} from "vite-plus/test";
import {joinKey, temporalMerge} from "@outlinedb/shared/cache";
import {mirrors} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import {eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {cleanupTestDatabase, createTestDatabase, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";

interface MirrorRow {
	originalId: string;
	mirrorId: string;
}

const config = {
	table: mirrors,
	keyColumns: [mirrors.originalId, mirrors.mirrorId],
	incomingKey: (r: MirrorRow) => joinKey(r.originalId, r.mirrorId),
	currentKey: (r: MirrorRow) => joinKey(r.originalId, r.mirrorId),
	contentMatches: () => true,
	buildInsertRow: (r: MirrorRow) => ({originalId: r.originalId, mirrorId: r.mirrorId}),
};

function currentMirrors(db: TestDatabase): MirrorRow[] {
	return db.db
		.select({originalId: mirrors.originalId, mirrorId: mirrors.mirrorId})
		.from(mirrors)
		.where(eq(mirrors.systemTo, FAR_FUTURE_DATE))
		.all();
}

describe("temporalMerge with a composite key", () => {
	let tempDir: string;
	let testDatabase: TestDatabase;
	const from = formatTemporalTimestamp(new Date(Date.now() - 1000));

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-merge-test-"));
		testDatabase = createTestDatabase(path.join(tempDir, "test.sqlite"));
	});
	afterEach(() => {
		cleanupTestDatabase(testDatabase);
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	it("inserts new rows, phases out absent ones, leaves unchanged untouched", () => {
		seedTestData(testDatabase, {
			mirrors: [
				{originalId: "A", mirrorId: "X", systemFrom: from, systemTo: FAR_FUTURE_DATE},
				{originalId: "B", mirrorId: "Y", systemFrom: from, systemTo: FAR_FUTURE_DATE},
			],
		});

		const now = formatTemporalTimestamp(new Date());
		const result = testDatabase.db.transaction((tx) =>
			temporalMerge(
				tx,
				config,
				[
					{originalId: "A", mirrorId: "X"}, // unchanged
					{originalId: "C", mirrorId: "Z"}, // new
				],
				currentMirrors(testDatabase),
				now,
			),
		);

		expect(result).toStrictEqual({inserted: 1, phasedOut: 1, unchanged: 1});
		const open = currentMirrors(testDatabase)
			.map((m) => `${m.originalId}/${m.mirrorId}`)
			.toSorted();
		expect(open).toStrictEqual(["A/X", "C/Z"]); // B/Y phased out
	});

	it("keeps preserved keys open even when they are absent from the incoming set", () => {
		seedTestData(testDatabase, {
			mirrors: [
				{originalId: "A", mirrorId: "X", systemFrom: from, systemTo: FAR_FUTURE_DATE},
				{originalId: "B", mirrorId: "Y", systemFrom: from, systemTo: FAR_FUTURE_DATE},
			],
		});

		const now = formatTemporalTimestamp(new Date());
		const result = testDatabase.db.transaction((tx) =>
			temporalMerge(
				tx,
				{...config, preserveKeys: new Set([joinKey("B", "Y")])},
				[{originalId: "A", mirrorId: "X"}],
				currentMirrors(testDatabase),
				now,
			),
		);

		expect(result).toStrictEqual({inserted: 0, phasedOut: 0, unchanged: 1});
		const open = currentMirrors(testDatabase)
			.map((m) => `${m.originalId}/${m.mirrorId}`)
			.toSorted();
		expect(open).toStrictEqual(["A/X", "B/Y"]);
	});

	it('does not collide keys that a naive ":" separator would merge', () => {
		// Under `${originalId}:${mirrorId}` both rows hash to "a:b:c".
		seedTestData(testDatabase, {
			mirrors: [
				{originalId: "a", mirrorId: "b:c", systemFrom: from, systemTo: FAR_FUTURE_DATE},
				{originalId: "a:b", mirrorId: "c", systemFrom: from, systemTo: FAR_FUTURE_DATE},
			],
		});

		const now = formatTemporalTimestamp(new Date());
		const result = testDatabase.db.transaction((tx) =>
			temporalMerge(tx, config, [{originalId: "a", mirrorId: "b:c"}], currentMirrors(testDatabase), now),
		);

		// Only {a, b:c} survives; {a:b, c} is a distinct key and gets phased out.
		expect(result).toStrictEqual({inserted: 0, phasedOut: 1, unchanged: 1});
		const open = currentMirrors(testDatabase).map((m) => `${m.originalId}/${m.mirrorId}`);
		expect(open).toStrictEqual(["a/b:c"]);
	});
});
