import {WorkflowyInternalClient} from "../api/workflowy-internal-client.js";
import type {WorkflowyWriteThroughClient} from "../cache/workflowy-write-through-client.js";
import {WorkflowyInternalAdapter} from "../internal/adapter.js";
import type {BacklinkSync, LinkedSources, WorkflowyInternalAdapterOptions} from "../internal/adapter.js";
import {hasInternalLink} from "../workflowy/internal-links.js";
import {readInternalAuth} from "./session-store.js";

type Database = WorkflowyInternalAdapterOptions["db"];

/**
 * Bring the backlinks of `sourceIds` in line with their internal links, as
 * upstream's client does after a create or edit, when `texts` (the sources'
 * text before and after the write) hold any link: only a link added or
 * removed can change backlinks. Needs the internal API; undefined without it
 * or without a link.
 */
export async function syncBacklinksIfLinked(
	sourceIds: string[],
	texts: (string | null | undefined)[],
	database: Database,
	writeThrough: WorkflowyWriteThroughClient,
): Promise<BacklinkSync | undefined> {
	if (sourceIds.length === 0 || !hasInternalLink(texts.join(" "))) {
		return undefined;
	}
	const adapter = internalAdapter(database, writeThrough);
	if (adapter === undefined) {
		process.stderr.write(
			"Warning: the text links to other items, but no internal session is configured, so no backlinks were created or removed. Run 'internal login' or set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD.\n",
		);
		return undefined;
	}
	return adapter.syncBacklinks(sourceIds);
}

/**
 * After a delete, remove the backlink items of the deleted `linked` sources, as
 * upstream's client does; pass `linkedSourcesInSubtree` read before the
 * delete. Needs the internal API; does nothing without it or without a source.
 */
export async function deleteBacklinksOfDeleted(
	linked: LinkedSources,
	database: Database,
	writeThrough: WorkflowyWriteThroughClient,
): Promise<string[]> {
	if (linked.ids.length === 0) {
		return [];
	}
	const adapter = internalAdapter(database, writeThrough);
	if (adapter === undefined) {
		process.stderr.write(
			"Warning: the deleted items may have backlinks, but no internal session is configured, so their backlink items were not deleted. Run 'internal login' or set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD.\n",
		);
		return [];
	}
	return adapter.deleteBacklinksOf(linked);
}

/** An internal-API adapter over the cache, or undefined without configured internal auth. */
export function internalAdapter(
	database: Database,
	writeThrough: WorkflowyWriteThroughClient,
): WorkflowyInternalAdapter | undefined {
	const auth = readInternalAuth();
	return auth
		? new WorkflowyInternalAdapter({client: new WorkflowyInternalClient(auth), db: database, writeThrough})
		: undefined;
}
