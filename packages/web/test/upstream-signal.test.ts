import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	SIGNAL_CONNECTION_TIMEOUT_MS,
	SIGNAL_SAFETY_CATCH_UP_MS,
	startUpstreamSignal,
} from "../src/server/upstream-signal.js";
import type {SignalSocket, UpstreamSignalOptions} from "../src/server/upstream-signal.js";

type Listener = (event: {data?: unknown}) => void;

class FakeSocket implements SignalSocket
{
	readonly sent: string[] = [];
	closed = false;
	private readonly listeners = new Map<string, Listener[]>();

	constructor(
		readonly url: string,
		readonly headers: Record<string, string>,
	)
	{
	}

	addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void
	{
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	send(data: string): void
	{
		this.sent.push(data);
	}

	close(): void
	{
		this.closed = true;
	}

	emit(type: "open" | "message" | "close" | "error", data?: unknown): void
	{
		for (const listener of this.listeners.get(type) ?? [])
		{
			listener(
				{
					data,
				},
			);
		}
	}

	frame(channel: Record<string, unknown>): void
	{
		this.emit(
			"message",
			JSON.stringify(
				{
					type: "signal.entity.updated",
					channel,
				},
			),
		);
	}
}

/** A catchUp whose calls stay pending until the test settles them, one at a time. */
function controlledCatchUp()
{
	const pending: (() => void)[] = [];
	const catchUp = vi.fn<() => Promise<void>>(
		async () =>
			new Promise<void>((resolve) =>
			{
				pending.push(resolve);
			}),
	);
	return {
		catchUp,
		async settle(): Promise<void>
		{
			pending.shift()?.();
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

function harness(overrides: Partial<UpstreamSignalOptions> = {})
{
	const sockets: FakeSocket[] = [];
	const control = controlledCatchUp();
	const watcher = startUpstreamSignal(
		{
			connect: async () =>
				Promise.resolve(
					{
						clientId: "12345678901234567890",
						cookie: "sessionid=abc",
					},
				),
			openSocket: (url, headers) =>
			{
				const socket = new FakeSocket(url, headers);
				sockets.push(socket);
				return socket;
			},
			catchUp: control.catchUp,
			random: () => 0,
			log: () =>
			{
			},
			...overrides,
		},
	);
	return {
		sockets,
		watcher,
		...control,
		latest: () => sockets.at(-1)!,
	};
}

/** Open the first socket and let the catch-up that every open starts finish. */
async function openAndSettle(h: ReturnType<typeof harness>): Promise<FakeSocket>
{
	await vi.advanceTimersByTimeAsync(0);
	const socket = h.latest();
	socket.emit("open");
	await h.settle();
	return socket;
}

describe("startUpstreamSignal", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
	});
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("opens the client's signal channel with the session cookie and subscribes to the owner document", async () =>
	{
		const h = harness();
		const socket = await openAndSettle(h);
		expect(
			{
				url: socket.url,
				headers: socket.headers,
				sent: socket.sent.map((s) => JSON.parse(s) as unknown),
			},
		).toStrictEqual(
			{
				url: "wss://workflowy.com/ws/signal/12345678901234567890/",
				headers:
				{
					Cookie: "sessionid=abc",
				},
				sent: [
					{
						type: "do.subscribe",
						channels: [
							{
								type: "OWNER_DOCUMENT_UPDATE",
							},
						],
					},
				],
			},
		);
		h.watcher.stop();
	});

	it("catches up once on open, then once per document frame", async () =>
	{
		const h = harness();
		const socket = await openAndSettle(h);
		expect(h.catchUp).toHaveBeenCalledOnce();
		socket.frame(
			{
				type: "OWNER_DOCUMENT_UPDATE",
			},
		);
		await h.settle();
		expect(h.catchUp).toHaveBeenCalledTimes(2);
		h.watcher.stop();
	});

	it("coalesces three frames during one in-flight catch-up into one more", async () =>
	{
		const h = harness();
		const socket = await openAndSettle(h);
		socket.frame(
			{
				type: "OWNER_DOCUMENT_UPDATE",
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		socket.frame(
			{
				type: "OWNER_DOCUMENT_UPDATE",
			},
		);
		socket.frame(
			{
				type: "OWNER_DOCUMENT_UPDATE",
			},
		);
		socket.frame(
			{
				type: "OWNER_DOCUMENT_UPDATE",
			},
		);
		await h.settle();
		await h.settle();
		await h.settle();
		// One on open, the frame that found nothing in flight, and one queued for the burst.
		expect(h.catchUp).toHaveBeenCalledTimes(3);
		h.watcher.stop();
	});

	it("ignores other channel types and non-signal frames", async () =>
	{
		const h = harness();
		const socket = await openAndSettle(h);
		socket.frame(
			{
				type: "ACCOUNT_UPDATE",
			},
		);
		socket.emit(
			"message",
			JSON.stringify(
				{
					type: "pong",
				},
			),
		);
		socket.emit("message", "not json");
		await h.settle();
		expect(h.catchUp).toHaveBeenCalledOnce();
		h.watcher.stop();
	});

	it("reconnects after a close with upstream's first-failure delay and catches up again", async () =>
	{
		const h = harness(
			{
				random: () => 0.5,
			},
		);
		const socket = await openAndSettle(h);
		socket.emit("close");
		// minimum delay = 1000 + 0.5 * 4000 = 3000ms on the first failure.
		await vi.advanceTimersByTimeAsync(2999);
		expect(h.sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.sockets).toHaveLength(2);
		h.latest().emit("open");
		await h.settle();
		expect(
			{
				catchUps: h.catchUp.mock.calls.length,
				resubscribed: h.latest().sent.length,
			},
		).toStrictEqual(
			{
				catchUps: 2,
				resubscribed: 1,
			},
		);
		h.watcher.stop();
	});

	it("doubles the delay per consecutive failure and caps it at three minutes", async () =>
	{
		const h = harness(
			{
				random: () => 1,
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		const delays: number[] = [];
		for (let attempt = 0; attempt < 8; attempt++)
		{
			const before = h.sockets.length;
			h.latest().emit("error");
			let waited = 0;
			while (h.sockets.length === before)
			{
				await vi.advanceTimersByTimeAsync(1000);
				waited += 1000;
			}
			delays.push(waited);
		}
		expect(delays).toStrictEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000, 180_000, 180_000]);
		h.watcher.stop();
	});

	it("gives up on a socket that does not open within the connection timeout", async () =>
	{
		const h = harness();
		await vi.advanceTimersByTimeAsync(SIGNAL_CONNECTION_TIMEOUT_MS);
		expect(h.sockets[0].closed).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.sockets).toHaveLength(2);
		h.watcher.stop();
	});

	it("retries when the session cannot be resolved", async () =>
	{
		let attempts = 0;
		const h = harness(
			{
				connect: async () =>
				{
					attempts++;
					return attempts === 1
						? Promise.reject(new Error("login failed"))
						: Promise.resolve(
								{
									clientId: "1",
									cookie: "sessionid=x",
								},
							);
				},
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.sockets).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.sockets).toHaveLength(1);
		h.watcher.stop();
	});

	it("runs a safety catch-up while connected", async () =>
	{
		const h = harness();
		await openAndSettle(h);
		await vi.advanceTimersByTimeAsync(SIGNAL_SAFETY_CATCH_UP_MS);
		await h.settle();
		expect(h.catchUp).toHaveBeenCalledTimes(2);
		h.watcher.stop();
	});

	it("keeps going after a catch-up fails", async () =>
	{
		const catchUp = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue();
		const h = harness(
			{
				catchUp,
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		h.latest().emit("open");
		await vi.advanceTimersByTimeAsync(0);
		h.latest().frame(
			{
				type: "OWNER_DOCUMENT_UPDATE",
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(catchUp).toHaveBeenCalledTimes(2);
		h.watcher.stop();
	});

	it("stops reconnecting and closes the socket once stopped", async () =>
	{
		const h = harness();
		const socket = await openAndSettle(h);
		h.watcher.stop();
		socket.emit("close");
		await vi.advanceTimersByTimeAsync(SIGNAL_SAFETY_CATCH_UP_MS);
		expect(
			{
				closed: socket.closed,
				sockets: h.sockets.length,
				catchUps: h.catchUp.mock.calls.length,
			},
		).toStrictEqual(
			{
				closed: true,
				sockets: 1,
				catchUps: 1,
			},
		);
	});
});
