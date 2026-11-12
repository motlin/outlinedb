import {eq} from "drizzle-orm";
import {whatsNewReads} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {runUnitOfWork} from "./node-composite.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/**
 * Our own What's New read state: one live `whats_new_reads` row per entry of ours the user has seen. Upstream's
 * `changelog.read` is upstream's key for upstream's entries, so ours are stored here instead.
 */

/** The ids of every entry read so far, sorted. */
export function readWhatsNewReads(tx: TemporalTransaction): string[]
{
	return tx
		.select(
			{
				entry: whatsNewReads.entry,
			},
		)
		.from(whatsNewReads)
		.where(eq(whatsNewReads.systemTo, FAR_FUTURE_DATE))
		.all()
		.map((row) => row.entry)
		.toSorted();
}

/** Record `entries` as read, inserting only those not read yet, in one unit of work. */
export function markWhatsNewRead(database: TemporalTransaction, entries: readonly string[]): void
{
	const read = new Set(readWhatsNewReads(database));
	const unread = [...new Set(entries)].filter((entry) => !read.has(entry));
	if (unread.length === 0)
	{
		return;
	}
	runUnitOfWork(database, ({tx, systemTime}) =>
	{
		for (const entry of unread)
		{
			tx.insert(whatsNewReads)
				.values(
					{
						entry,
						systemFrom: systemTime,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
	});
}
