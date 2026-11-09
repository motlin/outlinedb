/**
 * Tree-change events for open outline tabs.
 *
 * A tab only refreshes outline data after its own writes, so a change made by
 * another tab, the CLI's shared database, or an upstream catch-up stayed
 * invisible until reload. This bus announces each committed unit of work that
 * wrote, and the socket in `node-events-socket.ts` forwards it; a tab then runs
 * one `/api/v1/nodes/changes` read. The frame is only a nudge, like upstream's
 * signal socket: it carries the watermark, never tree data. The same bus
 * carries `expansion.changed` frames (see {@link expansionChangePublisher}),
 * so a tab polls the expansion feed only when the stored keys moved, and `account.changed` frames (see
 * {@link accountChangePublisher}), so a tab re-reads its feature flags and preferences after a sync, import or seed.
 */

import {sql} from "drizzle-orm";
import type {AppDatabase} from "@outlinedb/shared/db";
import {changeWatermark} from "./system-changes.js";

export interface TreeChangedEvent {
	type: "tree.changed";
	/** The changes-feed watermark at publish time (see `changeWatermark`). */
	latest: string;
}

export interface ExpansionChangedEvent {
	type: "expansion.changed";
	/** The expanded keys' content version, as `GET /api/v1/expansion` answers it. */
	version: string;
}

export interface AccountChangedEvent {
	type: "account.changed";
	/** The account tables' content version (see `accountVersion`). */
	version: string;
}

export type NodeEvent = TreeChangedEvent | ExpansionChangedEvent | AccountChangedEvent;

export type TreeChangeListener = (event: NodeEvent) => void;

export class TreeEventBus {
	readonly #listeners = new Set<TreeChangeListener>();

	subscribe(listener: TreeChangeListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	publish(latest: string): void {
		this.#emit({type: "tree.changed", latest});
	}

	publishExpansion(version: string): void {
		this.#emit({type: "expansion.changed", version});
	}

	publishAccount(version: string): void {
		this.#emit({type: "account.changed", version});
	}

	#emit(event: NodeEvent): void {
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

/**
 * Returns a check that calls `publish` when `readVersion` answers a version other than the last one seen (the first
 * read is the baseline). An undefined version publishes nothing and keeps the baseline.
 */
function versionChangePublisher(publish: (version: string) => void, readVersion: () => string | undefined): () => void {
	let last = readVersion();
	return () => {
		const current = readVersion();
		if (current !== undefined && current !== last) {
			last = current;
			publish(current);
		}
	};
}

/**
 * Returns a check that publishes `expansion.changed` when `readVersion` answers a version other than the last one
 * seen (the first read is the baseline). An unseeded store (undefined) publishes nothing and keeps the baseline.
 */
export function expansionChangePublisher(bus: TreeEventBus, readVersion: () => string | undefined): () => void {
	return versionChangePublisher((version) => {
		bus.publishExpansion(version);
	}, readVersion);
}

/** Returns a check that publishes `account.changed` when the account tables' version moved since the last check. */
export function accountChangePublisher(bus: TreeEventBus, readVersion: () => string): () => void {
	return versionChangePublisher((version) => {
		bus.publishAccount(version);
	}, readVersion);
}
