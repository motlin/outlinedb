/**
 * The socket side of the tree-change bus: one `{"type":"tree.changed","latest":...}` frame per published change, and
 * one `{"type":"expansion.changed","version":...}` or `{"type":"account.changed","version":...}` frame per version change.
 * Kept apart from the server wiring, like `ladder-socket.ts`, so the subscribe/unsubscribe lifetime is testable
 * without opening a port. The handler shape matches what Hono's `upgradeWebSocket` expects.
 */

import type {TreeEventBus} from "./node-events.js";

interface SocketLike {
	send: (data: string) => void;
}

export interface NodeEventsSocketHandlers {
	onOpen?: (event: unknown, ws: SocketLike) => void;
	onClose?: (event: unknown, ws: SocketLike) => void;
}

export function nodeEventsSocketHandlers(bus: TreeEventBus): NodeEventsSocketHandlers {
	let unsubscribe: (() => void) | undefined;
	return {
		onOpen(_event, ws) {
			unsubscribe = bus.subscribe((event) => {
				ws.send(JSON.stringify(event));
			});
		},
		onClose() {
			unsubscribe?.();
			unsubscribe = undefined;
		},
	};
}
