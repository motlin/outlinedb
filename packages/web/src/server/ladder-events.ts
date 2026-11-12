/**
 * Write events broadcast to anything watching the ladder.
 *
 * The point of this bus is to let a Claude session be woken by a write rather
 * than having to poll for one. Monitor's `ws:` source turns every frame into a
 * notification, so one frame per write means one notification per edit. The
 * published-artifact approach could never do this: reading an artifact's
 * database needs a tool call, and a tool call only happens on a turn, so a save
 * sat unnoticed until somebody thought to look.
 */

import {z} from "zod";

export const LadderEventSchema = z.object(
	{
		verb: z.enum(["move", "complete", "uncomplete"]),
		nodeId: z.string(),
		/** Task text at the time of the write, for a human-readable notification. */
		name: z.string().nullable(),
		fromTier: z.string().nullable(),
		toTier: z.string().nullable(),
		/** Empty string appends; otherwise insert before this row. */
		beforeNodeId: z.string().optional(),
		at: z.string(),
	},
);

export type LadderEvent = z.infer<typeof LadderEventSchema>;

/** Read one bus frame back into an event, or null when the frame is not one. */
export function parseLadderEvent(frame: string): LadderEvent | null
{
	try
	{
		const result = LadderEventSchema.safeParse(JSON.parse(frame));
		return result.success ? result.data : null;
	}
	catch
	{
		return null;
	}
}

export type LadderListener = (event: LadderEvent) => void;

interface SubscribeOptions
{
	/** Replay the buffered events before receiving new ones. */
	replay?: boolean;
}

const DEFAULT_BUFFER = 100;

export class LadderEventBus
{
	readonly #listeners = new Set<LadderListener>();
	readonly #recent: LadderEvent[] = [];
	readonly #bufferSize: number;

	constructor(
		options:
		{
			bufferSize?: number;
		} = {},
	)
	{
		this.#bufferSize = options.bufferSize ?? DEFAULT_BUFFER;
	}

	subscribe(listener: LadderListener, options: SubscribeOptions = {}): () => void
	{
		if (options.replay)
		{
			for (const event of this.#recent)
			{
				this.#deliver(listener, event);
			}
		}
		this.#listeners.add(listener);
		return () =>
		{
			this.#listeners.delete(listener);
		};
	}

	publish(event: LadderEvent): void
	{
		this.#recent.push(event);
		if (this.#recent.length > this.#bufferSize)
		{
			this.#recent.splice(0, this.#recent.length - this.#bufferSize);
		}
		// Copied: #deliver drops a throwing listener, and a listener may
		// unsubscribe itself mid-notification.
		// oxlint-disable-next-line no-useless-spread
		for (const listener of [...this.#listeners])
		{
			this.#deliver(listener, event);
		}
	}

	/**
	 * One event, one line. Monitor batches stdout within 200ms into a single
	 * notification, so an embedded newline would split one write across two.
	 */
	format(event: LadderEvent): string
	{
		return JSON.stringify(
			{
				...event,
				name: event.name?.replaceAll(/\s+/gu, " ").trim() ?? null,
			},
		);
	}

	/** A listener writing to a socket that just closed must not take the rest down. */
	#deliver(listener: LadderListener, event: LadderEvent): void
	{
		try
		{
			listener(event);
		}
		catch
		{
			this.#listeners.delete(listener);
		}
	}
}
