import {and, asc, desc, eq, gte, inArray, ne} from "drizzle-orm";
import {closeCurrentVersions} from "@outlinedb/shared/cache";
import type {TemporalTransaction} from "@outlinedb/shared/cache";
import {nodeContent, nodeLabelSuggestions} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {LabelKind} from "./label-pool.js";

/** Which Clef pass produced a score: the pass 1 shortlist, or the pass 2 verifier model. */
export type SuggestionSource = "clef" | "clef-flash" | "clef-flash-shortlist";

export interface LabelSuggestion {
	/** Canonical `#tag` or `@Name`. */
	readonly label: string;
	readonly kind: LabelKind;
	readonly source: SuggestionSource;
	readonly score: number;
}

export interface LabelHint {
	readonly label: string;
	readonly kind: LabelKind;
	readonly score: number;
	readonly source: string;
}

export interface EntryHints {
	readonly nodeId: string;
	readonly suggestions: LabelHint[];
}

/** An entry to score, with the `node_content.system_from` its text was read at. */
export interface ScoredEntry {
	readonly nodeId: string;
	readonly contentFrom: string;
}

/** Keeps each statement under the 100 bound parameters Durable Object SQLite allows. */
const ID_CHUNK = 90;
/** Eight columns per suggestion row. */
const ROW_CHUNK = 11;

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		result.push(items.slice(start, start + size));
	}
	return result;
}

/**
 * The entries among `nodeIds` that need Clef scores, in the order given: those with no live suggestion scored
 * against their live `node_content.system_from`. An edit moves `system_from`, so its old rows read as stale.
 * `force` returns every live entry. Ids without live content (deleted or unknown) are skipped.
 */
export function entriesToScore(
	tx: TemporalTransaction,
	nodeIds: readonly string[],
	{force}: {force: boolean},
): ScoredEntry[] {
	const contentFrom = new Map<string, string>();
	const fresh = new Set<string>();
	for (const ids of chunks(nodeIds, ID_CHUNK)) {
		for (const row of tx
			.select({id: nodeContent.id, systemFrom: nodeContent.systemFrom})
			.from(nodeContent)
			.where(and(inArray(nodeContent.id, ids), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.all()) {
			contentFrom.set(row.id, row.systemFrom);
		}
		if (!force) {
			for (const row of tx
				.selectDistinct({nodeId: nodeLabelSuggestions.nodeId, contentFrom: nodeLabelSuggestions.contentFrom})
				.from(nodeLabelSuggestions)
				.where(
					and(inArray(nodeLabelSuggestions.nodeId, ids), eq(nodeLabelSuggestions.systemTo, FAR_FUTURE_DATE)),
				)
				.all()) {
				if (contentFrom.get(row.nodeId) === row.contentFrom) {
					fresh.add(row.nodeId);
				}
			}
		}
	}
	return [...new Set(nodeIds)].flatMap((nodeId) => {
		const from = contentFrom.get(nodeId);
		return from === undefined || fresh.has(nodeId) ? [] : [{nodeId, contentFrom: from}];
	});
}

/**
 * Replace an entry's suggestions at `systemTime`: close every live row for the entry, then insert `suggestions`
 * as the new live rows stamped with the content version they scored. Callers run it in their transaction.
 */
export function saveLabelSuggestions(
	tx: TemporalTransaction,
	entry: ScoredEntry,
	suggestions: readonly LabelSuggestion[],
	systemTime: string,
): void {
	closeCurrentVersions(tx, nodeLabelSuggestions, systemTime, eq(nodeLabelSuggestions.nodeId, entry.nodeId));
	for (const batch of chunks(suggestions, ROW_CHUNK)) {
		const rows = batch.map((suggestion) => ({
			nodeId: entry.nodeId,
			label: suggestion.label,
			labelKind: suggestion.kind,
			source: suggestion.source,
			score: suggestion.score,
			contentFrom: entry.contentFrom,
			systemFrom: systemTime,
			systemTo: FAR_FUTURE_DATE,
		}));
		tx.insert(nodeLabelSuggestions).values(rows).run();
	}
}

/** Each entry's live verify-pass suggestions at or above `threshold`, best first, in the order given. */
export function liveHints(tx: TemporalTransaction, nodeIds: readonly string[], threshold: number): EntryHints[] {
	const byNode = new Map<string, LabelHint[]>(nodeIds.map((id) => [id, []]));
	for (const ids of chunks(nodeIds, ID_CHUNK)) {
		const rows = tx
			.select()
			.from(nodeLabelSuggestions)
			.where(
				and(
					inArray(nodeLabelSuggestions.nodeId, ids),
					eq(nodeLabelSuggestions.systemTo, FAR_FUTURE_DATE),
					ne(nodeLabelSuggestions.source, "clef-flash-shortlist"),
					gte(nodeLabelSuggestions.score, threshold),
				),
			)
			.orderBy(desc(nodeLabelSuggestions.score), asc(nodeLabelSuggestions.label))
			.all();
		for (const row of rows) {
			byNode.get(row.nodeId)?.push({
				label: row.label,
				kind: row.labelKind === "person" ? "person" : "tag",
				score: row.score,
				source: row.source,
			});
		}
	}
	return [...byNode].map(([nodeId, suggestions]) => ({nodeId, suggestions}));
}
