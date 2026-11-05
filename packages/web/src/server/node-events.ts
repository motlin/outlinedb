/**
 * Tree-change events for open outline tabs.
 *
 * A tab only refreshes outline data after its own writes, so a change made by
 * another tab, the CLI's shared database, or an upstream catch-up stayed
 * invisible until reload. This bus announces each committed unit of work that
 * wrote, and the socket in `node-events-socket.ts` forwards it; a tab then runs
 * one `/api/v1/nodes/changes` read. The frame is only a nudge, like upstream's
 * signal socket: it carries the watermark, never tree data.
 */

import {sql} from "drizzle-orm";
import type {AppDatabase} from "@workflowy/shared/db";
import {changeWatermark} from "./system-changes.js";

export interface TreeChangedEvent {
	type: "tree.changed";
	/** The changes-feed watermark at publish time (see `changeWatermark`). */
	latest: string;
}

export type TreeChangeListener = (event: TreeChangedEvent) => void;

export class TreeEventBus {
	readonly #listeners = new Set<TreeChangeListener>();

	subscribe(listener: TreeChangeListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	publish(latest: string): void {
		const event: TreeChangedEvent = {type: "tree.changed", latest};
		// Copied: a throwing listener is dropped, and a listener may unsubscribe itself mid-notification.
		// oxlint-disable-next-line no-useless-spread
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch {
				// A listener writing to a socket that just closed must not take the rest down.
				this.#listeners.delete(listener);
			}
		}
	}
}

function totalChanges(database: AppDatabase): number {
	return database.get<{changes: number}>(sql`SELECT total_changes() AS changes`).changes;
}

/**
 * Runs `run`, then publishes one change when it wrote through `database`'s connection. Published even when `run`
 * throws after writing, since rows it committed before failing are still visible to the changes feed.
 */
export async function withTreeChangePublish<T>(
	database: AppDatabase,
	bus: TreeEventBus,
	run: () => Promise<T>,
	now: () => string = changeWatermark,
): Promise<T> {
	const before = totalChanges(database);
	try {
		return await run();
	} finally {
		if (totalChanges(database) !== before) {
			bus.publish(now());
		}
	}
}
