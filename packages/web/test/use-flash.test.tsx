// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {useFlash} = await import("../src/client/hooks/use-flash.js");

/** Runs `change` inside act and lets React flush it. */
async function run(change: () => void): Promise<void>
{
	await act(async () =>
	{
		change();
		await Promise.resolve();
	});
}

let root: Root | undefined;
const probe =
{
	flash: () =>
	{
	},
};
const setFlash = (start: () => void) =>
{
	probe.flash = start;
};
let host: HTMLElement | undefined;

function Probe()
{
	const [flashing, start] = useFlash(2000);
	setFlash(start);
	return createElement(
		"span",
		{
			id: "probe",
		},
		String(flashing),
	);
}

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () =>
{
	await run(() =>
	{
		root?.unmount();
	});
	host?.remove();
	vi.useRealTimers();
});

async function advance(ms: number): Promise<void>
{
	await run(() =>
	{
		vi.advanceTimersByTime(ms);
	});
}

async function mount(): Promise<void>
{
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await run(() =>
	{
		root?.render(createElement(Probe));
	});
}

const state = () => document.querySelector("#probe")?.textContent;

describe("useFlash", () =>
{
	it("flashes for 2000ms", async () =>
	{
		await mount();
		await run(() =>
		{
			probe.flash();
		});
		const start = state();
		await advance(1999);
		const before = state();
		await advance(1);
		expect(
			{
				start,
				before,
				after: state(),
			},
		).toStrictEqual(
			{
				start: "true",
				before: "true",
				after: "false",
			},
		);
	});

	it("restarts the timer on a second call", async () =>
	{
		await mount();
		await run(() =>
		{
			probe.flash();
		});
		await advance(1500);
		await run(() =>
		{
			probe.flash();
		});
		await advance(1999);
		const stillOn = state();
		await advance(1);
		expect(
			{
				stillOn,
				after: state(),
			},
		).toStrictEqual(
			{
				stillOn: "true",
				after: "false",
			},
		);
	});
});
