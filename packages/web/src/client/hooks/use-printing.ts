import {flushSync} from "react-dom";
import {useSyncExternalStore} from "react";

let printing = false;
const listeners = new Set<() => void>();

/** Upstream's `WF.Print.printing`: true between `beforeprint` and `afterprint`. */
export const printingStore =
{
	get: (): boolean => printing,
	set: (next: boolean): void =>
	{
		if (next === printing)
		{
			return;
		}
		printing = next;
		for (const listener of listeners)
		{
			listener();
		}
	},
	subscribe: (listener: () => void): (() => void) =>
	{
		listeners.add(listener);
		return () =>
		{
			listeners.delete(listener);
		};
	},
};

export function usePrinting(): boolean
{
	return useSyncExternalStore(printingStore.subscribe, printingStore.get, () => false);
}

function flipPrinting(next: boolean): () => void
{
	return () =>
	{
		try
		{
			flushSync(() =>
			{
				printingStore.set(next);
			});
		}
		catch
		{
			// flushSync throws when a render is already under way; the flag is set either way.
			printingStore.set(next);
		}
	};
}

/**
 * Upstream's `gui-print` boot: each print event flips the flag inside `flushSync`, so React has rendered every row
 * before the browser snapshots the page. Returns the disposer.
 */
export function installPrintListeners(win: EventTarget): () => void
{
	const before = flipPrinting(true);
	const after = flipPrinting(false);
	win.addEventListener("beforeprint", before);
	win.addEventListener("afterprint", after);
	return () =>
	{
		win.removeEventListener("beforeprint", before);
		win.removeEventListener("afterprint", after);
	};
}
