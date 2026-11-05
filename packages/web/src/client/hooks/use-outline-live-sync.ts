/**
 * Keeps an open tab's outline in step with tree changes made elsewhere: another tab, the CLI, or the server's upstream
 * catch-up. The server sends one `{"type":"tree.changed"}` frame on `GET /api/v1/nodes/events` per committed tree
 * write, and each frame is answered with one change-feed read (`syncNodeChanges`). Frames in the same tick share one
 * read, and frames that arrive during a read queue at most one more. A dropped socket reconnects on upstream's backoff
 * and reads once on reopening; while it is down, the tab reads when it becomes visible.
 */

import {useQueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import {syncNodeChanges} from "./use-nodes.js";

/** Upstream's reconnect delay: `(1000 + rand * 4000) * 2^failures`, capped at 3 minutes. */
function reconnectDelayMs(failures: number, random: number): number {
	return Math.min((1000 + random * 4000) * 2 ** failures, 180_000);
}

const OPEN = 1;

/** Open the events socket and sync on its frames, reconnects and visibility; returns the teardown. */
function startOutlineLiveSync(sync: () => Promise<void>): () => void {
	const state = {
		disposed: false,
		socket: undefined as WebSocket | undefined,
		opened: false,
		failures: 0,
		reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
		dirty: false,
		draining: false,
	};

	const drain = async () => {
		state.draining = true;
		// Let the rest of this tick's frames join this read.
		await Promise.resolve();
		while (state.dirty && !state.disposed) {
			state.dirty = false;
			try {
				// oxlint-disable-next-line no-await-in-loop -- reads run one at a time by design.
				await sync();
			} catch (error) {
				console.error("Failed to sync tree changes", error);
			}
		}
		state.draining = false;
	};
	const requestSync = () => {
		state.dirty = true;
		if (!state.draining) {
			void drain();
		}
	};

	const connect = () => {
		const protocol = globalThis.location.protocol === "https:" ? "wss" : "ws";
		const socket = new WebSocket(`${protocol}://${globalThis.location.host}/api/v1/nodes/events`);
		state.socket = socket;
		socket.addEventListener("open", () => {
			state.failures = 0;
			if (state.opened) {
				// Anything written while the socket was down sent no frame.
				requestSync();
			}
			state.opened = true;
		});
		socket.addEventListener("message", () => {
			requestSync();
		});
		socket.addEventListener("close", () => {
			if (state.disposed || state.socket !== socket) {
				return;
			}
			state.reconnectTimer = setTimeout(connect, reconnectDelayMs(state.failures, Math.random()));
			state.failures += 1;
		});
	};

	const onVisibilityChange = () => {
		if (document.visibilityState === "visible" && state.socket?.readyState !== OPEN) {
			requestSync();
		}
	};

	connect();
	document.addEventListener("visibilitychange", onVisibilityChange);
	return () => {
		state.disposed = true;
		clearTimeout(state.reconnectTimer);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		state.socket?.close();
	};
}

export function useOutlineLiveSync(): void {
	const queryClient = useQueryClient();
	useEffect(() => startOutlineLiveSync(async () => syncNodeChanges(queryClient)), [queryClient]);
}
