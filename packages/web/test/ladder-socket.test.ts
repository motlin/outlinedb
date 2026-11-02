import {describe, expect, it, vi} from "vite-plus/test";
import {LadderEventBus} from "../src/server/ladder-events.js";
import {ladderSocketHandlers} from "../src/server/ladder-socket.js";

const event = (nodeId: string) => (
{
	verb: "move" as const,
	nodeId,
	name: "A",
	fromTier: "1st",
	toTier: "2nd",
	at: "2026-09-13T00:00:00.000Z",
});

function connect(
	bus: LadderEventBus,
	options?:
	{
		replay?: boolean;
	},
)
{
	const ws =
	{
		send: vi.fn<(data: string) => void>(),
		close: vi.fn<() => void>(),
	};
	const handlers = ladderSocketHandlers(bus, options);
	handlers.onOpen?.({}, ws);
	return {
		ws,
		handlers,
	};
}

describe("ladderSocketHandlers", () =>
{
	it("sends one frame per write so Monitor raises one notification per edit", () =>
	{
		const bus = new LadderEventBus();
		const {ws} = connect(bus);
		bus.publish(event("a"));
		bus.publish(event("b"));
		expect(ws.send).toHaveBeenCalledTimes(2);
		expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject(
			{
				nodeId: "a",
				verb: "move",
			},
		);
	});

	it("replays buffered writes to a watcher that connects late", () =>
	{
		const bus = new LadderEventBus();
		bus.publish(event("earlier"));
		const {ws} = connect(
			bus,
			{
				replay: true,
			},
		);
		expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject(
			{
				nodeId: "earlier",
			},
		);
	});

	it("stops sending after the socket closes", () =>
	{
		const bus = new LadderEventBus();
		const {ws, handlers} = connect(bus);
		handlers.onClose?.({}, ws);
		bus.publish(event("a"));
		expect(ws.send).not.toHaveBeenCalled();
	});
});
