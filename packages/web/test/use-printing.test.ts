import {describe, expect, it} from "vite-plus/test";
import {installPrintListeners, printingStore} from "../src/client/hooks/use-printing.js";
import {printRowBudget} from "../src/client/render-window.js";

describe("printing flag", () =>
{
	it("follows beforeprint and afterprint, and the disposer removes both listeners", () =>
	{
		const win = new EventTarget();
		const dispose = installPrintListeners(win);
		const seen: boolean[] = [printingStore.get()];
		win.dispatchEvent(new Event("beforeprint"));
		seen.push(printingStore.get());
		win.dispatchEvent(new Event("afterprint"));
		seen.push(printingStore.get());
		win.dispatchEvent(new Event("beforeprint"));
		dispose();
		win.dispatchEvent(new Event("afterprint"));
		seen.push(printingStore.get());
		expect(seen).toStrictEqual([false, true, false, true]);
		printingStore.set(false);
	});

	it("notifies subscribers", () =>
	{
		const calls: boolean[] = [];
		const unsubscribe = printingStore.subscribe(() =>
		{
			calls.push(printingStore.get());
		});
		printingStore.set(true);
		printingStore.set(true);
		printingStore.set(false);
		unsubscribe();
		printingStore.set(true);
		printingStore.set(false);
		expect(calls).toStrictEqual([true, false]);
	});
});

describe("printRowBudget", () =>
{
	it("renders every row while printing and the windowed budget otherwise", () =>
	{
		expect([printRowBudget(48, true), printRowBudget(48, false)]).toStrictEqual([Number.POSITIVE_INFINITY, 48]);
	});
});
