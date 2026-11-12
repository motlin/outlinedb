/**
 * The socket side of the ladder: turn bus events into WebSocket frames.
 *
 * Kept apart from the server wiring so the subscribe/unsubscribe lifetime is
 * testable without opening a port. The handler shape matches what Hono's
 * `upgradeWebSocket` expects.
 */

import type {LadderEventBus} from "./ladder-events.js";

interface SocketLike
{
	send: (data: string) => void;
}

export interface LadderSocketHandlers
{
	onOpen?: (event: unknown, ws: SocketLike) => void;
	onClose?: (event: unknown, ws: SocketLike) => void;
}

export function ladderSocketHandlers(
	bus: LadderEventBus,
	options:
	{
		replay?: boolean;
	} = {},
): LadderSocketHandlers
{
	let unsubscribe: (() => void) | undefined;
	return {
		onOpen(_event, ws)
		{
			unsubscribe = bus.subscribe(
				(event) =>
				{
					ws.send(bus.format(event));
				},
				{
					replay: options.replay,
				},
			);
		},
		onClose()
		{
			unsubscribe?.();
			unsubscribe = undefined;
		},
	};
}
