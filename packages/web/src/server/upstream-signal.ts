/**
 * Server-side upstream signal watcher: learn about edits made on workflowy.com
 * (or by any other client) the way the upstream web app does, and pull them
 * into the cache with one `catchUp()` push_and_poll.
 *
 * Upstream (wf-base `f80`/`Wb1`/`Q21`/`kF2`/`u80`) opens
 * `wss://workflowy.com/ws/signal/<client_id>/`, sends
 * `{type:"do.subscribe",channels:[...]}` on open, and treats a
 * `{type:"signal.entity.updated",channel:{type:"OWNER_DOCUMENT_UPDATE"}}` frame
 * as a nudge to poll. Frames carry no tree data. The reconnect delay is
 * `min((1000 + rand*4000) * 2^failures, 180s)`, a socket that is not open
 * within 10s counts as failed, and one that stays open 5s resets the failure
 * count. Upstream polls on every reconnect; this watcher also polls on the
 * first open, since the server may have been down since its last catch-up.
 */

export const SIGNAL_CONNECTION_TIMEOUT_MS = 10_000;
const SIGNAL_STABLE_CONNECTION_MS = 5000;
const SIGNAL_MAX_RECONNECT_DELAY_MS = 180_000;
/** A poll while connected, in case a nudge is ever lost. */
export const SIGNAL_SAFETY_CATCH_UP_MS = 10 * 60_000;

const SIGNAL_ORIGIN = "wss://workflowy.com";
const SUBSCRIBE_FRAME = JSON.stringify({type: "do.subscribe", channels: [{type: "OWNER_DOCUMENT_UPDATE"}]});

/** The subset of the WebSocket API the watcher uses, so tests can pass a fake. */
export interface SignalSocket {
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: {data?: unknown}) => void): void;
	send(data: string): void;
	close(): void;
}

export interface UpstreamSignalOptions {
	/** Resolve the session to connect with: the `wfclientid` from init and the `sessionid` cookie. */
	connect: () => Promise<{clientId: string; cookie: string}>;
	openSocket: (url: string, headers: Record<string, string>) => SignalSocket;
	catchUp: () => Promise<void>;
	/** Defaults to `Math.random`; fixes the per-watcher minimum reconnect delay. */
	random?: () => number;
	log?: (message: string) => void;
}

export interface UpstreamSignalWatcher {
	stop(): void;
}

/** Node's global WebSocket (undici) accepts request headers, which carry the session cookie. */
export function nodeSignalSocket(url: string, headers: Record<string, string>): SignalSocket {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the DOM lib types WebSocket without undici's WebSocketInit, which Node accepts
	const NodeWebSocket = WebSocket as unknown as new (
		url: string,
		init: {headers: Record<string, string>},
	) => WebSocket;
	return new NodeWebSocket(url, {headers});
}

function isOwnerDocumentUpdate(data: unknown): boolean {
	if (typeof data !== "string") {
		return false;
	}
	let frame: unknown;
	try {
		frame = JSON.parse(data);
	} catch {
		return false;
	}
	if (typeof frame !== "object" || frame === null) {
		return false;
	}
	const {type, channel} = frame as {type?: unknown; channel?: {type?: unknown} | null};
	return type === "signal.entity.updated" && channel?.type === "OWNER_DOCUMENT_UPDATE";
}

/**
 * Run `catchUp` so that a burst of requests gives one call in flight plus at
 * most one queued behind it; a failure is logged and never stops later calls.
 */
function coalesced(catchUp: () => Promise<void>, log: (message: string) => void): () => void {
	let inFlight: Promise<void> | undefined;
	let queued = false;
	const start = (): void => {
		inFlight = catchUp()
			.catch((error: unknown) => {
				log(`upstream signal: catch-up failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				inFlight = undefined;
				if (queued) {
					queued = false;
					start();
				}
			});
	};
	return () => {
		if (inFlight === undefined) {
			start();
		} else {
			queued = true;
		}
	};
}

export function startUpstreamSignal(options: UpstreamSignalOptions): UpstreamSignalWatcher {
	const log =
		options.log ??
		((message: string) => {
			console.warn(message);
		});
	const minimumDelay = 1000 + (options.random ?? Math.random)() * 4000;
	const requestCatchUp = coalesced(options.catchUp, log);

	let stopped = false;
	let failures = 0;
	let socket: SignalSocket | undefined;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let safetyInterval: ReturnType<typeof setInterval> | undefined;

	const later = (ms: number, run: () => void): ReturnType<typeof setTimeout> => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			run();
		}, ms);
		timers.add(timer);
		return timer;
	};
	const cancel = (timer: ReturnType<typeof setTimeout> | undefined): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(timer);
		}
	};

	const scheduleReconnect = (): void => {
		if (stopped) {
			return;
		}
		const delay = Math.min(minimumDelay * 2 ** failures, SIGNAL_MAX_RECONNECT_DELAY_MS);
		failures += 1;
		later(delay, () => void open());
	};

	const open = async (): Promise<void> => {
		let session: {clientId: string; cookie: string};
		try {
			session = await options.connect();
		} catch (error) {
			log(`upstream signal: no session: ${error instanceof Error ? error.message : String(error)}`);
			scheduleReconnect();
			return;
		}
		if (stopped) {
			return;
		}
		const url = `${SIGNAL_ORIGIN}/ws/signal/${session.clientId}/`;
		let current: SignalSocket;
		try {
			current = options.openSocket(url, {Cookie: session.cookie});
		} catch (error) {
			log(`upstream signal: open failed: ${error instanceof Error ? error.message : String(error)}`);
			scheduleReconnect();
			return;
		}
		socket = current;
		let stableTimer: ReturnType<typeof setTimeout> | undefined;

		const fail = (): void => {
			if (socket !== current) {
				return;
			}
			socket = undefined;
			cancel(connectionTimer);
			cancel(stableTimer);
			clearInterval(safetyInterval);
			safetyInterval = undefined;
			try {
				current.close();
			} catch {
				// Already closed.
			}
			scheduleReconnect();
		};
		const connectionTimer = later(SIGNAL_CONNECTION_TIMEOUT_MS, fail);

		current.addEventListener("open", () => {
			if (socket !== current) {
				return;
			}
			cancel(connectionTimer);
			stableTimer = later(SIGNAL_STABLE_CONNECTION_MS, () => {
				if (socket === current) {
					failures = 0;
				}
			});
			current.send(SUBSCRIBE_FRAME);
			clearInterval(safetyInterval);
			safetyInterval = setInterval(requestCatchUp, SIGNAL_SAFETY_CATCH_UP_MS);
			requestCatchUp();
		});
		current.addEventListener("message", (event) => {
			if (socket === current && isOwnerDocumentUpdate(event.data)) {
				requestCatchUp();
			}
		});
		current.addEventListener("error", fail);
		current.addEventListener("close", fail);
	};

	void open();

	return {
		stop(): void {
			stopped = true;
			for (const timer of timers) {
				clearTimeout(timer);
			}
			timers.clear();
			clearInterval(safetyInterval);
			safetyInterval = undefined;
			const current = socket;
			socket = undefined;
			current?.close();
		},
	};
}
