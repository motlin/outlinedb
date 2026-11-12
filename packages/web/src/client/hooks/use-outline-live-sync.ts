/**
 * Keeps an open tab's outline in step with tree changes made elsewhere: another tab, the CLI, or the server's upstream
 * catch-up. The server sends one `{"type":"tree.changed"}` frame on `GET /api/v1/nodes/events` per committed tree
 * write, carrying the change-feed watermark at publish time, and each frame is answered with one change-feed read
 * (`syncNodeChanges`) unless an earlier read already got past that watermark, as the tab's own write's settle read
 * does for its echo. Frames in the same tick share one read, and frames that arrive during a read queue at most one more. A dropped socket reconnects on upstream's backoff
 * and reads once on reopening; while it is down, the tab reads when it becomes visible. The same socket carries
 * `{"type":"expansion.changed","version"}` frames, handed to the expansion sync instead of the tree read, and
 * `{"type":"account.changed","version"}` frames after a sync, import or seed rewrote the account tables, which re-read
 * the feature flags and preferences so a tab opened before the first sync picks them up without a reload. A socket that
 * closes without ever opening may have been refused with a 401, which the page cannot see, so it checks the sign-in.
 */

import {useQueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import {redirectIfSignedOut} from "../auth/login-redirect.js";
import {expansionVersionAnnounced} from "./use-expansion-sync.js";
import {featureKeys} from "./use-features.js";
import {preferenceKeys} from "./use-preferences.js";
import {syncNodeChanges} from "./use-nodes.js";

/** Upstream's reconnect delay: `(1000 + rand * 4000) * 2^failures`, capped at 3 minutes. */
function reconnectDelayMs(failures: number, random: number): number
{
	return Math.min((1000 + random * 4000) * 2 ** failures, 180_000);
}

const OPEN = 1;

interface VersionFrame
{
	type: "expansion.changed" | "account.changed";
	version: string;
}

/** A `tree.changed` frame's watermark, or undefined when the frame carries none (read unconditionally). */
function announcedLatest(data: unknown): string | undefined
{
	if (typeof data !== "string")
	{
		return undefined;
	}
	try
	{
		const frame: unknown = JSON.parse(data);
		return typeof frame === "object" && frame !== null && "latest" in frame && typeof frame.latest === "string"
			? frame.latest
			: undefined;
	}
	catch
	{
		return undefined;
	}
}

/** An `expansion.changed` or `account.changed` frame, or undefined for any other frame (read as a tree change). */
function versionFrame(data: unknown): VersionFrame | undefined
{
	if (typeof data !== "string")
	{
		return undefined;
	}
	try
	{
		const frame: unknown = JSON.parse(data);
		if (typeof frame !== "object" || frame === null || !("type" in frame) || !("version" in frame))
		{
			return undefined;
		}
		const {type, version} = frame;
		return (type === "expansion.changed" || type === "account.changed") && typeof version === "string"
			?
				{
					type,
					version,
				}
			: undefined;
	}
	catch
	{
		return undefined;
	}
}

/** Open the events socket and sync on its frames, reconnects and visibility; returns the teardown. */
function startOutlineLiveSync(
	sync: (announced: string | undefined) => Promise<void>,
	onExpansion: (version: string) => void,
	onAccount: () => void,
): () => void
{
	const state =
	{
		disposed: false,
		socket: undefined as WebSocket | undefined,
		opened: false,
		failures: 0,
		reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
		dirty: false,
		/** The newest watermark the pending frames announced, or undefined when a pending request must read regardless. */
		announced: undefined as string | undefined,
		draining: false,
	};

	const drain = async () =>
	{
		state.draining = true;
		// Let the rest of this tick's frames join this read.
		await Promise.resolve();
		while (state.dirty && !state.disposed)
		{
			state.dirty = false;
			const {announced} = state;
			state.announced = undefined;
			try
			{
				// oxlint-disable-next-line no-await-in-loop -- reads run one at a time by design.
				await sync(announced);
			}
			catch (error)
			{
				console.error("Failed to sync tree changes", error);
			}
		}
		state.draining = false;
	};
	/** Ask for a read; `announced` (a frame's watermark) lets it be skipped when already covered, none forces it. */
	const requestSync = (announced?: string) =>
	{
		const pending = state.dirty ? state.announced : "";
		state.announced =
			pending === undefined || announced === undefined ? undefined : pending > announced ? pending : announced;
		state.dirty = true;
		if (!state.draining)
		{
			void drain();
		}
	};

	const connect = () =>
	{
		const protocol = globalThis.location.protocol === "https:" ? "wss" : "ws";
		const socket = new WebSocket(`${protocol}://${globalThis.location.host}/api/v1/nodes/events`);
		state.socket = socket;
		let socketOpened = false;
		socket.addEventListener("open", () =>
		{
			socketOpened = true;
			state.failures = 0;
			if (state.opened)
			{
				// Anything written while the socket was down sent no frame.
				requestSync();
			}
			state.opened = true;
		});
		socket.addEventListener("message", (event: MessageEvent) =>
		{
			const frame = versionFrame(event.data);
			if (frame === undefined)
			{
				requestSync(announcedLatest(event.data));
			}
			else if (frame.type === "expansion.changed")
			{
				onExpansion(frame.version);
			}
			else
			{
				onAccount();
			}
		});
		socket.addEventListener("close", () =>
		{
			if (state.disposed || state.socket !== socket)
			{
				return;
			}
			if (!socketOpened)
			{
				void redirectIfSignedOut();
			}
			state.reconnectTimer = setTimeout(connect, reconnectDelayMs(state.failures, Math.random()));
			state.failures += 1;
		});
	};

	const onVisibilityChange = () =>
	{
		if (document.visibilityState === "visible" && state.socket?.readyState !== OPEN)
		{
			requestSync();
		}
	};

	connect();
	document.addEventListener("visibilitychange", onVisibilityChange);
	return () =>
	{
		state.disposed = true;
		clearTimeout(state.reconnectTimer);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		state.socket?.close();
	};
}

export function useOutlineLiveSync(): void
{
	const queryClient = useQueryClient();
	useEffect(
		() =>
			startOutlineLiveSync(
				async (announced) => syncNodeChanges(queryClient, announced),
				(version) =>
				{
					expansionVersionAnnounced(queryClient, version);
				},
				() =>
				{
					void queryClient.invalidateQueries(
						{
							queryKey: featureKeys.all,
						},
					);
					void queryClient.invalidateQueries(
						{
							queryKey: preferenceKeys.all,
						},
					);
				},
			),
		[queryClient],
	);
}
