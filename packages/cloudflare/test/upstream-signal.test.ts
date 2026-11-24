import {describe, expect, it} from "vite-plus/test";
import {UpstreamSignal, connectSignal} from "../src/upstream-signal";
import type {SignalConnect, SignalSocket} from "../src/upstream-signal";

const NUDGE = JSON.stringify(
	{
		type: "signal.entity.updated",
		channel:
		{
			type: "OWNER_DOCUMENT_UPDATE",
		},
	},
);

/** workflowy.com's end of one signal socket: what the holder sent and did, and a way to send it frames or drop it. */
function fakeSocket()
{
	const listeners = new Map<string, ((event: {data?: unknown}) => void)[]>();
	const log: string[] = [];
	const socket: SignalSocket =
	{
		accept: () =>
		{
			log.push("accept");
		},
		addEventListener: (type, listener) =>
		{
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		send: (data) =>
		{
			log.push(`send ${data}`);
		},
		close: () =>
		{
			log.push("close");
		},
	};
	const emit = (type: string, data?: unknown): void =>
	{
		for (const listener of listeners.get(type) ?? [])
		{
			listener(
				{
					data,
				},
			);
		}
	};
	return {
		socket,
		log,
		emit,
	};
}

describe("workflowy.com's signal socket", () =>
{
	it("connects with the session cookie to the client's channel, and tells a refused session from a failure", async () =>
	{
		const {socket} = fakeSocket();
		const requests: unknown[] = [];
		const answer = (status: number, webSocket: SignalSocket | null) => async (url: string, init: RequestInit) =>
		{
			requests.push(
				{
					url,
					headers: init.headers,
					redirect: init.redirect,
				},
			);
			return Promise.resolve(
				{
					status,
					webSocket,
				},
			);
		};
		const connect = async (fetcher: Parameters<typeof connectSignal>[0]): Promise<string> =>
		{
			const result = await connectSignal(
				fetcher,
				"https://workflowy.com",
				"2026-10-18 12:00:00.123456",
				"sessionid=s1",
			);
			return result.kind === "open"
				? result.socket === socket
					? "open"
					: "other socket"
				: JSON.stringify(result);
		};
		expect(
			{
				open: await connect(answer(101, socket)),
				notFound: await connect(answer(404, null)),
				redirected: await connect(answer(302, null)),
				forbidden: await connect(answer(403, null)),
				unavailable: await connect(answer(503, null)),
				unreachable: await connect(async () => Promise.reject(new Error("connection reset"))),
				request: requests[0],
			},
		).toStrictEqual(
			{
				open: "open",
				notFound: '{"kind":"refused"}',
				redirected: '{"kind":"refused"}',
				forbidden: '{"kind":"refused"}',
				unavailable: '{"kind":"failed","message":"the signal socket answered 503"}',
				unreachable: '{"kind":"failed","message":"connection reset"}',
				request:
				{
					url: "https://workflowy.com/ws/signal/2026-10-18%2012:00:00.123456/",
					headers:
					{
						Upgrade: "websocket",
						Cookie: "sessionid=s1",
					},
					redirect: "manual",
				},
			},
		);
	});

	it("subscribes on open, nudges once per document update, never reopens on its own, and reports a refused session", async () =>
	{
		const first = fakeSocket();
		const second = fakeSocket();
		const answers: SignalConnect[] = [
			{
				kind: "open",
				socket: first.socket,
			},
			{
				kind: "refused",
			},
			{
				kind: "open",
				socket: second.socket,
			},
		];
		const events: string[] = [];
		const signal = new UpstreamSignal(
			{
				connect: async () =>
				{
					events.push("connect");
					const answer = answers.shift();
					if (answer === undefined)
					{
						throw new Error("no more answers");
					}
					return Promise.resolve(answer);
				},
				nudge: () =>
				{
					events.push("nudge");
				},
				refused: () =>
				{
					events.push("refused");
				},
				log: (message) =>
				{
					events.push(`log ${message}`);
				},
			},
		);
		const opened = await Promise.all([signal.hold(), signal.hold()]);
		const heldAgain = await signal.hold();
		first.emit("message", NUDGE);
		first.emit("message", '{"type":"signal.entity.updated","channel":{"type":"SHARED_DOCUMENT_UPDATE"}}');
		first.emit("message", "not json");
		first.emit("message", NUDGE);
		// workflowy.com drops the socket: nothing reopens it until the next hold.
		first.emit("close");
		first.emit("message", NUDGE);
		const afterDrop = signal.isOpen();
		const refused = await signal.hold();
		const reopened = await signal.hold();
		signal.release();
		second.emit("message", NUDGE);
		expect(
			{
				opened,
				heldAgain,
				afterDrop,
				refused,
				reopened,
				released: signal.isOpen(),
				events,
				first: first.log,
				second: second.log,
			},
		).toStrictEqual(
			{
				// Two holds at once open one socket.
				opened: [true, false],
				heldAgain: false,
				afterDrop: false,
				refused: false,
				reopened: true,
				released: false,
				events: ["connect", "nudge", "nudge", "connect", "refused", "connect"],
				first: [
					"accept",
					`send {"type":"do.subscribe","channels":[{"type":"OWNER_DOCUMENT_UPDATE"}]}`,
					"close",
				],
				second: [
					"accept",
					`send {"type":"do.subscribe","channels":[{"type":"OWNER_DOCUMENT_UPDATE"}]}`,
					"close",
				],
			},
		);
	});

	it("closes a socket that opens after it was released", async () =>
	{
		const late = fakeSocket();
		let open: (answer: SignalConnect) => void = () =>
		{
		};
		const signal = new UpstreamSignal(
			{
				connect: async () =>
					new Promise<SignalConnect>((resolve) =>
					{
						open = resolve;
					}),
				nudge: () =>
				{
				},
				refused: () =>
				{
				},
			},
		);
		const held = signal.hold();
		signal.release();
		open(
			{
				kind: "open",
				socket: late.socket,
			},
		);
		expect(
			{
				held: await held,
				open: signal.isOpen(),
				log: late.log,
			},
		).toStrictEqual(
			{
				held: false,
				open: false,
				log: ["close"],
			},
		);
	});
});
