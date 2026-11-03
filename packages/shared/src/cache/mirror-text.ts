/**
 * A mirror never has text of its own: Workflowy renders it with its original's
 * name and note. The REST API and backups can still return stale text stored on
 * a mirror node (left by old writes to the mirror id), so readers ignore any
 * text on a mirror row and use the original's instead.
 */
import type {AppDatabase} from "../db/types.js";
import {mirrors, nodeContent} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {and, eq, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import type {AnySQLiteColumn} from "drizzle-orm/sqlite-core";
import {currentVersion} from "./cache-temporal.js";
import {inIds} from "./in-ids.js";

type Database = AppDatabase;

interface TextRow {
	id: string;
	name: string | null;
	note: string | null;
}

/** Map each current mirror among `nodeIds` to its original's id. */
export function loadMirrorOriginals(database: Database, nodeIds: string[]): Map<string, string> {
	const originals = new Map<string, string>();
	const rows = database
		.select({mirrorId: mirrors.mirrorId, originalId: mirrors.originalId})
		.from(mirrors)
		.where(and(inIds(mirrors.mirrorId, nodeIds), currentVersion(mirrors)))
		.all();
	for (const row of rows) {
		originals.set(row.mirrorId, row.originalId);
	}
	return originals;
}

/**
 * Replace each mirror row's name and note with its original's (null when the
 * original is not cached). `mirrorOriginals` maps mirror id to original id, as
 * returned by {@link loadMirrorOriginals}.
 */
export function applyMirrorText<T extends TextRow>(
	database: Database,
	rows: T[],
	mirrorOriginals: Map<string, string>,
): T[] {
	if (mirrorOriginals.size === 0) {
		return rows;
	}
	const originalIds = [...new Set(mirrorOriginals.values())];
	const originalText = new Map<string, {name: string | null; note: string | null}>();
	const originals = database
		.select({id: nodeContent.id, name: nodeContent.name, note: nodeContent.note})
		.from(nodeContent)
		.where(and(inIds(nodeContent.id, originalIds), currentVersion(nodeContent)))
		.all();
	for (const original of originals) {
		originalText.set(original.id, {name: original.name, note: original.note});
	}
	return rows.map((row) => {
		const originalId = mirrorOriginals.get(row.id);
		if (originalId === undefined) {
			return row;
		}
		const text = originalText.get(originalId);
		return {...row, name: text?.name ?? null, note: text?.note ?? null};
	});
}

/** {@link applyMirrorText} with the mirror relationships looked up from the rows' ids. */
export function withMirrorText<T extends TextRow>(database: Database, rows: T[]): T[] {
	return applyMirrorText(
		database,
		rows,
		loadMirrorOriginals(
			database,
			rows.map((row) => row.id),
		),
	);
}

/**
 * SQL condition that `idColumn` is not a current mirror. Text matching skips
 * mirrors, whose stored text is never meaningful; the original matches instead.
 */
export function notAMirror(idColumn: AnySQLiteColumn): SQL {
	return sql`NOT EXISTS (SELECT 1 FROM ${mirrors} WHERE ${mirrors.mirrorId} = ${idColumn} AND ${eq(mirrors.systemTo, FAR_FUTURE_DATE)})`;
}
