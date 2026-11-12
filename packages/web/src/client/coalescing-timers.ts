import {timeoutManager} from "@tanstack/react-query";
import type {ManagedTimerId, TimeoutCallback, TimeoutProvider} from "@tanstack/react-query";

/** Timeouts at least this long are batched: query staleness and garbage collection, never retries or debounces. */
const COALESCE_FROM_MS = 1000;
/** Batched timeouts fire on the next whole second at or after their deadline. */
const GRANULARITY_MS = 1000;

/** A batched timeout's id: coerces to a number like a platform id, and is told apart from one by its class. */
class CoalescedTimer
{
	readonly #id: number;
	readonly due: number;

	constructor(id: number, due: number)
	{
		this.#id = id;
		this.due = due;
	}

	[Symbol.toPrimitive](): number
	{
		return this.#id;
	}
}

type PlatformTimerId = ReturnType<typeof setTimeout>;

interface Batch
{
	timer: PlatformTimerId;
	callbacks: Map<CoalescedTimer, TimeoutCallback>;
}

/**
 * A TanStack Query `TimeoutProvider` that batches long timeouts by the second they fall due, so mounting a view's
 * hundreds of query observers costs a map insert each instead of a platform `setTimeout` (each fresh observer arms a
 * stale timer, each released query a gc timer). A batched timeout fires up to a second late, never early. Short
 * timeouts and intervals go straight to the platform.
 */
export function createCoalescingTimeoutProvider(): TimeoutProvider
{
	const batches = new Map<number, Batch>();
	let nextId = 1;

	const fire = (due: number) =>
	{
		const batch = batches.get(due);
		batches.delete(due);
		for (const callback of batch?.callbacks.values() ?? [])
		{
			callback();
		}
	};

	return {
		setTimeout: (callback, delay) =>
		{
			if (delay < COALESCE_FROM_MS)
			{
				return setTimeout(callback, delay);
			}
			const now = Date.now();
			const due = Math.ceil((now + delay) / GRANULARITY_MS) * GRANULARITY_MS;
			const handle = new CoalescedTimer(nextId, due);
			nextId += 1;
			let batch = batches.get(due);
			if (batch === undefined)
			{
				batch =
				{
					timer: setTimeout(() =>
					{
						fire(due);
					}, due - now),
					callbacks: new Map(),
				};
				batches.set(due, batch);
			}
			batch.callbacks.set(handle, callback);
			return handle;
		},
		clearTimeout: (timeoutId) =>
		{
			if (!(timeoutId instanceof CoalescedTimer))
			{
				if (timeoutId !== undefined)
				{
					clearTimeout(Number(timeoutId));
				}
				return;
			}
			const batch = batches.get(timeoutId.due);
			if (batch === undefined)
			{
				return;
			}
			batch.callbacks.delete(timeoutId);
			if (batch.callbacks.size === 0)
			{
				clearTimeout(batch.timer);
				batches.delete(timeoutId.due);
			}
		},
		setInterval: (callback, delay) => setInterval(callback, delay),
		clearInterval: (intervalId) =>
		{
			if (intervalId !== undefined)
			{
				clearInterval(Number(intervalId));
			}
		},
	};
}

/** The page's one provider lives on the global object, outside any module a hot update re-runs. */
const PAGE_PROVIDER = Symbol.for("outlinedb.coalescingTimeoutProvider");

type ProviderScope = typeof globalThis &
{
	[PAGE_PROVIDER]?: TimeoutProvider;
};

/**
 * Give TanStack Query the page's coalescing provider, created once per page. A hot update re-runs the module that calls
 * this; handing over a fresh provider then would orphan the timers armed through the old one (and TanStack logs a
 * provider-switch error), so every later call reinstalls the same instance.
 */
export function installCoalescingTimeoutProvider(): void
{
	const scope = globalThis as ProviderScope;
	scope[PAGE_PROVIDER] ??= createCoalescingTimeoutProvider();
	timeoutManager.setTimeoutProvider(scope[PAGE_PROVIDER]);
}
