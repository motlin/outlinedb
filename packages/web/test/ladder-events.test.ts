import {describe, expect, it, vi} from "vite-plus/test";
import {LadderEventBus, parseLadderEvent} from "../src/server/ladder-events.js";
import type {LadderEvent, LadderListener} from "../src/server/ladder-events.js";

function evt(partial: Partial<LadderEvent> = {}): LadderEvent
{
	return {
		verb: "move",
		nodeId: "n1",
		name: "A task",
		fromTier: "6th",
		toTier: "5th",
		at: "2026-09-13T00:00:00Z",
		...partial,
	};
}

describe("LadderEventBus", () =>
{
	it("delivers an event to every subscriber", () =>
	{
		const bus = new LadderEventBus();
		const a = vi.fn<LadderListener>();
		const b = vi.fn<LadderListener>();
		bus.subscribe(a);
		bus.subscribe(b);
		bus.publish(evt());
		expect(a).toHaveBeenCalledWith(evt());
		expect(b).toHaveBeenCalledWith(evt());
	});

	it("stops delivering after unsubscribe, so a closed socket is not written to", () =>
	{
		const bus = new LadderEventBus();
		const listener = vi.fn<LadderListener>();
		const off = bus.subscribe(listener);
		off();
		bus.publish(evt());
		expect(listener).not.toHaveBeenCalled();
	});

	it("one throwing subscriber does not stop the others", () =>
	{
		const bus = new LadderEventBus();
		const good = vi.fn<LadderListener>();
		bus.subscribe(() =>
		{
			throw new Error("socket already closed");
		});
		bus.subscribe(good);
		expect(() =>
		{
			bus.publish(evt());
		}).not.toThrow();
		expect(good).toHaveBeenCalledOnce();
	});

	it("replays recent events so a watcher that connects late does not miss writes", () =>
	{
		const bus = new LadderEventBus();
		bus.publish(
			evt(
				{
					nodeId: "n1",
				},
			),
		);
		bus.publish(
			evt(
				{
					nodeId: "n2",
				},
			),
		);
		const late = vi.fn<LadderListener>();
		bus.subscribe(
			late,
			{
				replay: true,
			},
		);
		expect(late).toHaveBeenCalledTimes(2);
		expect(late.mock.calls.map((c) => c[0].nodeId)).toStrictEqual(["n1", "n2"]);
	});

	it("caps the replay buffer so a long session does not grow without bound", () =>
	{
		const bus = new LadderEventBus(
			{
				bufferSize: 3,
			},
		);
		for (const nodeId of ["n1", "n2", "n3", "n4"])
		{
			bus.publish(
				evt(
					{
						nodeId,
					},
				),
			);
		}
		const late = vi.fn<LadderListener>();
		bus.subscribe(
			late,
			{
				replay: true,
			},
		);
		expect(late.mock.calls.map((c) => c[0].nodeId)).toStrictEqual(["n2", "n3", "n4"]);
	});

	it("serialises an event as one line, because Monitor treats each frame as one notification", () =>
	{
		const bus = new LadderEventBus();
		const line = bus.format(
			evt(
				{
					name: "A task\nwith a newline",
				},
			),
		);
		expect(line).not.toContain("\n");
		expect(JSON.parse(line)).toMatchObject(
			{
				verb: "move",
				nodeId: "n1",
				toTier: "5th",
			},
		);
	});
});

describe("parseLadderEvent", () =>
{
	it("reads back a frame the bus formatted", () =>
	{
		const event = evt(
			{
				beforeNodeId: "n2",
			},
		);

		expect(parseLadderEvent(new LadderEventBus().format(event))).toStrictEqual(event);
	});

	it("drops a frame that is not a ladder event", () =>
	{
		expect(
			parseLadderEvent(
				JSON.stringify(
					{
						verb: "explode",
						nodeId: "n1",
					},
				),
			),
		).toBeNull();
	});

	it("drops a frame that is not JSON", () =>
	{
		expect(parseLadderEvent("not json")).toBeNull();
	});
});
