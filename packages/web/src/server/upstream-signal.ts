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
/** The frame a signal socket sends on open: subscribe to the owner's document updates. */
export const SIGNAL_SUBSCRIBE_FRAME = JSON.stringify(
	{
		type: "do.subscribe",
		channels: [
			{
				type: "OWNER_DOCUMENT_UPDATE",
			},
		],
	},
);

/** The subset of the WebSocket API the watcher uses, so tests can pass a fake. */
export interface SignalSocket
{
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: {data?: unknown}) => void): void;
	send(data: string): void;
	close(): void;
}

export interface UpstreamSignalOptions
{
	/** Resolve the session to connect with: the `wfclientid` from init and the `sessionid` cookie. */
	connect: () => Promise<
	{
		clientId: string;
		cookie: string;
	}>;
	openSocket: (url: string, headers: Record<string, string>) => SignalSocket;
	catchUp: () => Promise<void>;
	/** Defaults to `Math.random`; fixes the per-watcher minimum reconnect delay. */
	random?: () => number;
	log?: (message: string) => void;
}

export interface UpstreamSignalWatcher
{
	stop(): void;
}

/** Node's global WebSocket (undici) accepts request headers, which carry the session cookie. */
export function nodeSignalSocket(url: string, headers: Record<string, string>): SignalSocket
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the DOM lib types WebSocket without undici's WebSocketInit, which Node accepts
	const NodeWebSocket = WebSocket as unknown as new (
		url: string,
		init:
		{
			headers: Record<string, string>;
		},
	) => WebSocket;
	return new NodeWebSocket(
		url,
		{
			headers,
		},
	);
}

/** Whether a signal socket frame is the nudge that the owner's document changed. */
export function isOwnerDocumentUpdate(data: unknown): boolean
{
	if (typeof data !== "string")
	{
		return false;
	}
	let frame: unknown;
	try
	{
		frame = JSON.parse(data);
	}
	catch
	{
		return false;
	}
	if (typeof frame !== "object" || frame === null)
	{
		return false;
	}
	const {type, channel} = frame as
	{
		type?: unknown;
		channel?:
		{
			type?: unknown;
		} | null;
	};
	return type === "signal.entity.updated" && channel?.type === "OWNER_DOCUMENT_UPDATE";
}

/**
 * Run `job` so that a burst of requests gives one call in flight plus at
 * most one queued behind it; a failure is logged and never stops later calls.
 */
/** An error's message followed by each `cause` message, so a wrapped transport failure keeps its real cause. */
function causeChain(error: unknown): string
{
	if (!(error instanceof Error))
	{
		return String(error);
	}
	return error.cause === undefined ? error.message : `${error.message}: ${causeChain(error.cause)}`;
}

function coalesced(job: () => Promise<void>, log: (message: string) => void, failure: string): () => void
{
	let inFlight: Promise<void> | undefined;
	let queued = false;
	const start = (): void =>
	{
		inFlight = job()
			.catch((error: unknown) =>
			{
				log(`${failure}: ${causeChain(error)}`);
			})
			.finally(() =>
			{
				inFlight = undefined;
				if (queued)
				{
					queued = false;
					start();
				}
			});
	};
	return () =>
	{
		if (inFlight === undefined)
		{
			start();
		}
		else
		{
			queued = true;
		}
	};
}

/** A lane job's end, either way: the caller handles the outcome, and the lane only waits for it. */
function settled(): void
{
	// Nothing to do.
}

export interface UpstreamLane
{
	/** Start an outbox drain, or queue one behind the drain in flight; a burst of requests coalesces into one more. */
	requestDrain(): void;
	/** Run `job` once every drain and job started before it has settled. */
	exclusive<T>(job: () => Promise<T>): Promise<T>;
	/**
	 * Run a catch-up in its lane turn, after one outbox drain in that same turn: on the Node host the catch-up is the
	 * scheduled sync tick, so rows left pending while workflowy.com was unreachable go out once it is back. A failed
	 * drain is logged and the catch-up still runs; its rows wait for the next trigger.
	 */
	catchUp<T>(job: () => Promise<T>): Promise<T>;
}

/**
 * The Node host's one lane to workflowy.com: outbox drains and catch-ups run one at a time, so a drain's push and a
 * catch-up's poll never overlap. A failed drain is logged; its rows stay pending until the next trigger.
 */
