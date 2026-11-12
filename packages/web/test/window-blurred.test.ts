import {describe, expect, it} from "vite-plus/test";
import {installWindowBlurredClass} from "../src/client/window-blurred.js";

function fakes()
{
	const listeners = new Map<string, () => void>();
	const toggles: [string, boolean][] = [];
	const win =
	{
		addEventListener: (type: string, listener: () => void) =>
		{
			listeners.set(type, listener);
		},
		removeEventListener: (type: string, listener: () => void) =>
		{
			if (listeners.get(type) === listener)
			{
				listeners.delete(type);
			}
		},
	};
	const body =
	{
		classList:
		{
			toggle: (name: string, force: boolean) =>
			{
				toggles.push([name, force]);
				return force;
			},
		},
	};
	return {
		listeners,
		toggles,
		win,
		body,
	};
}

describe("installWindowBlurredClass", () =>
{
	it("adds wf-dom-window-blurred on blur, removes it on focus, and unhooks on cleanup", () =>
	{
		const {listeners, toggles, win, body} = fakes();
		const cleanup = installWindowBlurredClass(win, body);
		listeners.get("blur")?.();
		listeners.get("focus")?.();
		cleanup();
		expect(
			{
				toggles,
				remaining: [...listeners.keys()],
			},
		).toStrictEqual(
			{
				toggles: [
					["wf-dom-window-blurred", true],
					["wf-dom-window-blurred", false],
				],
				remaining: [],
			},
		);
	});
});
