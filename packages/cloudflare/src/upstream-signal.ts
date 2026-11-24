import {SIGNAL_SUBSCRIBE_FRAME, isOwnerDocumentUpdate} from "@outlinedb/web/server-app";

/**
 * The Durable Object's hold on workflowy.com's signal socket, which nudges when another client changed the account's
 * tree, as workflowy.com's own web app learns of remote edits (protocol: packages/web/src/server/upstream-signal.ts).
 * Unlike the Node host's watcher it never reconnects on its own: a dropped socket stays closed until the object holds it
 * again, on a tab's next visibility message or the next hourly catch-up.
 */

/** The slice of a Workers WebSocket the signal uses. */
export interface SignalSocket
{
	accept(): void;
	addEventListener(type: "message" | "close" | "error", listener: (event: {data?: unknown}) => void): void;
	send(data: string): void;
	close(): void;
}

/** How one attempt to open the signal socket ended. */
export type SignalConnect =
	|
	  {
			kind: "open";
			socket: SignalSocket;
	  }
	|
	  {
			/** workflowy.com no longer honors the stored session. */
			kind: "refused";
	  }
	|
	  {
			kind: "failed";
			message: string;
	  };

/** An upgrade request, answered with the socket on success; a Workers `fetch` with `Upgrade: websocket` is one. */
export type SignalFetch = (
	url: string,
	init: RequestInit,
) => Promise<
{
	status: number;
	webSocket?: SignalSocket | null;
}>;

/** workflowy.com's answers to a request on a session it no longer honors: a login redirect, 401, 403 or its 404 page. */
function refusesSession(status: number): boolean
{
	return (status >= 300 && status < 400) || status === 401 || status === 403 || status === 404;
}

/** Open the signal socket of the session's `wfclientid` channel at `origin`, sending the session cookie. */
export async function connectSignal(
	fetcher: SignalFetch,
	origin: string,
	clientId: string,
	cookie: string,
): Promise<SignalConnect>
{
	let response: Awaited<ReturnType<SignalFetch>>;
	try
	{
		response = await fetcher(
			new URL(`/ws/signal/${clientId}/`, origin).href,
			{
				headers:
				{
					Upgrade: "websocket",
					Cookie: cookie,
				},
				redirect: "manual",
			},
		);
	}
	catch (error)
	{
		return {
			kind: "failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	if (response.webSocket)
	{
		return {
			kind: "open",
			socket: response.webSocket,
		};
	}
	if (refusesSession(response.status))
	{
		return {
			kind: "refused",
		};
	}
	return {
		kind: "failed",
		message: `the signal socket answered ${String(response.status)}`,
	};
}

export interface UpstreamSignalDeps
{
	connect: () => Promise<SignalConnect>;
	/** Called once per nudge frame; the caller coalesces them into catch-ups. */
	nudge: () => void;
	/** workflowy.com refused the session while opening the socket. */
	refused: () => Promise<void> | void;
	log?: (message: string) => void;
}

export class UpstreamSignal
{
	private socket: SignalSocket | undefined;
	private opening: Promise<boolean> | undefined;
	/** Whether the latest call was a hold, so a socket that opens after a release is closed at once. */
	private wanted = false;

	constructor(private readonly deps: UpstreamSignalDeps)
	{
	}

	isOpen(): boolean
	{
		return this.socket !== undefined;
	}

	/** Open the socket unless it is open or opening; true only for the call that opened it. One attempt, never retried. */
	async hold(): Promise<boolean>
	{
		this.wanted = true;
		if (this.socket !== undefined || this.opening !== undefined)
		{
			return false;
		}
		this.opening = this.open().finally(() =>
		{
			this.opening = undefined;
		});
		return this.opening;
	}

	/** Close the socket, or the one still opening as soon as it opens. */
	release(): void
	{
		this.wanted = false;
		const socket = this.socket;
		this.socket = undefined;
		socket?.close();
	}

	private async open(): Promise<boolean>
	{
		const result = await this.deps.connect();
		if (result.kind === "refused")
		{
			await this.deps.refused();
			return false;
		}
		if (result.kind === "failed")
		{
			this.deps.log?.(`workflowy.com signal socket did not open: ${result.message}`);
			return false;
		}
		const {socket} = result;
		if (!this.wanted)
		{
			socket.close();
			return false;
		}
		socket.accept();
		const drop = (): void =>
		{
			if (this.socket !== socket)
			{
				return;
			}
			this.socket = undefined;
			try
			{
				socket.close();
			}
			catch
			{
				// Already closed.
			}
		};
		socket.addEventListener("message", (event) =>
		{
			if (this.socket === socket && isOwnerDocumentUpdate(event.data))
			{
				this.deps.nudge();
			}
		});
		socket.addEventListener("close", drop);
		socket.addEventListener("error", drop);
		socket.send(SIGNAL_SUBSCRIBE_FRAME);
		this.socket = socket;
		return true;
	}
}