export function upstreamLane(drain: () => Promise<unknown>, log: (message: string) => void): UpstreamLane
{
	let tail: Promise<unknown> = Promise.resolve();
	const exclusive = async <T>(job: () => Promise<T>): Promise<T> =>
	{
		const run = tail.then(job);
		tail = run.then(settled, settled);
		return run;
	};
	return {
		requestDrain: coalesced(
			async () =>
			{
				await exclusive(drain);
			},
			log,
			"outbox drain failed",
		),
		exclusive,
		catchUp: async <T>(job: () => Promise<T>): Promise<T> =>
			exclusive(async () =>
			{
				try
				{
					await drain();
				}
				catch (error)
				{
					log(`outbox drain before catch-up failed: ${causeChain(error)}`);
				}
				return job();
			}),
	};
}

export function startUpstreamSignal(options: UpstreamSignalOptions): UpstreamSignalWatcher
{
	const log =
		options.log ??
		((message: string) =>
		{
			console.warn(message);
		});
	const minimumDelay = 1000 + (options.random ?? Math.random)() * 4000;
	const requestCatchUp = coalesced(options.catchUp, log, "upstream signal: catch-up failed");

	let stopped = false;
	let failures = 0;
	let socket: SignalSocket | undefined;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let safetyInterval: ReturnType<typeof setInterval> | undefined;

	const later = (ms: number, run: () => void): ReturnType<typeof setTimeout> =>
	{
		const timer = setTimeout(() =>
		{
			timers.delete(timer);
			run();
		}, ms);
		timers.add(timer);
		return timer;
	};
	const cancel = (timer: ReturnType<typeof setTimeout> | undefined): void =>
	{
		if (timer !== undefined)
		{
			clearTimeout(timer);
			timers.delete(timer);
		}
	};

	const scheduleReconnect = (): void =>
	{
		if (stopped)
		{
			return;
		}
		const delay = Math.min(minimumDelay * 2 ** failures, SIGNAL_MAX_RECONNECT_DELAY_MS);
		failures += 1;
		later(delay, () => void open());
	};

	const open = async (): Promise<void> =>
	{
		let session:
		{
			clientId: string;
			cookie: string;
		};
		try
		{
			session = await options.connect();
		}
		catch (error)
		{
			log(`upstream signal: no session: ${error instanceof Error ? error.message : String(error)}`);
			scheduleReconnect();
			return;
		}
		if (stopped)
		{
			return;
		}
		const url = `${SIGNAL_ORIGIN}/ws/signal/${session.clientId}/`;
		let current: SignalSocket;
		try
		{
			current = options.openSocket(
				url,
				{
					Cookie: session.cookie,
				},
			);
		}
		catch (error)
		{
			log(`upstream signal: open failed: ${error instanceof Error ? error.message : String(error)}`);
			scheduleReconnect();
			return;
		}
		socket = current;
		let stableTimer: ReturnType<typeof setTimeout> | undefined;

		const fail = (): void =>
		{
			if (socket !== current)
			{
				return;
			}
			socket = undefined;
			cancel(connectionTimer);
			cancel(stableTimer);
			clearInterval(safetyInterval);
			safetyInterval = undefined;
			try
			{
				current.close();
			}
			catch
			{
				// Already closed.
			}
			scheduleReconnect();
		};
		const connectionTimer = later(SIGNAL_CONNECTION_TIMEOUT_MS, fail);

		current.addEventListener("open", () =>
		{
			if (socket !== current)
			{
				return;
			}
			cancel(connectionTimer);
			stableTimer = later(SIGNAL_STABLE_CONNECTION_MS, () =>
			{
				if (socket === current)
				{
					failures = 0;
				}
			});
			current.send(SIGNAL_SUBSCRIBE_FRAME);
			clearInterval(safetyInterval);
			safetyInterval = setInterval(requestCatchUp, SIGNAL_SAFETY_CATCH_UP_MS);
			requestCatchUp();
		});
		current.addEventListener("message", (event) =>
		{
			if (socket === current && isOwnerDocumentUpdate(event.data))
			{
				requestCatchUp();
			}
		});
		current.addEventListener("error", fail);
		current.addEventListener("close", fail);
	};

	void open();

	return {
		stop(): void
		{
			stopped = true;
			for (const timer of timers)
			{
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
